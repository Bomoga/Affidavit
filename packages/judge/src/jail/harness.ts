import { PROBE_IMAGE } from '@affidavit/sandbox';
import { sha256Hex } from '../canonical.js';
import { RESULT_ARTIFACT_VERSION } from '../artifact.js';

/**
 * The fixed witness runner (L2-03): a pinned Node image plus this harness, which is copied
 * read-only into every attempt as /witness/runner.mjs. A bundle (L2-08) records the image digest
 * and HARNESS_SHA256, which together pin what ran the witness.
 *
 * L2-05 replaces the witness format below with a TypeScript test run by Vitest; the jail, the
 * mounts and the artifact stay as they are.
 */
export const RUNNER_IMAGE = PROBE_IMAGE;

/** Paths inside the jail. /witness is a read-only mount; /out/result.json a single-file mount. */
export const JAIL_PATHS = {
  harness: '/witness/runner.mjs',
  witness: '/witness/witness.mjs',
  input: '/witness/input.json',
  result: '/out/result.json',
} as const;

/** What the harness reads from /witness/input.json. */
export interface HarnessInput {
  schemaVersion: 1;
  params: { name: string; values: unknown[] }[];
  /** Base URL of the target on the case network, or null when the run has no target. */
  target: { url: string } | null;
}

/**
 * Witness format for L2-03: an ES module whose default export is `async (params, ctx)` where
 * `params` maps each parameter name to one value and `ctx.target.url` is the target's base URL.
 * A parameter passes when the function resolves to anything but `false`, and fails when it
 * throws or returns `false`.
 *
 * The harness walks the cartesian product of the ParamSpace with the last parameter varying
 * fastest (the order artifact.ts defines) and writes one artifact at the end. The witness runs in
 * the same process, so it could write the artifact itself; that gives it nothing, because the
 * witness already decides its own pass or fail, and the Judge parses the artifact as untrusted
 * either way. A module with no default function writes no artifact, which fails `completes`.
 */
export const HARNESS_SOURCE = `// Affidavit witness harness, schemaVersion ${RESULT_ARTIFACT_VERSION}.
import { readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync('${JAIL_PATHS.input}', 'utf8'));
const mod = await import('${JAIL_PATHS.witness}');
const witness = mod.default;
if (typeof witness !== 'function') {
  console.error('affidavit: the witness module has no default export function');
  process.exit(3);
}
const space = input.params;
const size = space.reduce((n, p) => n * p.values.length, 1);
const results = [];
for (let i = 0; i < size; i++) {
  const params = {};
  let rest = i;
  for (let k = space.length - 1; k >= 0; k--) {
    const p = space[k];
    params[p.name] = p.values[rest % p.values.length];
    rest = Math.floor(rest / p.values.length);
  }
  let passed = false;
  try {
    passed = (await witness(params, { target: input.target })) !== false;
  } catch (err) {
    console.error('affidavit: parameter ' + i + ' failed: ' + (err && err.message ? err.message : String(err)));
  }
  results.push({ paramIndex: i, passed });
}
writeFileSync('${JAIL_PATHS.result}', JSON.stringify({ schemaVersion: ${RESULT_ARTIFACT_VERSION}, results }));
`;

export const HARNESS_SHA256 = sha256Hex(HARNESS_SOURCE);
