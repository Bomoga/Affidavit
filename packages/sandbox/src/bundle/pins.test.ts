import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBundleFile } from './assemble.js';
import { pinnedDependencyBundle } from './pins.js';
import { integrityOf, lockfile, packageTgz, resolvedFor } from './testkit.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-pins-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const commit = 'c'.repeat(40);

async function setup() {
  const t = await packageTgz({ name: 'lib', version: '1.0.0' });
  const lockText = lockfile(
    {
      'node_modules/lib': {
        version: '1.0.0',
        resolved: resolvedFor('lib', '1.0.0'),
        integrity: integrityOf(t),
      },
    },
    { dependencies: { lib: '1.0.0' } },
  );
  const bundles = join(root, 'bundles');
  mkdirSync(bundles);
  const file = join(bundles, 'b.tar');
  const built = await assembleBundleFile(
    { app: 'testapp', commit, lockText, tarballFor: () => Promise.resolve(t) },
    file,
  );
  const pins = join(root, 'pins.json');
  const pin = (bundleSha256: string | null) =>
    writeFileSync(
      pins,
      JSON.stringify({ pins: [{ app: 'testapp', commit, bundleSha256, note: 'n' }] }),
    );
  return { file, pins, pin, sha: built.sha256, bundles };
}

describe('pinnedDependencyBundle', () => {
  it('returns a ref with the pinned digest and the bundle directory as the allowed root', async () => {
    const s = await setup();
    s.pin(s.sha);
    await expect(
      pinnedDependencyBundle({ app: 'testapp', commit, path: s.file, pinsFile: s.pins }),
    ).resolves.toEqual({ path: s.file, sha256: s.sha, allowedRoot: s.bundles });
  });

  it('fails closed on a null pin, telling a human to build and review the bundle', async () => {
    const s = await setup();
    s.pin(null);
    await expect(
      pinnedDependencyBundle({ app: 'testapp', commit, path: s.file, pinsFile: s.pins }),
    ).rejects.toThrow(
      /no pinned dependency bundle for testapp.*a human must run .*build-dependency-bundle.*review the manifest/s,
    );
  });

  it('fails closed when the file does not match the pin', async () => {
    const s = await setup();
    const other = 'd'.repeat(64);
    s.pin(other);
    await expect(
      pinnedDependencyBundle({ app: 'testapp', commit, path: s.file, pinsFile: s.pins }),
    ).rejects.toThrow(
      new RegExp(`sha256 ${s.sha} does not match the pinned ${other}.*a human must`, 's'),
    );
  });
});
