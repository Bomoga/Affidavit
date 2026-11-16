import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runJailed,
  validateMounts,
  type CaseNetwork,
  type GvisorOptions,
  type JailedRun,
} from '@affidavit/sandbox';
import { JAIL_PATHS, type HarnessInput } from './harness.js';

/** Largest file the jail may write, the result file included (RLIMIT_FSIZE). */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export interface WitnessJailOptions extends GvisorOptions {
  /** Host directory for per-attempt directories. Only the attempt's own directory is mounted. */
  workRoot: string;
  /** The runner image by ID (`buildRunnerImage`). */
  runnerImage: string;
  maxFileBytes?: number;
}

export interface WitnessJailRun {
  /** Witness source. Untrusted: written to a file and only ever executed inside the jail. */
  source: string;
  input: HarnessInput;
  timeoutMs: number;
  network?: { net: CaseNetwork; hosts: Readonly<Record<string, string>> };
}

/**
 * Reads the result artifact the jail left, as untrusted bytes, after the jail is gone. Refuses
 * anything but a regular file (no symlink is followed, a FIFO cannot block the read) and reads at
 * most `maxBytes + 1` bytes, so an oversized artifact is still seen as oversized by the Judge
 * without the whole file being read. Returns null when there is no usable artifact.
 */
export async function readArtifact(path: string, maxBytes: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size === 0) return null;
    const buf = Buffer.alloc(Math.min(st.size, maxBytes + 1));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Runs one witness attempt in the jail and returns what the jail observed plus the raw artifact.
 *
 * The attempt directory holds the witness test file and its input, mounted read-only at
 * /runner/witness (inside the image's /runner, so the witness resolves `vitest` from the image),
 * and one empty result file mounted alone at /out/result.json. A single-file mount
 * means the jail can write that file and nothing else on the host: no siblings, no directories,
 * no rename or unlink (checked on gVisor), and RLIMIT_FSIZE caps its size. The artifact is read
 * only after the container is removed and teardown is verified, so nothing can write to it while
 * or after the Judge reads it. The attempt directory is deleted afterwards.
 */
export async function runWitnessJail(
  run: WitnessJailRun,
  opts: WitnessJailOptions,
  maxArtifactBytes: number,
): Promise<{ jailed: JailedRun; artifact: string | null }> {
  const dir = await mkdtemp(join(opts.workRoot, 'attempt-'));
  try {
    const witnessDir = join(dir, 'witness');
    const resultFile = join(dir, 'result.json');
    await mkdir(witnessDir, { mode: 0o755 });
    await writeFile(join(witnessDir, JAIL_PATHS.witnessFile), run.source, { mode: 0o644 });
    await writeFile(join(witnessDir, JAIL_PATHS.inputFile), JSON.stringify(run.input), {
      mode: 0o644,
    });
    await writeFile(resultFile, '');
    await chmod(resultFile, 0o666); // the jail writes it as nobody

    const mounts = validateMounts(
      [
        { hostPath: witnessDir, containerPath: JAIL_PATHS.witnessDir, readOnly: true },
        { hostPath: resultFile, containerPath: JAIL_PATHS.result, readOnly: false },
      ],
      [dir],
    );
    const jailed = await runJailed(
      {
        image: opts.runnerImage,
        command: ['node', JAIL_PATHS.runner],
        mounts,
        timeoutMs: run.timeoutMs,
        network: run.network,
        maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      },
      { ...opts, trace: true },
    );
    return { jailed, artifact: await readArtifact(resultFile, maxArtifactBytes) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
