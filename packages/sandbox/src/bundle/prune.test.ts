import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBundle, assembleBundleFile } from './assemble.js';
import { bundleCoverageProblem } from './coverage.js';
import { parseBundleManifest } from './format.js';
import { pruneExcludedDev, readBundleExclusions } from './prune.js';
import { integrityOf, lockfile, packageTgz, resolvedFor } from './testkit.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-prune-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const h = (s: string) => integrityOf(Buffer.from(s));
const pkgText = JSON.stringify({
  name: 'app',
  version: '1.0.0',
  dependencies: { lib: '1.0.0' },
  devDependencies: {
    mocha: '1.0.0',
    cypress: '3.3.1',
    'grunt-if': 'https://github.com/x/grunt-if/tarball/master',
  },
});
const lockText = lockfile(
  {
    'node_modules/lib': {
      version: '1.0.0',
      resolved: resolvedFor('lib', '1.0.0'),
      integrity: h('lib'),
    },
    'node_modules/mocha': {
      version: '1.0.0',
      resolved: resolvedFor('mocha', '1.0.0'),
      integrity: h('mocha'),
      dev: true,
      dependencies: { shared: '1.0.0' },
    },
    'node_modules/cypress': {
      version: '3.3.1',
      resolved: resolvedFor('cypress', '3.3.1'),
      integrity: h('cypress'),
      dev: true,
      hasInstallScript: true,
      dependencies: { shared: '1.0.0', 'cy-only': '1.0.0' },
    },
    'node_modules/cypress/node_modules/nested': {
      version: '1.0.0',
      resolved: resolvedFor('nested', '1.0.0'),
      integrity: h('n'),
      dev: true,
    },
    'node_modules/cy-only': {
      version: '1.0.0',
      resolved: resolvedFor('cy-only', '1.0.0'),
      integrity: h('c'),
      dev: true,
    },
    'node_modules/shared': {
      version: '1.0.0',
      resolved: resolvedFor('shared', '1.0.0'),
      integrity: h('s'),
      dev: true,
    },
    'node_modules/grunt-if': {
      version: '0.2.0',
      resolved: 'https://github.com/x/grunt-if/tarball/master',
      integrity: h('g'),
      dev: true,
    },
  },
  {
    dependencies: { lib: '1.0.0' },
    devDependencies: {
      mocha: '1.0.0',
      cypress: '3.3.1',
      'grunt-if': 'https://github.com/x/grunt-if/tarball/master',
    },
  },
);
const EXCLUDE = [
  { name: 'cypress', version: '3.3.1', reason: 'e2e only; postinstall downloads a binary' },
  { name: 'grunt-if', version: '0.2.0', reason: 'git tarball; only the security task uses it' },
];

