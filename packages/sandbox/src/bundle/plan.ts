import { BAD_VERSION, RESOLVED } from '../boot/lockfile.js';
import { parseIntegrity } from './integrity.js';

/**
 * The two sections of a dependency bundle. `production` is what the runtime image needs; `dev` is
 * what a build script or the target's own test suite needs on top of it (the patch workbench's
 * suite build). Each section is hashed on its own, so a runtime build mounts only `production`.
 */
export type BundleSection = 'production' | 'dev';
export const BUNDLE_SECTIONS: readonly BundleSection[] = ['production', 'dev'];

/** One package the install would fetch, exactly as the lockfile pins it. */
export interface PlannedPackage {
  /** Lockfile path, such as `node_modules/a/node_modules/b`. */
  path: string;
  name: string;
  version: string;
  resolved: string;
  /** The lockfile's `integrity` string, verbatim. */
  integrity: string;
  section: BundleSection;
}

export interface LockfilePlan {
  lockfileVersion: 1 | 2 | 3;
  packages: PlannedPackage[];
  /** Entries npm never fetches on the Linux target (an optional package for another OS). */
  skipped: { path: string; reason: string }[];
  /**
   * Why a section cannot be bundled, one line per package, each naming the package. A section
   * with problems is `unsupported`; nothing is fetched for it.
   */
  problems: Record<BundleSection, string[]>;
}

export type PlanRead = { ok: true; plan: LockfilePlan } | { ok: false; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** npm skips an optional package whose `os` field rules out Linux, without fetching it. */
function excludesLinux(os: unknown): boolean {
  if (!Array.isArray(os) || os.length === 0) return false;
  const values = os.filter((x): x is string => typeof x === 'string');
  if (values.includes('!linux')) return true;
  const positive = values.filter((x) => !x.startsWith('!'));
  return positive.length > 0 && !positive.includes('linux');
}

function nameFromPath(path: string): string {
  const i = path.lastIndexOf('node_modules/');
  return i === -1 ? path : path.slice(i + 'node_modules/'.length);
}

/**
 * Reads a package-lock.json (v1 to v3) and lists every package `npm ci` would download, split into
 * the production and dev sections. Nothing is fetched or run. A package is a problem (named, so
 * the target's `unsupported` reason says which one) when it is a link or workspace, comes from git,
 * a file or another host, has no resolved URL or no well-formed integrity hash, or the lockfile
 * says it has install scripts. Lifecycle scripts are disabled everywhere, so a package that needs
 * one (a native compile, a binary download) cannot be installed and is not worked around.
 * Bundled packages (`inBundle`) arrive inside their parent's tarball and are not listed.
 */
export function planLockfile(text: string): PlanRead {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'package-lock.json is not JSON' };
  }
  if (!isObj(lock)) return { ok: false, reason: 'package-lock.json is not an object' };
  const version = lock.lockfileVersion;
  if (version !== 1 && version !== 2 && version !== 3) {
    return { ok: false, reason: `unsupported lockfileVersion ${String(version)}` };
  }
  const plan: LockfilePlan = {
    lockfileVersion: version,
    packages: [],
    skipped: [],
    problems: { production: [], dev: [] },
  };
  const skippedPrefixes: string[] = [];

  const visit = (path: string, e: Obj): void => {
    const section: BundleSection = e.dev === true ? 'dev' : 'production';
    const problem = (why: string): void => {
      plan.problems[section].push(`${path} ${why}`);
    };
    if (e.inBundle === true || e.bundled === true) return;
    if (skippedPrefixes.some((p) => path.startsWith(`${p}/`))) return;
    if (e.link === true) return problem('is a link');
    if (!path.split('/').includes('node_modules')) return problem('is a workspace package');
    if (e.optional === true && excludesLinux(e.os)) {
      skippedPrefixes.push(path);
      plan.skipped.push({ path, reason: `optional, os ${JSON.stringify(e.os)}` });
      return;
    }
    const name = typeof e.name === 'string' ? e.name : nameFromPath(path);
    if (typeof e.version !== 'string' || e.version.length === 0) return problem('has no version');
    if (BAD_VERSION.test(e.version)) return problem(`comes from ${e.version}`);
    const label = `(${name}@${e.version})`;
    if (typeof e.resolved !== 'string') return problem(`${label} has no resolved URL`);
    if (!RESOLVED.test(e.resolved)) return problem(`${label} resolves outside the npm registry`);
    if (e.integrity === undefined) return problem(`${label} has no integrity hash`);
    if (parseIntegrity(e.integrity) === null) {
      return problem(`${label} has a malformed integrity hash`);
    }
    if (e.hasInstallScript === true) {
      return problem(
        `${label} has install scripts; lifecycle scripts are disabled, so it cannot be installed`,
      );
    }
    plan.packages.push({
      path,
      name,
      version: e.version,
      resolved: e.resolved,
      integrity: e.integrity as string,
      section,
    });
  };

  if (isObj(lock.packages)) {
    // Parents sort before their children, so an OS-skipped package is seen before its subtree.
    const entries = Object.entries(lock.packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [path, e] of entries) {
      if (path === '' || !isObj(e)) continue;
      visit(path, e);
    }
  } else {
    const walk = (deps: unknown, prefix: string): void => {
      if (!isObj(deps)) return;
      for (const [name, e] of Object.entries(deps)) {
        if (!isObj(e)) continue;
        const path = `${prefix}node_modules/${name}`;
        visit(path, { ...e, name });
        walk(e.dependencies, `${path}/`);
      }
    };
    walk(lock.dependencies, '');
  }
  return { ok: true, plan };
}

/** The packages of the given sections. */
export const sectionPackages = (
  plan: LockfilePlan,
  sections: readonly BundleSection[],
): PlannedPackage[] => plan.packages.filter((p) => sections.includes(p.section));

/** One line for an `unsupported` reason, naming at most `max` packages. */
export function problemSummary(
  section: BundleSection,
  problems: readonly string[],
  max = 8,
): string {
  const shown = problems.slice(0, max).join('; ');
  const more = problems.length > max ? `; and ${problems.length - max} more` : '';
  return `the ${section} dependencies cannot be bundled: ${shown}${more}`;
}
