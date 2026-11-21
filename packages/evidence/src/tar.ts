import { Readable } from 'node:stream';
import { extract, pack } from 'tar-stream';
import { BundleIntegrityError } from './errors.js';

export interface TarLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_TAR_LIMITS: Readonly<TarLimits> = {
  maxEntries: 4096,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/**
 * Names allowed inside a bundle: relative, slash-separated, each segment starting with a letter or
 * digit. That rules out absolute paths, `.` and `..`, backslashes and control characters.
 */
export const SAFE_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}){0,3}$/;

/** Fixed header fields, so the same files always give the same tar bytes (and digest). */
const EPOCH = new Date(0);

/** Writes regular files in name order with fixed metadata. */
export async function writeTar(
  files: readonly { name: string; bytes: Uint8Array }[],
): Promise<Uint8Array> {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set<string>();
  for (const f of sorted) {
    if (!SAFE_NAME.test(f.name)) throw new Error(`unsafe bundle file name: ${f.name}`);
    if (seen.has(f.name)) throw new Error(`duplicate bundle file name: ${f.name}`);
    seen.add(f.name);
  }
  const p = pack();
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const chunk of p) chunks.push(chunk as Buffer);
  })();
  for (const f of sorted) {
    await new Promise<void>((resolve, reject) => {
      p.entry(
        {
          name: f.name,
          size: f.bytes.byteLength,
          mode: 0o644,
          uid: 0,
          gid: 0,
          uname: '',
          gname: '',
          mtime: EPOCH,
          type: 'file',
        },
        Buffer.from(f.bytes),
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
  p.finalize();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Reads a bundle tar into memory without touching the filesystem. Anything that is not a plain
 * regular file with a safe name, a duplicate name, or an entry over the limits is refused; the
 * bytes are untrusted until the manifest digests check out.
 */
export async function readTar(
  bytes: Uint8Array,
  limits: Readonly<TarLimits> = DEFAULT_TAR_LIMITS,
): Promise<Map<string, Uint8Array>> {
  if (bytes.byteLength > limits.maxTotalBytes) {
    throw new BundleIntegrityError(undefined, 'bundle is larger than the size limit');
  }
  const files = new Map<string, Uint8Array>();
  const ex = extract();
  Readable.from([Buffer.from(bytes)]).pipe(ex);
  let total = 0;
  try {
    for await (const entry of ex) {
      const { name, type, size } = entry.header;
      if (type !== 'file') {
        throw new BundleIntegrityError(
          undefined,
          `bundle entry ${JSON.stringify(name)} is not a regular file`,
        );
      }
      if (!SAFE_NAME.test(name)) {
        throw new BundleIntegrityError(
          undefined,
          `bundle entry name ${JSON.stringify(name)} is not allowed`,
        );
      }
      if (files.has(name))
        throw new BundleIntegrityError(undefined, `bundle entry ${name} appears twice`);
      if (files.size + 1 > limits.maxEntries) {
        throw new BundleIntegrityError(undefined, 'bundle has too many entries');
      }
      if ((size ?? 0) > limits.maxEntryBytes) {
        throw new BundleIntegrityError(
          undefined,
          `bundle entry ${name} is larger than the size limit`,
        );
      }
      const chunks: Buffer[] = [];
      let got = 0;
      for await (const raw of entry) {
        const chunk = raw as Buffer;
        got += chunk.byteLength;
        total += chunk.byteLength;
        if (got > limits.maxEntryBytes || total > limits.maxTotalBytes) {
          throw new BundleIntegrityError(
            undefined,
            `bundle entry ${name} is larger than the size limit`,
          );
        }
        chunks.push(chunk);
      }
      files.set(name, new Uint8Array(Buffer.concat(chunks)));
    }
  } catch (err) {
    ex.destroy();
    if (err instanceof BundleIntegrityError) throw err;
    throw new BundleIntegrityError(
      undefined,
      `bundle is not a readable tar archive (${(err as Error).message})`,
    );
  }
  if (files.size === 0) throw new BundleIntegrityError(undefined, 'bundle is empty');
  return files;
}