describe('pruneExcludedDev', () => {
  it('removes excluded dev packages, their subtrees and what only they used, from lockfile and package.json', () => {
    const r = pruneExcludedDev(lockText, pkgText, EXCLUDE);
    if (!r.ok) throw new Error(r.reason);
    const lock = JSON.parse(r.lockText) as {
      packages: Record<string, { devDependencies?: object }>;
    };
    expect(Object.keys(lock.packages).sort()).toEqual([
      '',
      'node_modules/lib',
      'node_modules/mocha',
      'node_modules/shared',
    ]);
    expect(lock.packages['']?.devDependencies).toEqual({ mocha: '1.0.0' });
    expect((JSON.parse(r.pkgText) as { devDependencies: object }).devDependencies).toEqual({
      mocha: '1.0.0',
    });
    expect(r.removed.sort()).toEqual([
      'node_modules/cy-only',
      'node_modules/cypress',
      'node_modules/cypress/node_modules/nested',
      'node_modules/grunt-if',
    ]);
  });

  it('also prunes the v1 dependencies tree a v2 lockfile carries (npm 6 reads only that)', () => {
    const v2 = JSON.parse(lockText) as Record<string, unknown>;
    v2.lockfileVersion = 2;
    v2.dependencies = {
      lib: { version: '1.0.0' },
      cypress: {
        version: '3.3.1',
        dev: true,
        dependencies: { nested: { version: '1.0.0', dev: true } },
      },
      'cy-only': { version: '1.0.0', dev: true },
      mocha: { version: '1.0.0', dev: true },
      shared: { version: '1.0.0', dev: true },
      'grunt-if': { version: 'https://github.com/x/grunt-if/tarball/master', dev: true },
    };
    const r = pruneExcludedDev(JSON.stringify(v2), pkgText, EXCLUDE);
    if (!r.ok) throw new Error(r.reason);
    expect(
      Object.keys((JSON.parse(r.lockText) as { dependencies: object }).dependencies).sort(),
    ).toEqual(['lib', 'mocha', 'shared']);
  });

  it('refuses an exclusion that matches nothing (a stale list), or a production package', () => {
    expect(
      pruneExcludedDev(lockText, pkgText, [{ name: 'cypress', version: '9.9.9', reason: 'x' }]),
    ).toEqual({
      ok: false,
      reason: 'dev exclusion cypress@9.9.9 matches nothing in the lockfile',
    });
    expect(
      pruneExcludedDev(lockText, pkgText, [{ name: 'lib', version: '1.0.0', reason: 'x' }]),
    ).toEqual({
      ok: false,
      reason: 'dev exclusion lib@1.0.0 is not a dev-only package (node_modules/lib)',
    });
  });

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'refuses when a kept package needs an excluded one (%s), naming both',
    (field) => {
      const lock = JSON.parse(lockText) as {
        packages: Record<string, unknown>;
      };
      lock.packages['node_modules/cypress-plugin'] = {
        version: '1.0.0',
        resolved: resolvedFor('cypress-plugin', '1.0.0'),
        integrity: h('p'),
        dev: true,
        [field]: { cypress: '3.3.1' },
      };
      (lock.packages[''] as { devDependencies: Record<string, string> }).devDependencies[
        'cypress-plugin'
      ] = '1.0.0';
      expect(pruneExcludedDev(JSON.stringify(lock), pkgText, EXCLUDE)).toEqual({
        ok: false,
        reason:
          'dev exclusion cypress@3.3.1 is needed by kept package cypress-plugin@1.0.0 (node_modules/cypress-plugin)',
      });
    },
  );

  it('refuses exclusions on a v1-only lockfile', () => {
    expect(
      pruneExcludedDev(JSON.stringify({ lockfileVersion: 1, dependencies: {} }), pkgText, EXCLUDE),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe('bundles with a reviewed dev exclusion list', () => {
  async function input(excludedDev = EXCLUDE) {
    const names = ['lib', 'mocha', 'shared'];
    const tarballs = new Map<string, Buffer>();
    const packages: Record<string, Record<string, unknown>> = {};
    for (const n of names) {
      const t = await packageTgz({ name: n, version: '1.0.0' });
      tarballs.set(`node_modules/${n}`, t);
      packages[`node_modules/${n}`] = {
        version: '1.0.0',
        resolved: resolvedFor(n, '1.0.0'),
        integrity: integrityOf(t),
        ...(n === 'lib' ? {} : { dev: true }),
        ...(n === 'mocha' ? { dependencies: { shared: '1.0.0' } } : {}),
      };
    }
    const cypress = await packageTgz({
      name: 'cypress',
      version: '3.3.1',
      scripts: { postinstall: 'download' },
    });
    packages['node_modules/cypress'] = {
      version: '3.3.1',
      resolved: resolvedFor('cypress', '3.3.1'),
      integrity: integrityOf(cypress),
      dev: true,
      hasInstallScript: true,
    };
    packages['node_modules/grunt-if'] = {
      version: '0.2.0',
      resolved: 'https://github.com/x/grunt-if/tarball/master',
      integrity: h('g'),
      dev: true,
    };
    const devDependencies = {
      mocha: '1.0.0',
      cypress: '3.3.1',
      'grunt-if': 'https://github.com/x/grunt-if/tarball/master',
    };
    const lock = lockfile(packages, { dependencies: { lib: '1.0.0' }, devDependencies });
    const pkg = JSON.stringify({
      name: 'app',
      version: '1.0.0',
      dependencies: { lib: '1.0.0' },
      devDependencies,
    });
    const fetched: string[] = [];
    return {
      lock,
      pkg,
      fetched,
      input: {
        app: 'testapp',
        commit: 'c'.repeat(40),
        lockText: lock,
        pkgText: pkg,
        excludedDev,
        tarballFor: (p: { path: string }) => {
          fetched.push(p.path);
          return Promise.resolve(tarballs.get(p.path) ?? null);
        },
      },
    };
  }

  it('builds an ok dev section without the excluded packages, listing them in the manifest', async () => {
    const fx = await input();
    const { manifest } = await assembleBundle(fx.input);
    const dev = manifest.sections.dev;
    expect(dev.status).toBe('ok');
    expect(dev.excluded).toEqual(EXCLUDE);
    expect(dev.status === 'ok' && dev.packages.map((p) => p.path).sort()).toEqual([
      'node_modules/mocha',
      'node_modules/shared',
    ]);
    expect(fx.fetched).not.toContain('node_modules/cypress');
    // The manifest round-trips with the list, under its section digest.
    expect(parseBundleManifest(JSON.stringify(manifest)).ok).toBe(true);
  });

  it('makes the exclusion list part of the bundle digest', async () => {
    const a = await input();
    const b = await input([
      ...EXCLUDE.slice(0, 1),
      { ...EXCLUDE[1]!, reason: 'a different reason' },
    ]);
    const ra = await assembleBundleFile(a.input, join(root, 'a.tar'));
    const rb = await assembleBundleFile(b.input, join(root, 'b.tar'));
    expect(ra.sha256).not.toBe(rb.sha256);
    expect(ra.manifest.sections.dev.sha256).not.toBe(rb.manifest.sections.dev.sha256);
  });

  it('a manifest that drops the exclusion list fails its section digest', async () => {
    const fx = await input();
    const { manifest } = await assembleBundle(fx.input);
    const { excluded: _x, ...devWithout } = manifest.sections.dev;
    void _x;
    expect(
      parseBundleManifest(
        JSON.stringify({ ...manifest, sections: { ...manifest.sections, dev: devWithout } }),
      ),
    ).toEqual({ ok: false, reason: 'manifest section dev digest does not match' });
  });

  it('suite coverage passes on the pruned lockfile and fails on the unpruned one', async () => {
    const fx = await input();
    const { manifest } = await assembleBundle(fx.input);
    const pruned = pruneExcludedDev(fx.lock, fx.pkg, EXCLUDE);
    if (!pruned.ok) throw new Error(pruned.reason);
    expect(bundleCoverageProblem(pruned.lockText, manifest, ['production', 'dev'])).toBeNull();
    expect(bundleCoverageProblem(fx.lock, manifest, ['production', 'dev'])).not.toBeNull();
  });

  it('refuses an exclusion with no reason', async () => {
    const fx = await input([{ name: 'cypress', version: '3.3.1', reason: '' }]);
    await expect(assembleBundle(fx.input)).rejects.toThrow(/reason/);
  });
});

describe('readBundleExclusions', () => {
  it('reads the reviewed list for an app at its commit, and refuses a commit mismatch', () => {
    const file = join(root, 'x.json');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ apps: [{ app: 'nodegoat', commit: 'a'.repeat(40), excludedDev: EXCLUDE }] }),
    );
    expect(readBundleExclusions('nodegoat', 'a'.repeat(40), file)).toEqual(EXCLUDE);
    expect(readBundleExclusions('other', 'a'.repeat(40), file)).toEqual([]);
    expect(() => readBundleExclusions('nodegoat', 'b'.repeat(40), file)).toThrow(/commit/);
  });

  it('the shipped list parses', () => {
    expect(
      Array.isArray(readBundleExclusions('nodegoat', 'c5cb68a7084e4ae7dcc60e6a98768720a81841e8')),
    ).toBe(true);
  });
});
