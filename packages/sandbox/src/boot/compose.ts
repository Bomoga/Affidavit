import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { shellWords } from './dockerfile.js';
import { scanYamlKeys } from './yaml-keys.js';

const exec = promisify(execFile);

/** A service from the compose file that the target needs: started from its image, never built. */
export interface ComposeSidecar {
  name: string;
  image: string;
  command?: string[];
  env: Record<string, string>;
}

export interface ComposeTarget {
  /** Dockerfile path relative to the tree root. */
  dockerfile: string;
  command?: string[];
  entrypoint?: string[];
  /** Literal values from the compose file. `${...}` values are never resolved. */
  env: Record<string, string>;
  /** Keys the compose file names without a value (taken from the host by Compose; never here). */
  passThrough: string[];
  sidecars: ComposeSidecar[];
}

export type ComposeRead = { ok: true; target: ComposeTarget } | { ok: false; reason: string };

/**
 * Keys that make Compose read files outside the compose file, possibly outside the tree (and
 * possibly put their contents into a service's environment). Refused at any depth.
 *
 * For `include` and `extends` the pre-scan (`precheckCompose`) is the only guard: Compose follows
 * them while normalizing, so by the time `findHostReadingKey` sees Compose's output the other
 * file has already been read and merged in, and the keys themselves are gone.
 */
export const READS_FILES = new Set([
  'include',
  'extends',
  'env_file',
  'label_file',
  'secrets',
  'configs',
  'ssh',
  'additional_contexts',
]);

const MAX_DEPTH = 64;

/** An empty value (`null`, `[]`, `{}`) names no file; Compose's own output can carry these. */
const isEmpty = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/** The first host-reading key anywhere in a parsed tree, or a reason the tree is refused. */
export function findHostReadingKey(tree: unknown): string | null {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): string | null => {
    if (typeof v !== 'object' || v === null) return null;
    if (depth > MAX_DEPTH) return 'compose file is nested too deeply';
    // An alias points at a node already walked; each node is checked once.
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const p = walk(x, depth + 1);
        if (p !== null) return p;
      }
      return null;
    }
    for (const [k, x] of Object.entries(v)) {
      if (READS_FILES.has(k.toLowerCase()) && !isEmpty(x)) {
        return `compose key "${k}" reads other files`;
      }
      const p = walk(x, depth + 1);
      if (p !== null) return p;
    }
    return null;
  };
  return walk(tree, 0);
}

/**
 * Reads every mapping key of the compose file, before Compose ever sees it, and refuses any key
 * that reads other files (unless its value is empty), wherever it is written: inside `x-`
 * extension blocks, in flow style (`{env_file: x}`), quoted (`"env_file"`) or in upper case. No
 * YAML library is used (lead decision 2026-11-20, PR #18): `scanYamlKeys` reads the small subset
 * compose files need and refuses everything else, including custom tags (Compose's `!reset`,
 * `!override`), anchors, aliases, merge keys, block scalars it cannot bound exactly, escaped
 * keys, duplicate keys and unbalanced input. A refused file makes the target `unsupported` (fail
 * closed).
 */
export function precheckCompose(text: string): string | null {
  const scan = scanYamlKeys(text);
  if (!scan.ok) return `compose file is outside the supported YAML subset: ${scan.reason}`;
  const hit = scan.keys.find((k) => READS_FILES.has(k.name.toLowerCase()) && !k.empty);
  return hit === undefined ? null : `compose key "${hit.name}" reads other files`;
}

/**
 * Fixed host paths of the Compose v2 binary, in the order the Docker CLI's system plugin
 * directories are searched. `AFFIDAVIT_COMPOSE_BIN` (an absolute path, set by the host's own
 * configuration) comes first. The binary is never looked up through `PATH`, `$HOME/.docker` or
 * `$DOCKER_CONFIG`, which a target could otherwise supply.
 */
export const COMPOSE_BIN_PATHS = [
  '/usr/libexec/docker/cli-plugins/docker-compose',
  '/usr/lib/docker/cli-plugins/docker-compose',
  '/usr/local/lib/docker/cli-plugins/docker-compose',
  '/usr/local/libexec/docker/cli-plugins/docker-compose',
];

