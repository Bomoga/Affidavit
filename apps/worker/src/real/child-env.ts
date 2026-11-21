/**
 * What the worker's child processes may see of its environment. Wiring only.
 *
 * - `childEnv` is the explicit, minimal environment for a child process the worker spawns itself
 *   (the `docker info` startup probe): what the Docker CLI needs to find its daemon and config,
 *   nothing else. No credential, no database URL, no repository source.
 * - `sealSecrets` covers the child processes that other lanes' components spawn with the
 *   inherited environment (the tool runners, the Judge's jail): at the entry points it moves the
 *   secret variables out of `process.env` into a private snapshot that only the wiring reads, so
 *   no child can inherit them.
 */
import type { Env } from '../config.js';

/** What the Docker CLI needs, on any platform. */
const DOCKER_VARS = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR',
] as const;

/** What a Windows process needs to start at all. */
const WINDOWS_VARS = ['SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT'] as const;

/**
 * Variables that hold a credential or a credential-bearing URL. Never passed to a child process.
 * The database URLs and the repository sources are already parsed into the config by then.
 */
export const SECRET_VARS = [
  'ANTHROPIC_API_KEY',
  'AFFIDAVIT_APP_DATABASE_URL',
  'AFFIDAVIT_WORKER_DATABASE_URL',
  'AFFIDAVIT_REPO_SOURCES',
] as const;

function lookup(source: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return source[name];
  // Windows names are case-insensitive (`Path`, `SystemRoot`).
  const key = Object.keys(source).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : source[key];
}

/** The allowlisted variables only, copied from `source`. */
export function childEnv(
  source: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const names: readonly string[] =
    platform === 'win32' ? [...DOCKER_VARS, ...WINDOWS_VARS] : DOCKER_VARS;
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = lookup(source, name, platform);
    if (v !== undefined && v !== '') out[name] = v;
  }
  return out;
}

/**
 * Moves every `SECRET_VARS` entry out of `target` (default `process.env`) and returns a frozen
 * snapshot of the environment as it was, for the wiring to read (the model port reads the API key
 * from it on every call). Call once, right after `loadConfig`, before anything is built.
 */
export function sealSecrets(target: NodeJS.ProcessEnv = process.env): Env {
  const snapshot: Env = Object.freeze({ ...target });
  for (const name of SECRET_VARS) {
    for (const k of Object.keys(target)) if (k.toUpperCase() === name) delete target[k];
  }
  return snapshot;
}
