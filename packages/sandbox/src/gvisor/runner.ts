import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { PROBE_IMAGE } from '../containment/probes.js';
import type { JailRunReport, JailRunRequest, JailRunner } from '../containment/types.js';
import {
  AUDIT_RUNTIME,
  DEFAULT_LIMITS,
  DEFAULT_TRACE_ROOT,
  PLAIN_RUNTIME,
  RUN_LABEL,
  buildGvisorRunArgs,
  type Limits,
} from './args.js';
import { validateMounts, type Mount } from './mounts.js';
import { parseTrace, type TraceObservations } from './trace.js';

const exec = promisify(execFile);

/** Output beyond this is dropped, so a chatty jail cannot exhaust the host's memory. */
const MAX_CAPTURE = 2 * 1024 * 1024;
/** A trace larger than this is refused rather than half-read. */
const DEFAULT_MAX_TRACE_BYTES = 256 * 1024 * 1024;

export interface GvisorOptions {
  /**
   * Record a syscall trace (the audit runtime). Default true. Without it the run is contained the
   * same way but observations are all zero, so only use it where nothing is judged.
   */
  trace?: boolean;
  traceRoot?: string;
  limits?: Readonly<Limits>;
  /** Host paths whose access counts as a denied read or write even when it fails with ENOENT. */
  sensitivePaths?: readonly string[];
  maxTraceBytes?: number;
}

export interface JailedRun {
  containerId: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  trace: TraceObservations;
}

export interface JailedRunInput {
  image: string;
  command: readonly string[];
  mounts: readonly Mount[];
  stdin?: string;
  timeoutMs: number;
}

function capture(stream: NodeJS.ReadableStream): () => string {
  let out = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (out.length < MAX_CAPTURE) out += chunk.slice(0, MAX_CAPTURE - out.length);
  });
  return () => out;
}

async function inspect(
  name: string,
): Promise<{ id: string; oomKilled: boolean; exitCode: number } | null> {
  try {
    const { stdout } = await exec('docker', [
      'inspect',
      '--format',
      '{{.Id}} {{.State.OOMKilled}} {{.State.ExitCode}}',
      name,
    ]);
    const [id, oom, code] = stdout.trim().split(' ');
    if (id === undefined || !/^[0-9a-f]{64}$/.test(id)) return null;
    return { id, oomKilled: oom === 'true', exitCode: Number(code) };
  } catch {
    return null;
  }
}

/**
 * Reads and removes the trace files gVisor wrote for one container (`<id>.<command>.txt`, written
 * straight into the trace root so the docker group can delete them; see sandbox-runner.md).
 */
async function collectTrace(root: string, id: string, maxBytes: number): Promise<string> {
  let files: string[];
  try {
    files = (await readdir(root)).filter((f) => f.startsWith(`${id}.`)).sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new Error(
      `no syscall trace for ${id} in ${root}; is the ${AUDIT_RUNTIME} runtime configured on this host?`,
    );
  }
  try {
    let total = 0;
    const parts: string[] = [];
    for (const f of files) {
      const path = join(root, f);
      total += (await stat(path)).size;
      if (total > maxBytes) throw new Error(`syscall trace for ${id} is over ${maxBytes} bytes`);
      parts.push(await readFile(path, 'utf8'));
    }
    return parts.join('\n');
  } finally {
    await Promise.all(files.map((f) => rm(join(root, f), { force: true })));
  }
}

const UNTRACED: TraceObservations = {
  egressAttempts: 0,
  deniedReads: 0,
  deniedWrites: 0,
  pidsLimitHit: false,
  syscalls: 0,
  tampered: false,
};

/** Fails unless every container labelled with this run id is gone. */
export async function verifyTeardown(runId: string): Promise<void> {
  const { stdout } = await exec('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${RUN_LABEL}=${runId}`,
  ]);
  if (stdout.trim() !== '') throw new Error(`containers left behind for run ${runId}: ${stdout}`);
}

/**
 * Runs one command in a fresh gVisor container, then tears it down and reads its syscall trace.
 * Throws on infrastructure failure (no Docker, no runtime, no trace, leftovers): a run the
 * sandbox could not observe is never reported as a clean one.
 */