/** The first Compose binary found at a fixed absolute path. Throws if there is none. */
export function composeBinary(
  exists: (path: string) => boolean = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string {
  const override = process.env.AFFIDAVIT_COMPOSE_BIN;
  const candidates = [
    ...(override !== undefined && isAbsolute(override) ? [override] : []),
    ...COMPOSE_BIN_PATHS,
  ];
  const found = candidates.find(exists);
  if (found === undefined) {
    throw new Error(`no docker compose binary at a fixed path (${candidates.join(', ')})`);
  }
  return found;
}

const inside = (child: string, parent: string): boolean => {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * The exact process `normalizeCompose` runs. Pure, for tests. `configDir` must be a fresh, empty,
 * private directory outside the tree: it is the process's working directory, `HOME` and
 * `DOCKER_CONFIG`, so no CLI plugin, `config.json`, context or proxy setting can come from the
 * tree. Nothing else from the host environment is passed, so no `COMPOSE_*` or `DOCKER_*`
 * variable leaks in either.
 */
export function composeConfigInvocation(
  treeDir: string,
  file: string,
  configDir: string,
  bin: string,
): { bin: string; args: string[]; cwd: string; env: Record<string, string> } {
  if (!isAbsolute(bin)) throw new Error(`compose binary must be an absolute path: ${bin}`);
  if (!isAbsolute(configDir)) throw new Error('config directory must be absolute');
  if (inside(configDir, treeDir) || inside(treeDir, configDir)) {
    throw new Error('the Docker config directory must be outside the tree');
  }
  if (file.startsWith('/') || file.split('/').includes('..')) {
    throw new Error(`compose file leaves the tree: ${file}`);
  }
  return {
    bin,
    // Standalone Compose v2: the same parser as `docker compose`, without the Docker CLI's plugin
    // lookup in front of it.
    args: [
      '--project-directory',
      treeDir,
      '-f',
      join(treeDir, file),
      'config',
      '--no-interpolate',
      '--format',
      'json',
    ],
    cwd: configDir,
    env: { PATH: '/usr/bin:/bin', HOME: configDir, DOCKER_CONFIG: configDir },
  };
}

/**
 * Normalizes a compose file to JSON with Compose's `config` command, which parses the YAML but
 * runs nothing. It runs on the host, so it is given nothing from the tree but the file to read:
 * see `composeConfigInvocation`. `--no-interpolate` leaves `${VAR}` unresolved. Call only on a
 * staged tree (no `.env`, no `.docker`, no symlinks).
 */
export async function normalizeCompose(
  treeDir: string,
  file: string,
  configDir: string,
): Promise<unknown> {
  const inv = composeConfigInvocation(treeDir, file, configDir, composeBinary());
  const { stdout } = await exec(inv.bin, inv.args, {
    cwd: inv.cwd,
    env: inv.env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

/** Runs `fn` with a fresh, empty, 0700 directory outside the tree, removed afterwards. */
export async function withEmptyDockerConfig<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'affidavit-docker-config-'));
  try {
    await chmod(dir, 0o700);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function command(v: unknown, what: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return shellWords(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  throw new Error(`bad ${what}`);
}

function environment(v: unknown): { env: Record<string, string>; passThrough: string[] } {
  const env: Record<string, string> = {};
  const passThrough: string[] = [];
  const entries: [string, unknown][] = Array.isArray(v)
    ? v.map((e) => {
        const s = String(e);
        const i = s.indexOf('=');
        return i === -1 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
      })
    : isObj(v)
      ? Object.entries(v)
      : [];
  for (const [k, val] of entries) {
    if (val === null || val === undefined) passThrough.push(k);
    else if (typeof val === 'string' && val.includes('${')) passThrough.push(k);
    else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      env[k] = String(val);
    } else throw new Error(`environment value of ${k} is not a scalar`);
  }
  return { env, passThrough };
}

/**
 * Picks the target service and its sidecars out of a normalized compose file. The target must be
 * built from the tree root; every other service must come from an image (they are started, never
 * built). Volumes, ports, networks and users are ignored: the jail decides those.
 *
 * `volumes`, `privileged`, `network_mode`, `devices` and the like pass the key precheck (they name
 * no other file); they are dropped only because this function never reads them. Reading any of
 * them here needs a host-path check first (pinned by a test in yaml-keys.test.ts).
 */
export function selectServices(normalized: unknown, service: string, treeDir: string): ComposeRead {
  try {
    if (!isObj(normalized) || !isObj(normalized.services)) {
      return { ok: false, reason: 'compose file has no services' };
    }
    const services = normalized.services;
    const main = services[service];
    if (!isObj(main)) return { ok: false, reason: `compose file has no service ${service}` };
    const build = isObj(main.build) ? main.build : null;
    if (build === null) return { ok: false, reason: `service ${service} is not built from source` };
    if (build.context !== treeDir) {
      return {
        ok: false,
        reason: `service ${service} is built from a context other than the tree root`,
      };
    }
    const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile';
    if (dockerfile.startsWith('/') || dockerfile.split('/').includes('..')) {
      return { ok: false, reason: `Dockerfile path leaves the tree: ${dockerfile}` };
    }
    if (isObj(build.args) && Object.keys(build.args).length > 0) {
      return { ok: false, reason: 'build args are not supported' };
    }

    const sidecars: ComposeSidecar[] = [];
    for (const [name, svc] of Object.entries(services)) {
      if (name === service) continue;
      if (!isObj(svc)) continue;
      if (svc.build !== undefined) {
        return { ok: false, reason: `service ${name} is also built from source` };
      }
      if (typeof svc.image !== 'string' || svc.image.includes('${')) {
        return { ok: false, reason: `service ${name} has no fixed image` };
      }
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
        return { ok: false, reason: `service name ${name} cannot be a host alias` };
      }
      const cmd = command(svc.command, `command of ${name}`);
      sidecars.push({
        name,
        image: svc.image,
        ...(cmd === undefined ? {} : { command: cmd }),
        env: environment(svc.environment).env,
      });
    }
    const { env, passThrough } = environment(main.environment);
    const cmd = command(main.command, `command of ${service}`);
    const entrypoint = command(main.entrypoint, `entrypoint of ${service}`);
    return {
      ok: true,
      target: {
        dockerfile,
        ...(cmd === undefined ? {} : { command: cmd }),
        ...(entrypoint === undefined ? {} : { entrypoint }),
        env,
        passThrough,
        sidecars,
      },
    };
  } catch (err) {
    return { ok: false, reason: `unreadable compose file: ${(err as Error).message}` };
  }
}
