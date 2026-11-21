import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The fixed witness runner (L2-05): an image built from docker/sandbox/witness-runner with a
 * pinned Node base, Vitest from its package-lock.json, and the runner (`run.mjs`) plus the API
 * witnesses import (`@affidavit/witness`). The Judge runs it by image ID, which is a content hash,
 * and a bundle (L2-08) records that ID.
 *
 * A witness is a TypeScript test file:
 *
 *   import { expect } from 'vitest';
 *   import { witness } from '@affidavit/witness';
 *   witness<{ payload: string }>(async ({ payload }, { target }) => {
 *     const res = await fetch(`${target!.url}/item?id=${encodeURIComponent(payload)}`);
 *     expect(res.status).toBe(500);
 *   });
 *
 * `witness()` turns the family into one Vitest test per parameter combination, last parameter
 * varying fastest (the order artifact.ts defines). A parameter passes when its test passes. Types
 * are stripped, not checked. The runner writes the result artifact only when every parameter was
 * reported exactly once.
 */
export const RUNNER_CONTEXT = join(
  import.meta.dirname,
  '../../../../docker/sandbox/witness-runner',
);

/** Paths inside the jail. The witness directory is a read-only mount; the result a single file. */
export const JAIL_PATHS = {
  runner: '/runner/run.mjs',
  witnessDir: '/runner/witness',
  witnessFile: 'witness.test.ts',
  inputFile: 'input.json',
  result: '/out/result.json',
} as const;

/** What the runner reads from /runner/witness/input.json. */
export interface HarnessInput {
  schemaVersion: 1;
  params: { name: string; values: unknown[] }[];
  /** Base URL of the target on the case network, or null when the run has no target. */
  target: { url: string } | null;
  /** Vitest's per-parameter timeout. The jail's hard timeout still bounds the whole run. */
  testTimeoutMs: number;
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
export const RUNNER_TAG = 'affidavit/witness-runner:local';

/**
 * Same files, same image ID: without these, every build of an unchanged context got a new ID
 * (checked 2026-11-14), from the build time in the image config and BuildKit's provenance
 * attestation. The tag only keeps the image from being pruned as dangling; the Judge runs it by ID.
 */
export const RUNNER_BUILD_ARGS = [
  'build',
  '--quiet',
  '--provenance=false',
  '--sbom=false',
  '--build-arg',
  'SOURCE_DATE_EPOCH=0',
  '--tag',
  RUNNER_TAG,
] as const;

/**
 * Builds the runner image and returns its image ID, which is stable for an unchanged context on
 * the same host. Docker's build cache makes a rebuild with no change cheap. Runs on the host, with network for `npm ci`; the image then runs with none.
 */
export async function buildRunnerImage(context: string = RUNNER_CONTEXT): Promise<string> {
  const { stdout } = await exec('docker', [...RUNNER_BUILD_ARGS, context], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const id = stdout.trim().split('\n').pop() ?? '';
  if (!IMAGE_ID.test(id)) throw new Error(`docker build did not return an image ID: ${stdout}`);
  return id;
}

/**
 * True when Docker has a local image with exactly this ID (`docker image inspect`, no pull, no
 * network). Used by the real Judge's startup check for the runner and patch-apply images.
 */
export async function localImagePresent(imageId: string): Promise<boolean> {
  if (!IMAGE_ID.test(imageId)) return false;
  try {
    const { stdout } = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', imageId], {
      timeout: 20_000,
    });
    return stdout.trim() === imageId;
  } catch {
    return false;
  }
}
