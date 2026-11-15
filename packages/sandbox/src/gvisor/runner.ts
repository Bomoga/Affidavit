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
  type FetchNetwork,
  type TmpfsMount,
} from './args.js';
import { validateMounts, type Mount } from './mounts.js';
import type { CaseNetwork } from './network.js';
import { parseTrace, type TraceObservations } from './trace.js';

const exec = promisify(execFile);

/** Output beyond this is dropped, so a chatty jail cannot exhaust the host's memory. */
const MAX_CAPTURE = 2 * 1024 * 1024;
/**
 * Largest trace a run may write. gVisor writes the trace to the host's disk while the run goes
 * (measured: about 13 MiB/s from one thread opening files in a loop), so the size is watched
 * live and the run is killed when it passes this. A run cut short this way cannot be observed
 * in full and is reported as tampered.
 */
export const DEFAULT_MAX_TRACE_BYTES = 64 * 1024 * 1024;
/** How often the live trace size and a pending kill are checked. */
const WATCH_INTERVAL_MS = 250;

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
  /** Join this case network (with these /etc/hosts names) instead of `--network none`. */
  network?: { net: CaseNetwork; hosts?: Readonly<Record<string, string>> };
  /** Largest file the jail may write; see `GvisorRunSpec.maxFileBytes`. */
  maxFileBytes?: number;
  /** See `GvisorRunSpec`: build steps and boot diagnostics use these, witnesses do not. */
  fetch?: FetchNetwork;
  env?: Readonly<Record<string, string>>;
  workdir?: string;
  tmpfs?: readonly TmpfsMount[];
  writableTmpMb?: number;
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

async function traceFiles(root: string, id: string): Promise<string[]> {
  try {
    return (await readdir(root)).filter((f) => f.startsWith(`${id}.`)).sort();
  } catch {
    return [];
  }
}

async function traceSize(root: string, files: readonly string[]): Promise<number> {
  let total = 0;
  for (const f of files)
    total += await stat(join(root, f)).then(
      (s) => s.size,
      () => 0,
    );
  return total;
}

/**
 * Reads and removes the trace files gVisor wrote for one container (`<id>.<command>.txt`, written
 * straight into the trace root so the docker group can delete them; see sandbox-runner.md).
 * Returns null, after deleting them, when they are over `maxBytes`.
 */
async function collectTrace(root: string, id: string, maxBytes: number): Promise<string | null> {
  const files = await traceFiles(root, id);
  if (files.length === 0) {
    throw new Error(
      `no syscall trace for ${id} in ${root}; is the ${AUDIT_RUNTIME} runtime configured on this host?`,
    );
  }
  try {
    if ((await traceSize(root, files)) > maxBytes) return null;
    const parts: string[] = [];
    for (const f of files) parts.push(await readFile(join(root, f), 'utf8'));
    return parts.join('\n');
  } finally {
    await Promise.all(files.map((f) => rm(join(root, f), { force: true })));
  }
}

/** Observations for a run whose trace passed its cap: it cannot be shown to be clean. */
const OVERFLOWED: TraceObservations = {
  egressAttempts: 0,
  deniedReads: 0,
  deniedWrites: 0,
  pidsLimitHit: false,
  syscalls: 0,
  tampered: true,
};

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
    network:
      input.network === undefined
        ? undefined
        : { name: input.network.net.name, hosts: input.network.hosts },
    maxFileBytes: input.maxFileBytes,
    fetch: input.fetch,
    env: input.env,
    workdir: input.workdir,
    tmpfs: input.tmpfs,
    writableTmpMb: input.writableTmpMb,
  });

  const started = Date.now();
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  child.stdin.on('error', () => undefined);
  child.stdin.end(input.stdin ?? '');

  const traceRoot = opts.traceRoot ?? DEFAULT_TRACE_ROOT;
  const maxTraceBytes = opts.maxTraceBytes ?? DEFAULT_MAX_TRACE_BYTES;
  let timedOut = false;
  let traceOverflow = false;
  let killing = false;
  let containerId: string | null = null;
  let busy = false;
  // One watcher for both limits. A kill is retried on every tick until the client exits: a kill
  // sent before Docker has created the container fails, and must not leave the run unbounded.
  const watcher = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      if (!timedOut && Date.now() - started >= input.timeoutMs) {
        timedOut = true;
        killing = true;
      }
      if (opts.trace !== false && !traceOverflow) {
        containerId ??= (await inspect(name))?.id ?? null;
        if (containerId !== null) {
          const size = await traceSize(traceRoot, await traceFiles(traceRoot, containerId));
          if (size > maxTraceBytes) {
            traceOverflow = true;
            killing = true;
          }
        }
      }
      if (killing) await exec('docker', ['kill', name]).catch(() => undefined);
    })().finally(() => {
      busy = false;
    });
  }, WATCH_INTERVAL_MS);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  } finally {
    clearInterval(watcher);
  }
  const durationMs = Date.now() - started;

  const state = await inspect(name);
  await exec('docker', ['rm', '--force', name]).catch(() => undefined);
  if (state === null) {
    throw new Error(`container ${name} was never created: ${stderr().slice(0, 2000)}`);
  }
  const text = opts.trace === false ? null : await collectTrace(traceRoot, state.id, maxTraceBytes);
  await verifyTeardown(runId);

  let trace: TraceObservations;
  if (opts.trace === false) trace = UNTRACED;
  else if (text === null || traceOverflow) trace = OVERFLOWED;
  else {
    trace = parseTrace(text, {
      sensitivePaths: opts.sensitivePaths ?? [],
      localNetworks: input.network === undefined ? [] : [input.network.net.subnet],
    });
    if (trace.syscalls === 0) throw new Error(`syscall trace for ${name} is empty`);
  }

  return {
    containerId: state.id,
    exitCode: timedOut || traceOverflow || state.oomKilled ? null : state.exitCode,
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
        'syscall trace was tampered with by the jailed process (a malformed or split syscall line, or over its size cap); the run cannot be judged',
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
