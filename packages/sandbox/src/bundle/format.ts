import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import tar from 'tar-stream';
import { RESOLVED } from '../boot/lockfile.js';
import { SHA256_HEX, SHA512_HEX, canonicalSha256, parseIntegrity } from './integrity.js';
import { BUNDLE_SECTIONS, type BundleSection } from './plan.js';
import { validateExclusions, type ExcludedDevPackage } from './prune.js';

/**
 * A dependency bundle is one uncompressed tar, addressed by its sha256:
 *
 *   manifest.json            what is in it (below)
 *   tarballs/<sha512>.tgz    each package tarball exactly as the registry served it, named by the
 *                            sha512 of its bytes
 *
 * Regular files only, at exactly those names, written in sorted order with fixed metadata, so the
 * same packages always give the same bytes and the same digest. The bundle's own sha256 cannot be
 * inside it; the builder writes it next to the tar (`<sha256>.json`) and a human pins it in
 * `docker/sandbox/dependency-bundles/pins.json`.
 */
export const BUNDLE_SCHEMA = 'affidavit.dependency-bundle/v1';
export const MANIFEST_NAME = 'manifest.json';
export const tarballName = (sha512: string): string => `tarballs/${sha512}.tgz`;

export interface BundlePackage {
  path: string;
  name: string;
  version: string;
  resolved: string;
  /** The lockfile's `integrity` string, verbatim; every hash in it was checked at build time. */
  integrity: string;
  /** sha512 (hex) of the tarball bytes, which is also its name in the bundle. */
  sha512: string;
  /**
   * Set when the tarball (or a package nested in it) declares a `prepare` script. npm never runs
   * `prepare` for a registry tarball and the install uses `--ignore-scripts`; recorded so a
   * reviewer sees it, and under the section digest.
   */
  prepareScriptIgnored?: true;
}

/**
 * A section either lists its packages or says why it could not be built. The dev section may also
 * carry `excluded`: the reviewed dev packages left out on purpose (see `prune.ts`). It is under the
 * section digest, so changing the list changes the bundle sha256.
 */
export type BundleSectionRecord =
  | { status: 'ok'; sha256: string; packages: BundlePackage[]; excluded?: ExcludedDevPackage[] }
  | { status: 'unsupported'; sha256: string; reason: string; excluded?: ExcludedDevPackage[] };

export interface DependencyBundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  app: string;
  /** The corpus commit whose lockfile the bundle was built from. */
  commit: string;
  /** sha256 of that package-lock.json, as committed. */
  lockfileSha256: string;
  sections: Record<BundleSection, BundleSectionRecord>;
}

/**
 * The digest of one section: sha256 over the canonical JSON of the section without its `sha256`
 * field. For an `ok` section that covers every package's path, version, resolved URL, lockfile
 * integrity and tarball sha512, so it pins the bytes a build mounts from that section.
 */
export function sectionDigest(section: BundleSectionRecord): string {
  const { sha256: _ignored, ...rest } = section;
  void _ignored;
  if (rest.status === 'ok') {
    const packages = [...rest.packages].sort((a, b) => (a.path < b.path ? -1 : 1));
    return canonicalSha256({ ...rest, packages });
  }
  return canonicalSha256(rest);
}

