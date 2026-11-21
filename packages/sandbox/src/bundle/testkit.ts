// Test helpers for dependency bundles. Not exported from the package index.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';

export async function rawTar(
  entries: { name: string; type?: tar.Header['type']; data?: Buffer | string; linkname?: string }[],
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (c: unknown) => chunks.push(c as Buffer));
  const done = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve);
    pack.on('error', reject);
  });
  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const type = e.type ?? 'file';
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: e.name,
          type,
          mode: 0o644,
          mtime: new Date(0),
          ...(type === 'file' ? { size: data.length } : {}),
          ...(e.linkname === undefined ? {} : { linkname: e.linkname }),
        },
        type === 'file' ? data : Buffer.alloc(0),
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** A registry-style package tarball (`package/...`, gzipped). */
export async function packageTgz(
  pkg: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<Buffer> {
  const files = [
    { name: 'package/package.json', data: JSON.stringify(pkg) },
    ...Object.entries(extra).map(([name, data]) => ({ name: `package/${name}`, data })),
  ];
  return gzipSync(await rawTar(files));
}

export const integrityOf = (data: Buffer, algo: 'sha1' | 'sha512' = 'sha512'): string =>
  `${algo}-${createHash(algo).update(data).digest('base64')}`;

export const sha256File = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

export const resolvedFor = (name: string, version: string): string =>
  `https://registry.npmjs.org/${name}/-/${name.split('/').pop() as string}-${version}.tgz`;

/** A lockfile v3 with the given `node_modules/<name>` packages. */
export function lockfile(
  packages: Record<string, Record<string, unknown>>,
  root: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'app', version: '1.0.0', ...root }, ...packages },
  });
}
