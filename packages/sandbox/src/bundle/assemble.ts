import { createHash } from 'node:crypto';
import {
  BUNDLE_SCHEMA,
  makeSection,
  writeDependencyBundle,
  type BundlePackage,
  type BundleSectionRecord,
  type DependencyBundleManifest,
} from './format.js';
import { digestHex, integrityMismatch, parseIntegrity } from './integrity.js';
import { inspectPackageTarball } from './inspect.js';
import { DEPENDENCY_BUNDLE_CAPS } from './open.js';
import {
  BUNDLE_SECTIONS,
  planLockfile,
  problemSummary,
  sectionPackages,
  type BundleSection,
  type LockfilePlan,
  type PlannedPackage,
} from './plan.js';
import { pruneExcludedDev, validateExclusions, type ExcludedDevPackage } from './prune.js';

export interface AssembleInput {
  app: string;
  commit: string;
  lockText: string;
  /** The target's package.json; needed only with `excludedDev`. */
  pkgText?: string;
  /**
   * Reviewed dev packages to leave out (`bundle-exclusions.json`). The dev section is planned from
   * the lockfile with these pruned, and records the list under its digest.
   */
  excludedDev?: readonly ExcludedDevPackage[];
  /**
   * The tarball bytes for a planned package, or null when none was obtained. Supplied by the
   * human-run builder script (which is the only code that touches the network); tests pass a
   * fake. Whatever it returns is untrusted until every lockfile integrity hash matches.
   */
  tarballFor: (p: PlannedPackage) => Promise<Buffer | null>;
  maxUnpackedPackageBytes?: number;
}

export interface AssembleResult {
  manifest: DependencyBundleManifest;
  tarballs: Map<string, Buffer>;
  plan: LockfilePlan;
}

/**
 * Builds the manifest and tarball set for a bundle from a lockfile, without network access of its
 * own. A section whose lockfile entries have problems, or with a package whose tarball is missing,
 * does not match its integrity, or needs an install script, becomes `unsupported` with every such
 * package named; the other section is unaffected.
 */
export async function assembleBundle(input: AssembleInput): Promise<AssembleResult> {
  const read = planLockfile(input.lockText);
  if (!read.ok) throw new Error(read.reason);
  const { plan } = read;
  const excluded = validateExclusions(input.excludedDev ?? [], 'excludedDev');
  let devPlan = plan;
  if (excluded.length > 0) {
    if (input.pkgText === undefined) throw new Error('excludedDev needs the package.json text');
    const pruned = pruneExcludedDev(input.lockText, input.pkgText, excluded);
    if (!pruned.ok) throw new Error(pruned.reason);
    const devRead = planLockfile(pruned.lockText);
    if (!devRead.ok) throw new Error(devRead.reason);
    devPlan = devRead.plan;
  }
  const maxUnpacked =
    input.maxUnpackedPackageBytes ?? DEPENDENCY_BUNDLE_CAPS.maxUnpackedPackageBytes;
  const tarballs = new Map<string, Buffer>();
  const sections = {} as Record<BundleSection, BundleSectionRecord>;
  for (const name of BUNDLE_SECTIONS) {
    const sectionPlan = name === 'dev' ? devPlan : plan;
    const list = name === 'dev' && excluded.length > 0 ? { excluded } : {};
    const problems = [...sectionPlan.problems[name]];
    const packages: BundlePackage[] = [];
    const mine = new Map<string, Buffer>();
    // A section the lockfile already rules out is not fetched at all.
    const toFetch = problems.length > 0 ? [] : sectionPackages(sectionPlan, [name]);
    for (const p of toFetch) {
      const label = `${p.path} (${p.name}@${p.version})`;
      const data = await input.tarballFor(p);
      if (data === null) {
        problems.push(`${label} could not be fetched`);
        continue;
      }
      const bad = integrityMismatch(parseIntegrity(p.integrity) ?? [], data);
      if (bad !== null) {
        problems.push(`${label} does not match its lockfile ${bad} integrity`);
        continue;
      }
      const inspected = await inspectPackageTarball(data, maxUnpacked);
      if (!inspected.ok) {
        problems.push(`${label} ${inspected.reason}`);
        continue;
      }
      if (inspected.info.installScripts.length > 0) {
        problems.push(
          `${label} needs install scripts (${inspected.info.installScripts.join(', ')}); ` +
            'lifecycle scripts are disabled',
        );
        continue;
      }
      const sha512 = digestHex('sha512', data);
      mine.set(sha512, data);
      packages.push({
        path: p.path,
        name: p.name,
        version: p.version,
        resolved: p.resolved,
        integrity: p.integrity,
        sha512,
        ...(inspected.info.prepareScripts.length > 0
          ? { prepareScriptIgnored: true as const }
          : {}),
      });
    }
    if (problems.length > 0) {
      sections[name] = makeSection({
        status: 'unsupported',
        reason: problemSummary(name, problems, 50),
        ...list,
      });
    } else {
      sections[name] = makeSection({ status: 'ok', packages, ...list });
      for (const [h, d] of mine) tarballs.set(h, d);
    }
  }
  return {
    manifest: {
      schema: BUNDLE_SCHEMA,
      app: input.app,
      commit: input.commit,
      lockfileSha256: createHash('sha256').update(input.lockText).digest('hex'),
      sections,
    },
    tarballs,
    plan,
  };
}

/** Assembles and writes a bundle; returns its sha256 and the manifest. */
export async function assembleBundleFile(
  input: AssembleInput,
  file: string,
): Promise<{
  sha256: string;
  bytes: number;
  manifest: DependencyBundleManifest;
  plan: LockfilePlan;
}> {
  const { manifest, tarballs, plan } = await assembleBundle(input);
  const { sha256, bytes } = await writeDependencyBundle(file, manifest, tarballs);
  return { sha256, bytes, manifest, plan };
}
