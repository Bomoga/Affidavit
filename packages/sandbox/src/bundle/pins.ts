import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { SHA256_HEX } from './integrity.js';
import type { DependencyBundleRef } from './open.js';

/** One app's pinned dependency bundle, set by a human after building and reviewing it. */
export interface DependencyBundlePin {
  app: string;
  commit: string;
  /** Null until a bundle has been built on a networked host and its digest reviewed. */
  bundleSha256: string | null;
  note: string;
}

export const PINS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'docker',
  'sandbox',
  'dependency-bundles',
  'pins.json',
);

/** Reads and validates the pin file. Throws on any malformed entry (fail closed). */
export function readDependencyBundlePins(file = PINS_FILE): DependencyBundlePin[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { pins?: unknown }).pins)) {
    throw new Error('pins.json must be an object with a pins array');
  }
  return (raw as { pins: unknown[] }).pins.map((p, i) => {
    const o = p as Record<string, unknown>;
    if (typeof o.app !== 'string' || !/^[a-z0-9-]+$/.test(o.app)) {
      throw new Error(`pins[${i}].app is malformed`);
    }
    if (typeof o.commit !== 'string' || !/^[0-9a-f]{40}$/.test(o.commit)) {
      throw new Error(`pins[${i}].commit is malformed`);
    }
    const sha = o.bundleSha256;
    if (sha !== null && (typeof sha !== 'string' || !SHA256_HEX.test(sha))) {
      throw new Error(`pins[${i}].bundleSha256 must be null or 64 hex characters`);
    }
    if (typeof o.note !== 'string') throw new Error(`pins[${i}].note is missing`);
    return { app: o.app, commit: o.commit, bundleSha256: sha, note: o.note };
  });
}

const HUMAN_STEP =
  'a human must run packages/sandbox/scripts/build-dependency-bundle.ts on a networked host, ' +
  'review the manifest (and bundle-exclusions.json), and set bundleSha256 in ' +
  'docker/sandbox/dependency-bundles/pins.json';

/**
 * A ref to a bundle file for `buildTarget` / `bootVariant`, checked against the pin before it is
 * returned: throws (fail closed) when the app has no pin, the pin is null, or the file's sha256
 * differs. The bundle's directory becomes the allowed root. `openDependencyBundle` checks the
 * digest again when the build reads it.
 */
export async function pinnedDependencyBundle(input: {
  app: string;
  commit: string;
  path: string;
  pinsFile?: string;
}): Promise<DependencyBundleRef> {
  const pinned = pinnedBundleSha256(input.app, input.commit, input.pinsFile);
  if (pinned === null) {
    throw new Error(
      `no pinned dependency bundle for ${input.app} at ${input.commit}: ${HUMAN_STEP}`,
    );
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(input.path), hash);
  const actual = hash.digest('hex');
  if (actual !== pinned) {
    throw new Error(
      `dependency bundle sha256 ${actual} does not match the pinned ${pinned} (${input.path}): ${HUMAN_STEP}`,
    );
  }
  return { path: input.path, sha256: pinned, allowedRoot: dirname(input.path) };
}

/** The pinned digest for an app at a commit, or null when none is pinned. */
export function pinnedBundleSha256(app: string, commit: string, file = PINS_FILE): string | null {
  const pin = readDependencyBundlePins(file).find((p) => p.app === app && p.commit === commit);
  return pin?.bundleSha256 ?? null;
}