export function makeSection(
  input: (
    { status: 'ok'; packages: BundlePackage[] } | { status: 'unsupported'; reason: string }
  ) & { excluded?: ExcludedDevPackage[] },
): BundleSectionRecord {
  const { excluded, ...base } = input;
  const sorted =
    base.status === 'ok'
      ? { ...base, packages: [...base.packages].sort((a, b) => (a.path < b.path ? -1 : 1)) }
      : base;
  const withList = excluded !== undefined && excluded.length > 0 ? { ...sorted, excluded } : sorted;
  const withPlaceholder: BundleSectionRecord = { ...withList, sha256: '' };
  return { ...withPlaceholder, sha256: sectionDigest(withPlaceholder) };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length < 4096;

/**
 * Validates a manifest's shape and every section digest. The manifest is read from a bundle,
 * which is untrusted until its sha256 matches the pin, and even then is checked field by field.
 */
export function parseBundleManifest(
  text: string,
): { ok: true; manifest: DependencyBundleManifest } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason: `manifest ${reason}` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('is not JSON');
  }
  if (!isObj(raw)) return fail('is not an object');
  if (raw.schema !== BUNDLE_SCHEMA) return fail(`has an unknown schema ${String(raw.schema)}`);
  if (!nonEmpty(raw.app) || !/^[a-z0-9-]+$/.test(raw.app)) return fail('has a bad app id');
  if (typeof raw.commit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.commit)) {
    return fail('has a bad commit');
  }
  if (typeof raw.lockfileSha256 !== 'string' || !SHA256_HEX.test(raw.lockfileSha256)) {
    return fail('has a bad lockfileSha256');
  }
  if (!isObj(raw.sections)) return fail('has no sections');
  const keys = Object.keys(raw.sections).sort();
  if (keys.join(',') !== [...BUNDLE_SECTIONS].sort().join(',')) {
    return fail('must have exactly the production and dev sections');
  }
  const sections = {} as Record<BundleSection, BundleSectionRecord>;
  const paths = new Set<string>();
  for (const name of BUNDLE_SECTIONS) {
    const s = raw.sections[name];
    if (!isObj(s) || typeof s.sha256 !== 'string' || !SHA256_HEX.test(s.sha256)) {
      return fail(`section ${name} is malformed`);
    }
    let excluded: ExcludedDevPackage[] | undefined;
    if (s.excluded !== undefined) {
      if (name !== 'dev') return fail(`section ${name} may not exclude packages`);
      try {
        excluded = validateExclusions(s.excluded, `section ${name} excluded`);
      } catch (e) {
        return fail((e as Error).message);
      }
      if (excluded.length === 0) return fail(`section ${name} has an empty excluded list`);
    }
    let rec: BundleSectionRecord;
    if (s.status === 'unsupported') {
      if (!nonEmpty(s.reason)) return fail(`section ${name} has no reason`);
      rec = { status: 'unsupported', sha256: s.sha256, reason: s.reason };
    } else if (s.status === 'ok') {
      if (!Array.isArray(s.packages)) return fail(`section ${name} has no package list`);
      const packages: BundlePackage[] = [];
      for (const p of s.packages as unknown[]) {
        if (!isObj(p)) return fail(`section ${name} has a malformed package`);
        const {
          path,
          name: pkgName,
          version,
          resolved,
          integrity,
          sha512,
          prepareScriptIgnored,
        } = p;
        if (prepareScriptIgnored !== undefined && prepareScriptIgnored !== true) {
          return fail(`package ${String(path)} has a bad prepareScriptIgnored`);
        }
        if (!nonEmpty(path) || !nonEmpty(pkgName) || !nonEmpty(version)) {
          return fail(`section ${name} has a package without path, name or version`);
        }
        if (paths.has(path)) return fail(`lists ${path} twice`);
        paths.add(path);
        if (!nonEmpty(resolved) || !RESOLVED.test(resolved)) {
          return fail(`package ${path} resolves outside the npm registry`);
        }
        if (parseIntegrity(integrity) === null) {
          return fail(`package ${path} has a missing or malformed integrity hash`);
        }
        if (typeof sha512 !== 'string' || !SHA512_HEX.test(sha512)) {
          return fail(`package ${path} has a bad sha512`);
        }
        packages.push({
          path,
          name: pkgName,
          version,
          resolved,
          integrity: integrity as string,
          sha512,
          ...(prepareScriptIgnored === true ? { prepareScriptIgnored: true as const } : {}),
        });
      }
      rec = { status: 'ok', sha256: s.sha256, packages };
    } else {
      return fail(`section ${name} has an unknown status`);
    }
    if (excluded !== undefined) rec = { ...rec, excluded };
    if (sectionDigest(rec) !== rec.sha256) return fail(`section ${name} digest does not match`);
    sections[name] = rec;
  }
  return {
    ok: true,
    manifest: {
      schema: BUNDLE_SCHEMA,
      app: raw.app,
      commit: raw.commit,
      lockfileSha256: raw.lockfileSha256,
      sections,
    },
  };
}

/** Fixed tar metadata, so the bundle bytes depend only on the content. */
const HEADER = {
  mode: 0o644,
  uid: 0,
  gid: 0,
  uname: '',
  gname: '',
  mtime: new Date(0),
  type: 'file' as const,
};

/**
 * Writes a bundle to `file` and returns its sha256. `tarballs` maps sha512 hex to the tarball
 * bytes; every one must be listed by the manifest and every listed sha512 must be present.
 */
export async function writeDependencyBundle(
  file: string,
  manifest: DependencyBundleManifest,
  tarballs: ReadonlyMap<string, Buffer>,
): Promise<{ sha256: string; bytes: number }> {
  const listed = new Set<string>();
  for (const s of Object.values(manifest.sections)) {
    if (s.status === 'ok') for (const p of s.packages) listed.add(p.sha512);
  }
  for (const h of listed) if (!tarballs.has(h)) throw new Error(`no tarball for sha512 ${h}`);
  for (const h of tarballs.keys())
    if (!listed.has(h)) throw new Error(`tarball ${h} is not listed`);

  const pack = tar.pack();
  const out = createWriteStream(file, { flags: 'wx' });
  const hash = createHash('sha256');
  let bytes = 0;
  const written = new Promise<void>((resolve, reject) => {
    pack.on('data', (data: unknown) => {
      const chunk = data as Buffer;
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk)) {
        pack.pause();
        out.once('drain', () => pack.resume());
      }
    });
    pack.on('end', () => out.end());
    pack.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
  });
  const add = (name: string, data: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      pack.entry({ ...HEADER, name, size: data.length }, data, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  await add(MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  for (const h of [...tarballs.keys()].sort()) await add(tarballName(h), tarballs.get(h) as Buffer);
  pack.finalize();
  await written;
  return { sha256: hash.digest('hex'), bytes };
}
