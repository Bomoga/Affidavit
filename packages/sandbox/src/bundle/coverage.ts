import type { DependencyBundleManifest } from './format.js';
import { planLockfile, problemSummary, sectionPackages, type BundleSection } from './plan.js';

/**
 * Null when the bundle holds every package the staged lockfile would install for `sections`,
 * pinned identically (same path, version, resolved URL and integrity); otherwise why the target is
 * `unsupported`, naming the package. The lockfile comes from the staged tree, so a patch that
 * changes a dependency is caught here rather than installing something the bundle never verified.
 */
export function bundleCoverageProblem(
  lockText: string,
  manifest: DependencyBundleManifest,
  sections: readonly BundleSection[],
): string | null {
  const read = planLockfile(lockText);
  if (!read.ok) return read.reason;
  const { plan } = read;
  for (const name of sections) {
    if (plan.problems[name].length > 0) return problemSummary(name, plan.problems[name]);
  }
  for (const name of sections) {
    const section = manifest.sections[name];
    const needed = sectionPackages(plan, [name]);
    if (needed.length === 0) continue;
    if (section.status !== 'ok') {
      return `the dependency bundle's ${name} section is unsupported: ${section.reason}`;
    }
    const byPath = new Map(section.packages.map((p) => [p.path, p]));
    for (const p of needed) {
      const b = byPath.get(p.path);
      if (b === undefined) {
        return `${p.path} (${p.name}@${p.version}) is not in the dependency bundle's ${name} section`;
      }
      if (b.version !== p.version || b.resolved !== p.resolved || b.integrity !== p.integrity) {
        return `${p.path} (${p.name}@${p.version}) is pinned differently in the dependency bundle`;
      }
    }
  }
  return null;
}

/** Number of packages the lockfile installs for `sections` (0 means there is nothing to mount). */
export function plannedCount(lockText: string, sections: readonly BundleSection[]): number {
  const read = planLockfile(lockText);
  return read.ok ? sectionPackages(read.plan, sections).length : 0;
}

/** Where the materialized npm cache is mounted, read only, in the install step. */
export const DEPENDENCY_MOUNT = '/affidavit-deps';

/**
 * The install step's command, run in gVisor with no network at all: copy the read-only cache to
 * the jail's scratch (npm writes to its cache), then `npm ci --offline --ignore-scripts`. With only
 * the production section, dev dependencies are omitted (`--omit=dev`, and `NODE_ENV=production`
 * for npm 6, which has no `--omit`). No registry, proxy or network option appears anywhere.
 */
export function bundleInstallCommand(sections: readonly BundleSection[]): string[] {
  const production = !sections.includes('dev');
  const npm = ['npm', ...bundleNpmArgs(sections)];
  return [
    'sh',
    '-c',
    `mkdir -p /scratch/npm-cache && cp -R ${DEPENDENCY_MOUNT}/_cacache /scratch/npm-cache/ && ` +
      `${production ? 'NODE_ENV=production ' : ''}exec ${npm.join(' ')}`,
  ];
}

/** The npm arguments of the install step (also used by the host-side offline install test). */
export function bundleNpmArgs(sections: readonly BundleSection[]): string[] {
  return [
    'ci',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...(sections.includes('dev') ? [] : ['--omit=dev']),
  ];
}

/**
 * Key under `BundleManifest.toolVersions` (contracts) that pins the dependency bundle a variant's
 * image was built from, value `sha256:<hex>` of the bundle tar. The contract has no dedicated
 * field; `toolVersions` is a string record, so the digest rides there without a contract change.
 * Replay must read it back and build with the same pinned bundle (see boot-recipes.md).
 */
export const dependencyBundleToolVersionKey = (variant: string): string =>
  `dependency-bundle:${variant}`;

export function dependencyBundleToolVersions(
  byVariant: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [variant, sha256] of Object.entries(byVariant)) {
    if (sha256 === undefined) continue;
    out[dependencyBundleToolVersionKey(variant)] = sha256.startsWith('sha256:')
      ? sha256
      : `sha256:${sha256}`;
  }
  return out;
}
