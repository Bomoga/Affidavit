/**
 * The environment for every `docker` (and `tar`) child process Lane 2 host code starts: only what
 * the Docker CLI needs to find its daemon and config, never the parent's whole environment. The
 * worker holds an API key, database URLs and repository sources; a child that inherited them would
 * hand them to anything it runs or logs (CR-12 in docs/lanes/lane1/contract-requests.md).
 *
 * This is the one closed allowlist for Docker child processes. No entry holds a credential: they
 * are search paths, the daemon address and where the CLI keeps its config. The worker's own
 * `childEnv` (apps/worker, Lane 1) should import these lists; until it does, `docker-env.test.ts`
 * checks that its lists are covered by these.
 *
 * `egress-guard.test.ts` checks that every spawn in this package and in `packages/judge/src`
 * passes `env: dockerEnv(...)` with literal settings, or a literal record.
 */

/** What the Docker CLI reads, on any platform. */
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
 * Also passed on Windows: what a process needs to start at all (`SYSTEMROOT`, `TEMP`, `TMP`,
 * `PATHEXT`), where the Docker CLI keeps its config and contexts (`USERPROFILE\.docker`), where
 * credential helpers keep state (`APPDATA`, `LOCALAPPDATA`), and where it looks for CLI plugins
 * such as buildx (`PROGRAMDATA`, `PROGRAMFILES`).
 */
export const WINDOWS_DOCKER_ENV_VARS = [
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
] as const;

/** The variable names `dockerEnv` copies on `platform`. */
export function dockerEnvVars(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32' ? [...DOCKER_ENV_VARS, ...WINDOWS_DOCKER_ENV_VARS] : DOCKER_ENV_VARS;
}

function lookup(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return source[name];
  // Windows names are case-insensitive (`Path`, `SystemRoot`), and a copied env object is not.
  const key = Object.keys(source).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : source[key];
}

/**
 * The `dockerEnvVars(platform)` set in `source` (default: this process), plus `extra`. Empty
 * values are left out. `extra` is for fixed settings such as `DOCKER_BUILDKIT=1`, never for a
 * secret (the egress guard accepts only string literals there).
 */
export function dockerEnv(
  extra: Readonly<Record<string, string>> = {},
  source: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of dockerEnvVars(platform)) {
    const v = lookup(source, name, platform);
    if (v !== undefined && v !== '') out[name] = v;
  }
  return { ...out, ...extra };
}
