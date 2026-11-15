/**
 * The split build downloads dependencies with network access (the only build step that has it),
 * so the lockfile decides where that traffic goes. Every package must come from the public npm
 * registry over HTTPS, or be bundled inside another package. Git, file,
 * link and other sources are refused, so the fetch step never contacts anything else, and the
 * repository's `.npmrc` is removed before the fetch so it cannot redirect the registry.
 */

export const NPM_REGISTRY = 'registry.npmjs.org';
const RESOLVED =
  /^https:\/\/registry\.npmjs\.org\/(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*\/-\/[\w.-]+\.tgz$/i;
const BAD_VERSION = /^(git|git\+|github:|gitlab:|bitbucket:|file:|link:|http:|https:)/;

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
