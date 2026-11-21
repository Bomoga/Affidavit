/**
 * Lockfile rules for the split build. Lead decision 2026-11-20 (PR #18): the build has no route
 * out, not even to the npm registry, so a target whose install would download anything is
 * `unsupported` (plan.md, Lane 2 item 3: a target that cannot boot without real egress is marked
 * unsupported rather than granted an exception to deny-all). `dependencyFetchProblem` decides
 * that. `checkLockfile` still reads the lockfile's format and sources first, so a lockfile that
 * points at git, a link or another host is named for what it is.
 */

export const NPM_REGISTRY = 'registry.npmjs.org';
export const RESOLVED =
  /^https:\/\/registry\.npmjs\.org\/(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*\/-\/[\w.-]+\.tgz$/i;
export const BAD_VERSION = /^(git|git\+|github:|gitlab:|bitbucket:|file:|link:|http:|https:)/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Null when every entry the install will fetch comes from the registry only; otherwise the first
 * problem. With `production`, dev-only entries (`dev: true`) are skipped, because
 * `npm ci --production` never downloads them.
 */
export function checkLockfile(text: string, opts: { production: boolean }): string | null {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return 'package-lock.json is not JSON';
  }
  if (!isObj(lock)) return 'package-lock.json is not an object';
  const version = lock.lockfileVersion;
  if (version !== 1 && version !== 2 && version !== 3) {
    return `unsupported lockfileVersion ${String(version)}`;
  }

  const check = (where: string, e: Obj): string | null => {
    if (opts.production && e.dev === true) return null;
    if (e.link === true) return `${where} is a link`;
    if (e.bundled === true || e.inBundle === true) return null;
    if (typeof e.version === 'string' && BAD_VERSION.test(e.version)) {
      return `${where} comes from ${e.version}`;
    }
    if (e.resolved === undefined) return null;
    if (typeof e.resolved !== 'string' || !RESOLVED.test(e.resolved)) {
      return `${where} resolves outside the npm registry`;
    }
    // An integrity hash is checked by npm when present. Older lockfiles often lack it; the
    // download still only comes from the registry, which is what this check is for.
    if (
      e.integrity !== undefined &&
      (typeof e.integrity !== 'string' || !/^sha(1|256|384|512)-/.test(e.integrity))
    ) {
      return `${where} has a malformed integrity hash`;
    }
    return null;
  };

  if (isObj(lock.packages)) {
    for (const [path, e] of Object.entries(lock.packages)) {
      if (path === '' || !isObj(e)) continue;
      if (!path.split('/').includes('node_modules')) return `${path} is a workspace package`;
      const why = check(path, e);
      if (why !== null) return why;
    }
  }
  const walk = (deps: unknown, prefix: string): string | null => {
    if (!isObj(deps)) return null;
    for (const [name, e] of Object.entries(deps)) {
      if (!isObj(e)) continue;
      if (opts.production && e.dev === true) continue;
      const why = check(`${prefix}${name}`, e) ?? walk(e.dependencies, `${prefix}${name}>`);
      if (why !== null) return why;
    }
    return null;
  };
  return walk(lock.dependencies, '');
}

const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * Null when installing the target downloads nothing; otherwise why it is unsupported. Counted:
 * every lockfile entry the install would fetch (a package under `node_modules` that is not
 * bundled inside another one; with `production`, not dev-only), and any dependency `package.json`
 * declares (with `production`, `devDependencies` are left out), since npm would resolve those
 * from the network even when the lockfile omits them. Unreadable input is refused.
 */
export function dependencyFetchProblem(
  lockText: string,
  pkgText: string,
  opts: { production: boolean },
): string | null {
  let lock: unknown;
  let pkg: unknown;
  try {
    lock = JSON.parse(lockText);
    pkg = JSON.parse(pkgText);
  } catch {
    return 'package.json or package-lock.json is not JSON';
  }
  if (!isObj(lock) || !isObj(pkg)) return 'package.json or package-lock.json is not an object';

  let packages = 0;
  const counts = (e: Obj): boolean =>
    !(opts.production && e.dev === true) && e.bundled !== true && e.inBundle !== true;
  if (isObj(lock.packages)) {
    for (const [path, e] of Object.entries(lock.packages)) {
      if (path === '' || !isObj(e)) continue;
      if (path.split('/').includes('node_modules') && counts(e)) packages++;
    }
  } else {
    const walk = (deps: unknown): void => {
      if (!isObj(deps)) return;
      for (const e of Object.values(deps)) {
        if (!isObj(e) || !counts(e)) continue;
        packages++;
        walk(e.dependencies);
      }
    };
    walk(lock.dependencies);
  }

  const fields: readonly string[] = opts.production
    ? DEP_FIELDS
    : [...DEP_FIELDS, 'devDependencies'];
  let declared = 0;
  for (const f of fields) {
    const v = pkg[f];
    if (v === undefined) continue;
    if (!isObj(v)) return `package.json ${f} is not an object`;
    declared += Object.keys(v).length;
  }
  if (packages === 0 && declared === 0) return null;
  return (
    `needs a dependency fetch at build time (${packages} package${packages === 1 ? '' : 's'} ` +
    `in the lockfile, ${declared} declared in package.json); the build has no route out and ` +
    'deny-all egress has no exception for it, so the target is unsupported'
  );
}
