import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBundleFile } from './assemble.js';
import { pinnedDependencyBundle } from './pins.js';
import { integrityOf, lockfile, packageTgz, resolvedFor } from './testkit.js';

let root = '';
beforeEach(async () => {
  // The real path as the code resolves it (on Windows that expands 8.3 short names).
  root = await realpath(mkdtempSync(join(tmpdir(), 'affidavit-pins-')));
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
  // The configured store root, with the bundle in a folder below it.
  const storeRoot = join(root, 'store');
  const bundles = join(storeRoot, 'nodegoat');
  mkdirSync(bundles, { recursive: true });
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
  return { file, pins, pin, sha: built.sha256, storeRoot };
}

describe('pinnedDependencyBundle', () => {
  it('returns a ref with the pinned digest and the configured store root as the allowed root', async () => {
    const s = await setup();
    s.pin(s.sha);
    await expect(
      pinnedDependencyBundle({
        app: 'testapp',
        commit,
        path: s.file,
        storeRoot: s.storeRoot,
        pinsFile: s.pins,
      }),
    ).resolves.toEqual({ path: s.file, sha256: s.sha, allowedRoot: s.storeRoot });
  });

  it('fails closed on a null pin, telling a human to build and review the bundle', async () => {
    const s = await setup();
    s.pin(null);
    await expect(
      pinnedDependencyBundle({
        app: 'testapp',
        commit,
        path: s.file,
        storeRoot: s.storeRoot,
        pinsFile: s.pins,
      }),
    ).rejects.toThrow(
      /no pinned dependency bundle for testapp.*a human must run .*build-dependency-bundle.*review the manifest/s,
    );
  });

  it('fails closed when the file does not match the pin', async () => {
    const s = await setup();
    const other = 'd'.repeat(64);
    s.pin(other);
    await expect(
      pinnedDependencyBundle({
        app: 'testapp',
        commit,
        path: s.file,
        storeRoot: s.storeRoot,
        pinsFile: s.pins,
      }),
    ).rejects.toThrow(
      new RegExp(`sha256 ${s.sha} does not match the pinned ${other}.*a human must`, 's'),
    );
  });

  it('refuses a bundle outside the configured store root, even with the right digest', async () => {
    const s = await setup();
    s.pin(s.sha);
    const outside = join(root, 'elsewhere');
    mkdirSync(outside);
    await expect(
      pinnedDependencyBundle({
        app: 'testapp',
        commit,
        path: s.file,
        storeRoot: outside,
        pinsFile: s.pins,
      }),
    ).rejects.toThrow(/outside the dependency bundle store/);
    await expect(
      pinnedDependencyBundle({
        app: 'testapp',
        commit,
        path: s.file,
        storeRoot: 'relative/store',
        pinsFile: s.pins,
      }),
    ).rejects.toThrow(/absolute/);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses a symlink in the store that points to a copy outside it',
    async () => {
      const s = await setup();
      s.pin(s.sha);
      const outside = join(root, 'outside.tar');
      copyFileSync(s.file, outside);
      const link = join(s.storeRoot, 'link.tar');
      symlinkSync(outside, link);
      await expect(
        pinnedDependencyBundle({
          app: 'testapp',
          commit,
          path: link,
          storeRoot: s.storeRoot,
          pinsFile: s.pins,
        }),
      ).rejects.toThrow(/outside the dependency bundle store/);
    },
  );
});
