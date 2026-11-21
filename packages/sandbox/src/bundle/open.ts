import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import tar from 'tar-stream';
import {
  MANIFEST_NAME,
  parseBundleManifest,
  type BundlePackage,
  type DependencyBundleManifest,
} from './format.js';
import { SHA256_HEX, digestHex, integrityMismatch, parseIntegrity } from './integrity.js';
import { inspectPackageTarball } from './inspect.js';
import type { BundleSection } from './plan.js';

/** Where a build finds its dependency bundle, and the digest it must have. */
export interface DependencyBundleRef {
  /** Host path of the bundle tar. Must be a regular file (not a link) under `allowedRoot`. */
  path: string;
  /** The pinned sha256 (64 hex, optionally prefixed `sha256:`), from `pins.json`, never the bundle. */
  sha256: string;
  /** The one host directory bundles may be read from (allowlist), absolute. */
  allowedRoot: string;
}

/** Bounds on a bundle, checked while it is read. Configuration, not measurements. */
export interface DependencyBundleCaps {
  maxBundleBytes: number;
  maxEntries: number;
  maxTarballBytes: number;
  maxManifestBytes: number;
  /** Per package tarball, after gunzip, for the install-script inspection. */
  maxUnpackedPackageBytes: number;
}
export const DEPENDENCY_BUNDLE_CAPS: Readonly<DependencyBundleCaps> = {
  maxBundleBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000,
  maxTarballBytes: 64 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxUnpackedPackageBytes: 256 * 1024 * 1024,
};

export interface OpenedBundle {
  /** The verified sha256 of the bundle tar, equal to the pin. */
  sha256: string;
  manifest: DependencyBundleManifest;
  /** Host directory holding each verified tarball as `<sha512>`, written by this code. */
  storeDir: string;
}

export type BundleOpen =
  | { ok: true; bundle: OpenedBundle }
  | {
      ok: false;
      /**
       * `true` when the bundle is intact but its content cannot be used without a lifecycle
       * script (the target is `unsupported`); `false` when the bundle itself is wrong (digest
       * mismatch, tampering, a malformed tar), which fails closed as a `failed` build.
       */
      unsupported: boolean;
      reason: string;
    };

const TARBALL_ENTRY = /^tarballs\/([0-9a-f]{128})\.tgz$/;
const show = (name: string): string => JSON.stringify(name.slice(0, 200));

/** Null when a tar entry name and type are exactly what a bundle may hold, else why not. */
export function bundleEntryProblem(name: string, type: string | null | undefined): string | null {
  if (type === 'symlink') return `has a symlink entry ${show(name)}`;
  if (type === 'link') return `has a hardlink entry ${show(name)}`;
  if (type === 'directory') return `has a directory entry ${show(name)}`;
  if (type !== 'file') return `has a ${String(type)} entry ${show(name)}`;
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
    return `has an absolute path ${show(name)}`;
  }
  if (name.split(/[/\\]/).includes('..')) return `has a path traversal entry ${show(name)}`;
  if (name !== MANIFEST_NAME && !TARBALL_ENTRY.test(name)) {
    return `has an unexpected entry ${show(name)}`;
  }
  return null;
}

/**
 * Opens a pinned dependency bundle on the host. A first streaming pass hashes the whole file and
 * nothing is created or written unless that sha256 equals the pinned digest (fail closed on
 * mismatch). A second pass parses the tar, hashing again, and is refused if the file changed in
 * between. Then the manifest is validated, every
 * tarball's sha512 must match its name, every hash in each package's lockfile integrity must match
 * its tarball, and each tarball is inspected for install scripts. Refused at any point: a path
 * outside `allowedRoot` or a link, a file over the size cap, more entries than the cap, a symlink,
 * hardlink, directory or other non-file entry, an absolute or `..` path, any name other than
 * `manifest.json` and `tarballs/<sha512>.tgz`, and duplicates.
 *
 * Verified tarballs are written to `<workDir>/bundle-store/<sha512>` by this code; their content
 * is never unpacked on the host (only gunzipped in memory to read package.json).
 */
