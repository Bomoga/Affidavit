import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { buildDockerRunArgs } from '@affidavit/testing';
import { PROBE_IMAGE } from './probes.js';
import type { JailRunner, JailRunReport, JailRunRequest } from './types.js';

const exec = promisify(execFile);

/** Output beyond this is dropped, so a probe cannot exhaust the harness's memory. */
const MAX_CAPTURE = 2 * 1024 * 1024;

/**
 * The Phase 1 tool runner's flags (`buildDockerRunArgs` from @affidavit/testing), so the suite
 * measures the runner Lane 1 actually uses. Three changes, none of which loosens a flag:
 * `--rm` becomes `--name` so the harness can read OOM state before removing the container, `-i`
 * feeds the probe on stdin, and `/scratch` is a tmpfs, so no host path is mounted at all. Host bind
 * mounts are also refused by SELinux without a relabel option (see containment.md).
 */
export function buildProbeDockerArgs(name: string, argsJson: string): string[] {
  const args = buildDockerRunArgs(PROBE_IMAGE, ['node', '--input-type=module', '-', argsJson], []);
  const rm = args.indexOf('--rm');
  if (rm < 0) throw new Error('baseline docker args changed: --rm not found');
  args.splice(rm, 1, '--name', name, '-i');
  const image = args.indexOf(PROBE_IMAGE);
  args.splice(image, 0, '--tmpfs', '/scratch:rw,size=64m,mode=1777');
  return args;
}

function capture(stream: NodeJS.ReadableStream): () => string {
  let out = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (out.length < MAX_CAPTURE) out += chunk.slice(0, MAX_CAPTURE - out.length);
  });
  return () => out;
}

async function readState(name: string): Promise<{ oomKilled: boolean; exitCode: number } | null> {
  try {
    const { stdout } = await exec('docker', [
      'inspect',
      '--format',
      '{{.State.OOMKilled}} {{.State.ExitCode}}',
      name,
    ]);
    const [oom, code] = stdout.trim().split(' ');
    return { oomKilled: oom === 'true', exitCode: Number(code) };
  } catch {
    return null;
  }
}

/** Plain Docker with the Phase 1 flags. Expected to fail parts of the suite; that is the point. */
export class PlainDockerRunner implements JailRunner {
  readonly name = 'plain-docker (Phase 1 flags, runc)';

  async run(req: JailRunRequest): Promise<JailRunReport> {
    const name = `affidavit-probe-${randomBytes(6).toString('hex')}`;
    const started = Date.now();
    const child = spawn('docker', buildProbeDockerArgs(name, JSON.stringify(req.args)), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    child.stdin.end(req.script);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void exec('docker', ['kill', name]).catch(() => undefined);
    }, req.timeoutMs);

    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    clearTimeout(timer);
    const durationMs = Date.now() - started;

    const state = await readState(name);
    await exec('docker', ['rm', '--force', name]).catch(() => undefined);

    return {
      exitCode: timedOut || state === null ? null : state.exitCode,
      durationMs,
      stdout: stdout(),
      stderr: stderr(),
      // Plain Docker can only observe OOM kills and our own timeout. Everything else is unrecorded.
      observations: { oomKilled: state?.oomKilled === true, timedOut },
    };
  }
}
