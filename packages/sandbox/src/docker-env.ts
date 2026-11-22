/**
 * The environment for every `docker` (and `tar`) child process Lane 2 host code starts: only what
 * the Docker CLI needs to find its daemon and config, never the parent's whole environment. The
 * worker holds an API key, database URLs and repository sources; a child that inherited them would
 * hand them to anything it runs or logs (CR-12 in docs/lanes/lane1/contract-requests.md).
 *
 * `egress-guard.test.ts` checks that every spawn in this package and in `packages/judge/src`
 * passes an explicit `env` that does not mention `process.env`.
 */

/** What the Docker CLI reads, on Linux and macOS. */
export const DOCKER_ENV_VARS = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR',
] as const;

/**
 * The `DOCKER_ENV_VARS` set in `source` (default: this process), plus `extra`. Empty values are
 * left out. `extra` is for fixed settings such as `DOCKER_BUILDKIT=1`, never for a secret.
 */
export function dockerEnv(
  extra: Readonly<Record<string, string>> = {},
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DOCKER_ENV_VARS) {
    const v = source[name];
    if (v !== undefined && v !== '') out[name] = v;
  }
  return { ...out, ...extra };
}