export async function runJailed(
  input: JailedRunInput,
  opts: GvisorOptions = {},
): Promise<JailedRun> {
  const runId = randomBytes(8).toString('hex');
  const name = `affidavit-${runId}`;
  const args = buildGvisorRunArgs({
    name,
    runId,
    image: input.image,
    command: input.command,
    mounts: input.mounts,
    limits: opts.limits ?? DEFAULT_LIMITS,
    stdin: input.stdin !== undefined,
    runtime: opts.trace === false ? PLAIN_RUNTIME : AUDIT_RUNTIME,
  });

  const started = Date.now();
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  child.stdin.on('error', () => undefined);
  child.stdin.end(input.stdin ?? '');

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void exec('docker', ['kill', name]).catch(() => undefined);
  }, input.timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - started;

  const state = await inspect(name);
  await exec('docker', ['rm', '--force', name]).catch(() => undefined);
  if (state === null) {
    throw new Error(`container ${name} was never created: ${stderr().slice(0, 2000)}`);
  }
  const text =
    opts.trace === false
      ? null
      : await collectTrace(
          opts.traceRoot ?? DEFAULT_TRACE_ROOT,
          state.id,
          opts.maxTraceBytes ?? DEFAULT_MAX_TRACE_BYTES,
        );
  await verifyTeardown(runId);

  const trace =
    text === null ? UNTRACED : parseTrace(text, { sensitivePaths: opts.sensitivePaths ?? [] });
  if (text !== null && trace.syscalls === 0) throw new Error(`syscall trace for ${name} is empty`);

  return {
    containerId: state.id,
    exitCode: timedOut || state.oomKilled ? null : state.exitCode,
    durationMs,
    stdout: stdout(),
    stderr: stderr(),
    timedOut,
    oomKilled: state.oomKilled,
    trace,
  };
}

/** The L2-02 runner for the containment suite: gVisor with the syscall trace. */
export class GvisorRunner implements JailRunner {
  readonly name = `gvisor (${AUDIT_RUNTIME})`;
  constructor(private readonly opts: GvisorOptions = {}) {}

  async run(req: JailRunRequest): Promise<JailRunReport> {
    const r = await runJailed(
      {
        image: PROBE_IMAGE,
        command: ['node', '--input-type=module', '-', JSON.stringify(req.args)],
        mounts: [],
        stdin: req.script,
        timeoutMs: req.timeoutMs,
      },
      { ...this.opts, trace: true },
    );
    if (r.trace.tampered) {
      throw new Error(
        'syscall trace was tampered with by the jailed process (malformed or split syscall line); the run cannot be judged',
      );
    }
    return {
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      observations: {
        egressAttempts: r.trace.egressAttempts,
        deniedReads: r.trace.deniedReads,
        deniedWrites: r.trace.deniedWrites,
        pidsLimitHit: r.trace.pidsLimitHit,
        oomKilled: r.oomKilled,
        timedOut: r.timedOut,
      },
    };
  }
}

export interface GvisorToolRunnerOptions extends GvisorOptions {
  /** Directory the tools write their output into; returned as `outputPath`. */
  outputDir: string;
  /** Host directories mounts may come from (case workspaces). Nothing else can be mounted. */
  allowedRoots: readonly string[];
  /** When set, only these exact image references may run. */
  imageAllowlist?: readonly string[];
  timeoutMs?: number;
}

/** Exit codes reported when the sandbox, not the tool, ended the run. */
export const EXIT_TIMED_OUT = 124;
export const EXIT_OOM = 137;

/**
 * `ToolRunnerPort` for Lane 1 (Semgrep, OSV, gitleaks): the same jail and flags as witnesses, on
 * gVisor without the trace. Tools are not judged, and tracing every file a scanner opens in a
 * large repo would be slow and could exceed the trace cap, letting a repo block its own scan.
 */
export class GvisorToolRunner implements ToolRunnerPort {
  constructor(private readonly opts: GvisorToolRunnerOptions) {}

  async run(
    image: string,
    args: readonly string[],
    mounts: readonly Mount[],
  ): Promise<{ exitCode: number; outputPath: string }> {
    const allow = this.opts.imageAllowlist;
    if (allow !== undefined && !allow.includes(image)) {
      throw new Error(`image is not on the allowlist: ${image}`);
    }
    const r = await runJailed(
      {
        image,
        command: args,
        mounts: validateMounts(mounts, this.opts.allowedRoots),
        timeoutMs: this.opts.timeoutMs ?? 10 * 60_000,
      },
      { ...this.opts, trace: false },
    );
    const exitCode = r.timedOut ? EXIT_TIMED_OUT : r.oomKilled ? EXIT_OOM : (r.exitCode ?? 1);
    return { exitCode, outputPath: this.opts.outputDir };
  }
}
