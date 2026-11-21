import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A dev package left out of a bundle on purpose, after human review: the target's test suite does
 * not need it, and it cannot be bundled (it needs a lifecycle script, or it comes from git). The
 * list is security relevant: it is part of the dev section, so it is under the section digest
 * and the bundle sha256, and every build that mounts the dev section reports it.
 */
export interface ExcludedDevPackage {
  name: string;
  /** Exact version as the lockfile pins it. */
  version: string;
  reason: string;
}

export const EXCLUSIONS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bundle-exclusions.json',
);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateExclusions(list: unknown, where: string): ExcludedDevPackage[] {
  if (!Array.isArray(list)) throw new Error(`${where} must be an array`);
  const seen = new Set<string>();
  return list.map((e, i) => {
    if (!isObj(e)) throw new Error(`${where}[${i}] is not an object`);
    const { name, version, reason } = e;
    if (typeof name !== 'string' || name.length === 0 || name.length > 214) {
      throw new Error(`${where}[${i}].name is malformed`);
    }
    if (typeof version !== 'string' || version.length === 0 || version.length > 256) {
      throw new Error(`${where}[${i}].version is malformed`);
    }
    if (typeof reason !== 'string' || reason.trim().length < 10) {
      throw new Error(`${where}[${i}] (${name}) needs a reason of at least 10 characters`);
    }
    const key = `${name}@${version}`;
    if (seen.has(key)) throw new Error(`${where} lists ${key} twice`);
    seen.add(key);
    return { name, version, reason };
  });
}

/**
 * The reviewed exclusion list for an app at a commit (`packages/sandbox/bundle-exclusions.json`).
 * Empty when the app has none. Throws on a malformed file or a commit that does not match.
 */
export function readBundleExclusions(
  app: string,
  commit: string,
  file = EXCLUSIONS_FILE,
): ExcludedDevPackage[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!isObj(raw) || !Array.isArray(raw.apps)) {
    throw new Error('bundle-exclusions.json must be an object with an apps array');
  }
  const entry = (raw.apps as unknown[]).find((a) => isObj(a) && a.app === app);
  if (entry === undefined) return [];
  const e = entry as Obj;
  if (e.commit !== commit) {
    throw new Error(
      `bundle-exclusions.json lists ${app} at commit ${String(e.commit)}, not ${commit}; review it again`,
    );
  }
  return validateExclusions(e.excludedDev, `bundle-exclusions.json ${app}.excludedDev`);
}

const nameFromPath = (path: string): string => {
  const i = path.lastIndexOf('node_modules/');
  return i === -1 ? path : path.slice(i + 'node_modules/'.length);
};

const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

export type PruneRead =
  | { ok: true; lockText: string; pkgText: string; removed: string[] }
  | { ok: false; reason: string };

/**
 * Removes reviewed dev exclusions from a package-lock.json (v2 or v3) and package.json, the way
 * the suite build needs them: each excluded entry (exact name and version, dev only) and its
 * subtree goes, then every entry no longer reachable from the root through Node's resolution
 * (what npm would call extraneous), and the root `devDependencies` keys. The v1 `dependencies`
 * tree a v2 lockfile carries is pruned to match (npm 6 reads only that). Refused: an exclusion that
 * matches nothing (a stale list), one that matches a non-dev entry, and a lockfile without
 * `packages`.
 */