export async function openDependencyBundle(
  ref: DependencyBundleRef,
  workDir: string,
  caps: Readonly<DependencyBundleCaps> = DEPENDENCY_BUNDLE_CAPS,
): Promise<BundleOpen> {
  const broken = (reason: string): BundleOpen => ({
    ok: false,
    unsupported: false,
    reason: `dependency bundle ${reason}`,
  });
  const expected = ref.sha256.startsWith('sha256:') ? ref.sha256.slice(7) : ref.sha256;
  if (!SHA256_HEX.test(expected)) return broken('pin is not a sha256');
  if (!isAbsolute(ref.allowedRoot) || !isAbsolute(ref.path)) {
    return broken('path and allowed root must be absolute');
  }
  let file: string;
  let size: number;
  try {
    const root = await realpath(ref.allowedRoot);
    const st = await lstat(ref.path);
    if (st.isSymbolicLink()) return broken('path is a symlink');
    if (!st.isFile()) return broken('is not a regular file');
    file = await realpath(ref.path);
    const rel = relative(root, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return broken('is outside the allowed bundle root');
    }
    size = st.size;
  } catch {
    return broken('cannot be read');
  }
  if (size > caps.maxBundleBytes) return broken(`is over ${caps.maxBundleBytes} bytes`);

  // The digest decides first, before anything is created or written.
  const first = await sha256Capped(file, caps.maxBundleBytes);
  if (!first.ok) return broken(first.reason);
  if (first.sha256 !== expected) {
    return broken(`sha256 ${first.sha256} does not match the pinned ${expected}`);
  }

  // Verified tarballs go to a fresh 0700 directory that only the host user can read, and it is
  // removed on any refusal, so nothing from a bundle that fails verification is left behind.
  await mkdir(workDir, { recursive: true });
  const storeDir = await mkdtemp(join(workDir, 'bundle-store-'));
  await chmod(storeDir, 0o700);
  let result: BundleOpen;
  try {
    result = await readAndVerify(file, expected, storeDir, caps, broken);
  } catch (err) {
    await rm(storeDir, { recursive: true, force: true });
    throw err;
  }
  if (!result.ok) await rm(storeDir, { recursive: true, force: true });
  return result;
}

async function readAndVerify(
  file: string,
  expected: string,
  storeDir: string,
  caps: Readonly<DependencyBundleCaps>,
  broken: (reason: string) => BundleOpen,
): Promise<BundleOpen> {
  const hash = createHash('sha256');
  const extract = tar.extract();
  let parsing = true;
  let extractClosed = false;
  extract.on('close', () => {
    extractClosed = true;
  });
  let total = 0;
  let readError: string | null = null;
  const feeding = (async (): Promise<void> => {
    const source = createReadStream(file);
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > caps.maxBundleBytes) {
          readError = `is over ${caps.maxBundleBytes} bytes`;
          break;
        }
        hash.update(chunk);
        if (parsing && !extractClosed && !extract.write(chunk)) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              extract.off('drain', done);
              extract.off('close', done);
              resolve();
            };
            extract.once('drain', done);
            extract.once('close', done);
          });
        }
      }
    } catch {
      readError = 'cannot be read';
    } finally {
      source.destroy();
      if (!extractClosed) {
        if (readError === null && parsing) extract.end(Buffer.alloc(0));
        else extract.destroy();
      }
    }
  })();

  let entryProblem: string | null = null;
  let manifestText: string | null = null;
  const stored = new Set<string>();
  const seen = new Set<string>();
  try {
    for await (const entry of extract) {
      const { name, type, size: entrySize } = entry.header;
      const problem =
        (seen.size >= caps.maxEntries ? `has more than ${caps.maxEntries} entries` : null) ??
        bundleEntryProblem(name, type) ??
        (seen.has(name) ? `has a duplicate entry ${show(name)}` : null);
      seen.add(name);
      const cap = name === MANIFEST_NAME ? caps.maxManifestBytes : caps.maxTarballBytes;
      const tooBig = (entrySize ?? 0) > cap ? `entry ${show(name)} is over ${cap} bytes` : null;
      if (problem !== null || tooBig !== null) {
        entryProblem = problem ?? tooBig;
        break;
      }
      const chunks: Buffer[] = [];
      let got = 0;
      for await (const c of entry as AsyncIterable<Buffer>) {
        got += c.length;
        if (got > cap) break;
        chunks.push(c);
      }
      if (got > cap) {
        entryProblem = `entry ${show(name)} is over ${cap} bytes`;
        break;
      }
      const data = Buffer.concat(chunks);
      if (name === MANIFEST_NAME) {
        manifestText = data.toString('utf8');
        continue;
      }
      const sha512 = (TARBALL_ENTRY.exec(name) as RegExpExecArray)[1] as string;
      if (createHash('sha512').update(data).digest('hex') !== sha512) {
        entryProblem = `tarball ${sha512.slice(0, 16)}... does not match its sha512 (tampered)`;
        break;
      }
      await writeFile(join(storeDir, sha512), data, { mode: 0o644 });
      stored.add(sha512);
    }
  } catch {
    entryProblem ??= 'is not a valid tar archive';
  }
  parsing = false;
  if (!extractClosed) extract.destroy();
  await feeding;

  // The first pass already matched the pin; a different digest now means the file changed.
  if (readError !== null) return broken(readError);
  const actual = hash.digest('hex');
  if (actual !== expected) {
    return broken(`changed while it was read (sha256 ${actual}, pinned ${expected})`);
  }
  if (entryProblem !== null) return broken(entryProblem);
  if (manifestText === null) return broken('has no manifest.json');
  const parsed = parseBundleManifest(manifestText);
  if (!parsed.ok) return broken(parsed.reason);
  const manifest = parsed.manifest;

  const listed = new Map<string, BundlePackage>();
  for (const section of Object.values(manifest.sections)) {
    if (section.status !== 'ok') continue;
    for (const p of section.packages) {
      if (!stored.has(p.sha512)) return broken(`has no tarball for ${p.path}`);
      const integrity = parseIntegrity(p.integrity);
      if (integrity === null) return broken(`package ${p.path} has a malformed integrity hash`);
      const data = await readFile(join(storeDir, p.sha512));
      const bad = integrityMismatch(integrity, data);
      if (bad !== null) {
        return broken(`tarball for ${p.path} does not match its lockfile ${bad} integrity`);
      }
      if (!listed.has(p.sha512)) listed.set(p.sha512, p);
    }
  }
  for (const h of stored) {
    if (!listed.has(h))
      return broken(`has a tarball the manifest does not list (${h.slice(0, 16)}...)`);
  }
  for (const [h, p] of listed) {
    const read = await inspectPackageTarball(
      await readFile(join(storeDir, h)),
      caps.maxUnpackedPackageBytes,
    );
    if (!read.ok) return broken(`tarball for ${p.path} ${read.reason}`);
    if (read.info.installScripts.length > 0) {
      return {
        ok: false,
        unsupported: true,
        reason:
          `${p.path} (${p.name}@${p.version}) needs install scripts ` +
          `(${read.info.installScripts.join(', ')}); lifecycle scripts are disabled, so the ` +
          'target is unsupported',
      };
    }
    if (read.info.prepareScripts.length > 0 && p.prepareScriptIgnored !== true) {
      return broken(`tarball for ${p.path} has a prepare script the manifest does not record`);
    }
    if (read.info.name !== p.name) {
      return broken(`tarball for ${p.path} is package ${String(read.info.name)}, not ${p.name}`);
    }
    if (read.info.version !== p.version) {
      return broken(`tarball for ${p.path} is version ${read.info.version}, not ${p.version}`);
    }
  }
  return { ok: true, bundle: { sha256: actual, manifest, storeDir } };
}

