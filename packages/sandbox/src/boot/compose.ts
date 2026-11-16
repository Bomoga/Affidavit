import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { shellWords } from './dockerfile.js';

const exec = promisify(execFile);

// js-yaml 4.3.2 ships no types. It is loaded through require with the one signature used here,
// so packages that compile this file (the Judge) need no ambient declaration.
const { CORE_SCHEMA, load } = createRequire(import.meta.url)('js-yaml') as {
  CORE_SCHEMA: unknown;
  load: (text: string, opts: { schema: unknown }) => unknown;
};

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
 * Parses the compose YAML into a tree, before Compose ever sees the file, and refuses any key
 * that reads other files, at any depth: inside `x-` extension blocks, behind anchors and aliases,
 * through merge keys (`<<: *base`, whose aliased map is walked), in flow style (`{env_file: x}`),
 * or quoted or escaped (`"env_file"` parses to `env_file`). The parser uses the YAML core
 * schema: custom tags (Compose's `!reset`, `!override`) and duplicate keys fail to parse, and an
 * unparseable file is refused (fail closed).
 */
export function precheckCompose(text: string): string | null {
  let tree: unknown;
  try {
    tree = load(text, { schema: CORE_SCHEMA });
  } catch (err) {
    return `compose file is not plain YAML: ${(err as Error).message.split('\n')[0] ?? ''}`;
  }
  return findHostReadingKey(tree);
}

/**
 * Normalizes a compose file to JSON with `docker compose config`, which parses the YAML but runs
 * nothing. `--no-interpolate` leaves `${VAR}` unresolved, and the clean environment means no
 * COMPOSE_* variable or host value leaks in. Call only on a staged tree that has no `.env`.
 */
export async function normalizeCompose(treeDir: string, file: string): Promise<unknown> {
  const { stdout } = await exec(
    'docker',
    [
      'compose',
      '--project-directory',
      treeDir,
      '-f',
      file,
      'config',
      '--no-interpolate',
      '--format',
      'json',
    ],
    {
      cwd: treeDir,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: treeDir },
    },
  );
  return JSON.parse(stdout) as unknown;
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