export function pruneExcludedDev(
  lockText: string,
  pkgText: string,
  excluded: readonly ExcludedDevPackage[],
): PruneRead {
  let lock: unknown;
  let pkg: unknown;
  try {
    lock = JSON.parse(lockText);
    pkg = JSON.parse(pkgText);
  } catch {
    return { ok: false, reason: 'package.json or package-lock.json is not JSON' };
  }
  if (!isObj(lock) || !isObj(pkg)) {
    return { ok: false, reason: 'package.json or package-lock.json is not an object' };
  }
  if (excluded.length === 0) return { ok: true, lockText, pkgText, removed: [] };
  if (!isObj(lock.packages)) {
    return { ok: false, reason: 'dev exclusions need a v2 or v3 lockfile (with packages)' };
  }
  const packages = lock.packages;
  // The lockfile as written, for resolving what each kept package needs.
  const original: Obj = { ...packages };
  const removed = new Set<string>();
  const excludedPaths = new Map<string, ExcludedDevPackage>();
  const drop = (path: string, ex: ExcludedDevPackage): void => {
    for (const p of Object.keys(packages)) {
      if (p === path || p.startsWith(`${path}/`)) {
        removed.add(p);
        excludedPaths.set(p, ex);
        delete packages[p];
      }
    }
  };

  for (const ex of excluded) {
    const hits = Object.entries(packages).filter(
      ([p, e]) =>
        p !== '' &&
        isObj(e) &&
        (typeof e.name === 'string' ? e.name : nameFromPath(p)) === ex.name &&
        e.version === ex.version,
    );
    if (hits.length === 0) {
      return {
        ok: false,
        reason: `dev exclusion ${ex.name}@${ex.version} matches nothing in the lockfile`,
      };
    }
    const notDev = hits.find(([, e]) => (e as Obj).dev !== true);
    if (notDev !== undefined) {
      return {
        ok: false,
        reason: `dev exclusion ${ex.name}@${ex.version} is not a dev-only package (${notDev[0]})`,
      };
    }
    for (const [p] of hits) drop(p, ex);
    for (const holder of [packages[''], pkg]) {
      if (isObj(holder) && isObj(holder.devDependencies)) delete holder.devDependencies[ex.name];
    }
  }

  // Keep only what the root still reaches (Node resolution: nearest node_modules upwards).
  const resolve = (from: string, name: string, map: Obj = packages): string | null => {
    let base = from;
    for (;;) {
      const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      if (candidate in map) return candidate;
      if (base === '') return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i === -1 ? '' : base.slice(0, i);
    }
  };
  const reached = new Set<string>(['']);
  const queue = [''];
  while (queue.length > 0) {
    const from = queue.shift() as string;
    const e = packages[from];
    if (!isObj(e)) continue;
    const fields = from === '' ? [...DEP_FIELDS, 'devDependencies'] : DEP_FIELDS;
    for (const f of fields) {
      const deps = e[f];
      if (!isObj(deps)) continue;
      for (const name of Object.keys(deps)) {
        const to = resolve(from, name);
        if (to !== null && !reached.has(to)) {
          reached.add(to);
          queue.push(to);
        }
      }
    }
    // Bundled children travel inside their parent's tarball; they stay with a reached parent.
    for (const p of Object.keys(packages)) {
      if (
        p.startsWith(`${from}/node_modules/`) &&
        isObj(packages[p]) &&
        packages[p].inBundle === true &&
        !reached.has(p)
      ) {
        reached.add(p);
        queue.push(p);
      }
    }
  }
  for (const p of Object.keys(packages)) {
    if (!reached.has(p)) {
      removed.add(p);
      delete packages[p];
    }
  }

  // A kept package that needs an excluded one (as the lockfile resolves it) would break at run
  // time, so the list does not apply: refuse, naming both. The root's devDependencies on the
  // excluded names are what the list removes, so they are not checked.
  for (const from of [...reached].sort()) {
    const e = original[from];
    if (!isObj(e)) continue;
    for (const f of DEP_FIELDS) {
      const deps = e[f];
      if (!isObj(deps)) continue;
      for (const name of Object.keys(deps)) {
        const to = resolve(from, name, original);
        const ex = to === null ? undefined : excludedPaths.get(to);
        if (ex === undefined) continue;
        const who =
          from === ''
            ? 'the root package'
            : `kept package ${typeof e.name === 'string' ? e.name : nameFromPath(from)}@${String(e.version)} (${from})`;
        return {
          ok: false,
          reason: `dev exclusion ${ex.name}@${ex.version} is needed by ${who}`,
        };
      }
    }
  }

  // The v1 tree of a v2 lockfile: drop every node whose path was removed.
  const pruneTree = (deps: unknown, prefix: string): void => {
    if (!isObj(deps)) return;
    for (const [name, e] of Object.entries(deps)) {
      const path = `${prefix}node_modules/${name}`;
      if (removed.has(path)) {
        delete deps[name];
        continue;
      }
      if (isObj(e)) pruneTree(e.dependencies, `${path}/`);
    }
  };
  pruneTree(lock.dependencies, '');

  return {
    ok: true,
    lockText: `${JSON.stringify(lock, null, 2)}\n`,
    pkgText: `${JSON.stringify(pkg, null, 2)}\n`,
    removed: [...removed].sort(),
  };
}