/** sha256 of a file in one streaming pass, refusing a file that grows past `cap`. */
async function sha256Capped(
  file: string,
  cap: number,
): Promise<{ ok: true; sha256: string } | { ok: false; reason: string }> {
  const hash = createHash('sha256');
  let total = 0;
  const source = createReadStream(file);
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > cap) return { ok: false, reason: `is over ${cap} bytes` };
      hash.update(chunk);
    }
  } catch {
    return { ok: false, reason: 'cannot be read' };
  } finally {
    source.destroy();
  }
  return { ok: true, sha256: hash.digest('hex') };
}

/**
 * Lays out the packages of `sections` as an npm content cache (`_cacache/content-v2/<algo>/..`,
 * the path npm derives from a lockfile integrity hash), one copy per hash the lockfile names, so
 * `npm ci --offline` finds every tarball by its integrity and never asks the network. Paths come
 * only from verified digests. Returns the number of packages laid out. Throws if a section is not
 * `ok` (callers check coverage first).
 */
export async function materializeNpmCache(
  bundle: OpenedBundle,
  sections: readonly BundleSection[],
  cacheDir: string,
): Promise<number> {
  let count = 0;
  for (const name of sections) {
    const section = bundle.manifest.sections[name];
    if (section.status !== 'ok') throw new Error(`bundle section ${name} is unsupported`);
    for (const p of section.packages) {
      const verified = await readFile(join(bundle.storeDir, p.sha512));
      const integrity = parseIntegrity(p.integrity) ?? [];
      if (
        digestHex('sha512', verified) !== p.sha512 ||
        integrity.length === 0 ||
        integrityMismatch(integrity, verified) !== null
      ) {
        throw new Error(`bundle tarball for ${p.path} changed after verification`);
      }
      for (const h of integrity) {
        const dir = join(
          cacheDir,
          '_cacache',
          'content-v2',
          h.algo,
          h.hex.slice(0, 2),
          h.hex.slice(2, 4),
        );
        await mkdir(dir, { recursive: true, mode: 0o755 });
        const dest = join(dir, h.hex.slice(4));
        try {
          await lstat(dest);
        } catch {
          // The bytes written are the bytes just hashed: no window between verify and mount.
          await writeFile(dest, verified, { mode: 0o644, flag: 'wx' });
        }
      }
      count++;
    }
  }
  return count;
}
