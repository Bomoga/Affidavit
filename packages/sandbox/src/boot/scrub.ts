import { tmpdir } from 'node:os';
import { COMPOSE_BIN_PATHS } from './compose.js';

/**
 * Replaces host paths in a reason string with placeholders (`<tree>`, `<build>`, `<src>`, ...),
 * so outcome reasons, which end up in evidence and the courtroom UI, never carry the host's
 * directory layout. Longer paths are replaced first, so `<build>/tree` becomes `<tree>`, not
 * `<build>/tree`. `tmpdir()` is always included as `<tmp>`.
 */
export function scrubPaths(
  text: string,
  paths: readonly (readonly [placeholder: string, path: string | undefined])[],
): string {
  const pairs = [...paths, ['<tmp>', tmpdir()] as const]
    .filter((e): e is readonly [string, string] => typeof e[1] === 'string' && e[1].length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [placeholder, path] of pairs) out = out.split(path).join(placeholder);
  return out;
}

/** Placeholders for the Compose binary, wherever it was found. */
export const composePathPairs = (): [string, string | undefined][] => [
  ...COMPOSE_BIN_PATHS.map((p): [string, string] => ['<compose>', p]),
  ['<compose>', process.env.AFFIDAVIT_COMPOSE_BIN],
];

/**
 * The part of a failed `execFile` worth reporting: its stderr when there is one, never the
 * `Command failed: <bin> <args>` line, which repeats every host path in the arguments.
 */
export function execErrorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; code?: unknown };
  if (typeof e.stderr === 'string' && e.stderr.trim() !== '') return e.stderr.trim();
  const message = typeof e.message === 'string' ? e.message : String(err);
  // No stderr: keep only what follows the command line (a timeout, a signal, ENOENT).
  const lines = message.split('\n').filter((l) => !l.startsWith('Command failed:'));
  const rest = lines.join('\n').trim();
  return rest !== ''
    ? rest
    : `command failed${typeof e.code === 'string' || typeof e.code === 'number' ? ` (${e.code})` : ''}`;
}
