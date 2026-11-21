import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBundle, assembleBundleFile } from './assemble.js';
import {
  DEPENDENCY_MOUNT,
  bundleCoverageProblem,
  bundleInstallCommand,
  dependencyBundleToolVersions,
} from './coverage.js';
import {
  BUNDLE_SCHEMA,
  makeSection,
  parseBundleManifest,
  sectionDigest,
  type DependencyBundleManifest,
} from './format.js';
import { parseIntegrity } from './integrity.js';
import { inspectPackageTarball } from './inspect.js';
import {
  DEPENDENCY_BUNDLE_CAPS,
  materializeNpmCache,
  openDependencyBundle,
  type DependencyBundleRef,
} from './open.js';
import { readDependencyBundlePins } from './pins.js';
import { planLockfile } from './plan.js';
import { integrityOf, lockfile, packageTgz, rawTar, resolvedFor, sha256File } from './testkit.js';

let root = '';
let bundles = '';
let work = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-bundle-'));
  bundles = join(root, 'bundles');
  work = join(root, 'work');
  mkdirSync(bundles);
  mkdirSync(work);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const COMMIT = 'c'.repeat(40);

interface Fixture {
  lockText: string;
  tarballs: Map<string, Buffer>;
}

/** `left` (production) and `right` (dev), each a real tarball pinned by sha512 in the lockfile. */
async function fixture(extra: Record<string, Record<string, unknown>> = {}): Promise<Fixture> {
  const left = await packageTgz(
    { name: 'left', version: '1.0.0' },
    { 'index.js': 'module.exports=1' },
  );
  const right = await packageTgz(
    { name: 'right', version: '2.0.0' },
    { 'index.js': 'module.exports=2' },
  );
  const lockText = lockfile(
    {
      'node_modules/left': {
        version: '1.0.0',
        resolved: resolvedFor('left', '1.0.0'),
        integrity: integrityOf(left),
      },
      'node_modules/right': {
        version: '2.0.0',
        resolved: resolvedFor('right', '2.0.0'),
        integrity: integrityOf(right),
        dev: true,
      },
      ...extra,
    },
    { dependencies: { left: '1.0.0' }, devDependencies: { right: '2.0.0' } },
  );
  return {
    lockText,
    tarballs: new Map([
      ['node_modules/left', left],
      ['node_modules/right', right],
    ]),
  };
}

async function build(fx: Fixture, name = 'b.tar') {
  const file = join(bundles, name);
  const out = await assembleBundleFile(
    {
      app: 'testapp',
      commit: COMMIT,
      lockText: fx.lockText,
      tarballFor: (p) => Promise.resolve(fx.tarballs.get(p.path) ?? null),
    },
    file,
  );
  return { file, ...out };
}

const ref = (file: string, sha256: string): DependencyBundleRef => ({
  path: file,
  sha256,
  allowedRoot: bundles,
});

/** Writes a crafted tar into the bundle root and returns a ref pinned to its real digest. */
async function crafted(entries: Parameters<typeof rawTar>[0]): Promise<DependencyBundleRef> {
  const file = join(bundles, 'crafted.tar');
  writeFileSync(file, await rawTar(entries));
  return ref(file, sha256File(file));
}

async function manifestFor(fx: Fixture): Promise<DependencyBundleManifest> {
  return (
    await assembleBundle({
      app: 'testapp',
      commit: COMMIT,
      lockText: fx.lockText,
      tarballFor: (p) => Promise.resolve(fx.tarballs.get(p.path) ?? null),
    })
  ).manifest;
}

describe('planLockfile', () => {
  it('splits production and dev packages and keeps the lockfile pins verbatim', async () => {
    const fx = await fixture();
    const read = planLockfile(fx.lockText);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.plan.packages.map((p) => [p.path, p.section])).toEqual([
      ['node_modules/left', 'production'],
      ['node_modules/right', 'dev'],
    ]);
    expect(read.plan.problems).toEqual({ production: [], dev: [] });
  });

  it('names a package with no integrity hash', () => {
    const read = planLockfile(
      lockfile({ 'node_modules/x': { version: '1.0.0', resolved: resolvedFor('x', '1.0.0') } }),
    );
    expect(read.ok && read.plan.problems.production).toEqual([
      'node_modules/x (x@1.0.0) has no integrity hash',
    ]);
  });

  it('names a package the lockfile says has install scripts', () => {
    const read = planLockfile(
      lockfile({
        'node_modules/native': {
          version: '3.0.0',
          resolved: resolvedFor('native', '3.0.0'),
          integrity: integrityOf(Buffer.from('x')),
          hasInstallScript: true,
        },
      }),
    );
    expect(read.ok && read.plan.problems.production[0]).toMatch(
      /^node_modules\/native \(native@3\.0\.0\) has install scripts/,
    );
  });

  it('names git and non-registry sources, in the section they belong to', () => {
    const read = planLockfile(
      lockfile({
        'node_modules/g': {
          version: '1.0.0',
          resolved: 'https://github.com/a/g/tarball/master',
          integrity: integrityOf(Buffer.from('g')),
          dev: true,
        },
      }),
    );
    expect(read.ok && read.plan.problems).toEqual({
      production: [],
      dev: ['node_modules/g (g@1.0.0) resolves outside the npm registry'],
    });
  });

  it('skips an optional package for another OS and its bundled children, as npm does on Linux', () => {
    const read = planLockfile(
      lockfile({
        'node_modules/fsevents': {
          version: '1.2.9',
          resolved: resolvedFor('fsevents', '1.2.9'),
          integrity: integrityOf(Buffer.from('f')),
          hasInstallScript: true,
          optional: true,
          os: ['darwin'],
        },
        'node_modules/fsevents/node_modules/abbrev': {
          version: '1.1.1',
          inBundle: true,
          optional: true,
        },
      }),
    );
    expect(read.ok && read.plan.packages).toEqual([]);
    expect(read.ok && read.plan.skipped.map((s) => s.path)).toEqual(['node_modules/fsevents']);
    expect(read.ok && read.plan.problems.production).toEqual([]);
  });

  it('reads a v1 lockfile tree', () => {
    const data = Buffer.from('v1');
    const read = planLockfile(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          a: {
            version: '1.0.0',
            resolved: resolvedFor('a', '1.0.0'),
            integrity: integrityOf(data, 'sha1'),
            dependencies: {
              b: {
                version: '2.0.0',
                resolved: resolvedFor('b', '2.0.0'),
                integrity: integrityOf(data),
                dev: true,
              },
            },
          },
        },
      }),
    );
    expect(read.ok && read.plan.packages.map((p) => [p.path, p.section])).toEqual([
      ['node_modules/a', 'production'],
      ['node_modules/a/node_modules/b', 'dev'],
    ]);
  });
});

describe('inspectPackageTarball', () => {
  it('finds lifecycle scripts and an implicit node-gyp build', async () => {
    const scripted = await packageTgz({
      name: 's',
      version: '1.0.0',
      scripts: { postinstall: 'node x' },
    });
    const gyp = await packageTgz({ name: 'g', version: '1.0.0' }, { 'binding.gyp': '{}' });
    const plain = await packageTgz({ name: 'p', version: '1.0.0', scripts: { test: 'x' } });
    const caps = DEPENDENCY_BUNDLE_CAPS.maxUnpackedPackageBytes;
    expect(await inspectPackageTarball(scripted, caps)).toMatchObject({
      ok: true,
      info: { installScripts: ['postinstall'] },
    });
    expect(await inspectPackageTarball(gyp, caps)).toMatchObject({
      ok: true,
      info: { installScripts: ['binding.gyp'] },
    });
    expect(await inspectPackageTarball(plain, caps)).toMatchObject({
      ok: true,
      info: { installScripts: [] },
    });
  });

  it('refuses a tarball that unpacks past the cap', async () => {
    const big = await packageTgz(
      { name: 'b', version: '1.0.0' },
      { 'big.txt': 'x'.repeat(100_000) },
    );
    expect(await inspectPackageTarball(big, 10_000)).toEqual({
      ok: false,
      reason: 'unpacks to more than 10000 bytes',
    });
  });
});

describe('assembleBundle', () => {
  it('builds both sections, each with its own digest, deterministically', async () => {
    const fx = await fixture();
    const a = await build(fx, 'a.tar');
    const b = await build(fx, 'b.tar');
    expect(a.sha256).toBe(b.sha256);
    expect(readFileSync(a.file).equals(readFileSync(b.file))).toBe(true);
    const { production, dev } = a.manifest.sections;
    expect(production.status).toBe('ok');
    expect(dev.status).toBe('ok');
    expect(production.sha256).not.toBe(dev.sha256);
    expect(sectionDigest(production)).toBe(production.sha256);
  });

  it('makes a section unsupported, naming the package, when a tarball needs an install script', async () => {
    const fx = await fixture();
    const native = await packageTgz({
      name: 'native',
      version: '1.0.0',
      scripts: { install: 'node-gyp rebuild' },
    });
    const withNative = await fixture({
      'node_modules/native': {
        version: '1.0.0',
        resolved: resolvedFor('native', '1.0.0'),
        integrity: integrityOf(native),
        dev: true,
      },
    });
    withNative.tarballs.set('node_modules/native', native);
    const { manifest, tarballs } = await assembleBundle({
      app: 'testapp',
      commit: COMMIT,
      lockText: withNative.lockText,
      tarballFor: (p) => Promise.resolve(withNative.tarballs.get(p.path) ?? null),
    });
    expect(manifest.sections.production.status).toBe('ok');
    const dev = manifest.sections.dev;
    expect(dev.status).toBe('unsupported');
    expect(dev.status === 'unsupported' && dev.reason).toContain(
      'node_modules/native (native@1.0.0) needs install scripts (install)',
    );
    // Nothing from the unsupported section is shipped.
    expect(
      [...tarballs.values()].some((t) => t.equals(fx.tarballs.get('node_modules/right') as Buffer)),
    ).toBe(false);
  });

  it('names a fetched tarball that does not match its lockfile integrity', async () => {
    const fx = await fixture();
    fx.tarballs.set(
      'node_modules/left',
      await packageTgz({ name: 'left', version: '1.0.0', evil: true }),
    );
    const { manifest } = await assembleBundle({
      app: 'testapp',
      commit: COMMIT,
      lockText: fx.lockText,
      tarballFor: (p) => Promise.resolve(fx.tarballs.get(p.path) ?? null),
    });
    const prod = manifest.sections.production;
    expect(prod.status).toBe('unsupported');
    expect(prod.status === 'unsupported' && prod.reason).toContain(
      'node_modules/left (left@1.0.0) does not match its lockfile sha512 integrity',
    );
  });
});

describe('openDependencyBundle', () => {
  it('opens a bundle whose sha256 matches the pin and verifies every tarball', async () => {
    const b = await build(await fixture());
    const opened = await openDependencyBundle(ref(b.file, b.sha256), work);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.bundle.sha256).toBe(b.sha256);
    expect(opened.bundle.manifest).toEqual(b.manifest);
  });

  it('accepts a sha256: prefixed pin', async () => {
    const b = await build(await fixture());
    expect((await openDependencyBundle(ref(b.file, `sha256:${b.sha256}`), work)).ok).toBe(true);
  });

  it('refuses a bundle with the wrong digest, before using anything from it', async () => {
    const b = await build(await fixture());
    const opened = await openDependencyBundle(ref(b.file, 'f'.repeat(64)), work);
    expect(opened).toEqual({
      ok: false,
      unsupported: false,
      reason: `dependency bundle sha256 ${b.sha256} does not match the pinned ${'f'.repeat(64)}`,
    });
  });

  it('refuses a tampered tarball even when the pin is updated to match the tampered bundle', async () => {
    const fx = await fixture();
    const left = fx.tarballs.get('node_modules/left') as Buffer;
    const sha512 = parseIntegrity(integrityOf(left))?.[0]?.hex as string;
    const tampered = Buffer.from(left);
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] as number) ^ 0xff;
    const r = await crafted([
      { name: 'manifest.json', data: JSON.stringify(await manifestFor(fx)) },
      { name: `tarballs/${sha512}.tgz`, data: tampered },
    ]);
    const opened = await openDependencyBundle(r, work);
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.reason).toMatch(/does not match its sha512 \(tampered\)/);
  });

  it('refuses a tarball whose content does not match the lockfile integrity in the manifest', async () => {
    const fx = await fixture();
    const manifest = await manifestFor(fx);
    const other = await packageTgz({ name: 'left', version: '1.0.0', other: 1 });
    const otherSha = parseIntegrity(integrityOf(other))?.[0]?.hex as string;
    // A self-consistent manifest that points `left` at a different tarball under its real name.
    const prod = manifest.sections.production;
    if (prod.status !== 'ok') throw new Error('fixture');
    const swapped = makeSection({
      status: 'ok',
      packages: prod.packages.map((p) => (p.name === 'left' ? { ...p, sha512: otherSha } : p)),
    });
    const devSection = manifest.sections.dev;
    if (devSection.status !== 'ok') throw new Error('fixture');
    const right = fx.tarballs.get('node_modules/right') as Buffer;
    const r = await crafted([
      {
        name: 'manifest.json',
        data: JSON.stringify({ ...manifest, sections: { production: swapped, dev: devSection } }),
      },
      { name: `tarballs/${otherSha}.tgz`, data: other },
      { name: `tarballs/${devSection.packages[0]?.sha512 as string}.tgz`, data: right },
    ]);
    const opened = await openDependencyBundle(r, work);
    expect(!opened.ok && opened.reason).toBe(
      'dependency bundle tarball for node_modules/left does not match its lockfile sha512 integrity',
    );
  });

  it('refuses a manifest package with a missing integrity hash', async () => {
    const fx = await fixture();
    const manifest = await manifestFor(fx);
    const prod = manifest.sections.production;
    if (prod.status !== 'ok') throw new Error('fixture');
    const { integrity: _i, ...noIntegrity } = prod.packages[0] as (typeof prod.packages)[0];
    void _i;
    const r = await crafted([
      {
        name: 'manifest.json',
        data: JSON.stringify({
          ...manifest,
          sections: { ...manifest.sections, production: { ...prod, packages: [noIntegrity] } },
        }),
      },
    ]);
    const opened = await openDependencyBundle(r, work);
    expect(!opened.ok && opened.reason).toBe(
      'dependency bundle manifest package node_modules/left has a missing or malformed integrity hash',
    );
  });

  it('refuses a bundle holding a lifecycle-script package as unsupported, naming it', async () => {
    const scripted = await packageTgz({
      name: 'evil',
      version: '1.0.0',
      scripts: { postinstall: 'curl x' },
    });
    const sha512 = parseIntegrity(integrityOf(scripted))?.[0]?.hex as string;
    const manifest: DependencyBundleManifest = {
      schema: BUNDLE_SCHEMA,
      app: 'testapp',
      commit: COMMIT,
      lockfileSha256: 'a'.repeat(64),
      sections: {
        production: makeSection({
          status: 'ok',
          packages: [
            {
              path: 'node_modules/evil',
              name: 'evil',
              version: '1.0.0',
              resolved: resolvedFor('evil', '1.0.0'),
              integrity: integrityOf(scripted),
              sha512,
            },
          ],
        }),
        dev: makeSection({ status: 'ok', packages: [] }),
      },
    };
    const r = await crafted([
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: `tarballs/${sha512}.tgz`, data: scripted },
    ]);
    expect(await openDependencyBundle(r, work)).toEqual({
      ok: false,
      unsupported: true,
      reason:
        'node_modules/evil (evil@1.0.0) needs install scripts (postinstall); lifecycle scripts ' +
        'are disabled, so the target is unsupported',
    });
  });

  it.each([
    [
      'path traversal',
      { name: '../escape.tgz', data: 'x' },
      /has a path traversal entry "\.\.\/escape\.tgz"/,
    ],
    ['nested traversal', { name: 'tarballs/../../x', data: 'x' }, /path traversal/],
    ['absolute path', { name: '/etc/passwd', data: 'x' }, /has an absolute path "\/etc\/passwd"/],
    [
      'symlink',
      { name: 'tarballs/link', type: 'symlink' as const, linkname: '/etc/passwd' },
      /has a symlink entry/,
    ],
    [
      'hardlink',
      { name: 'tarballs/hard', type: 'link' as const, linkname: 'manifest.json' },
      /has a hardlink entry/,
    ],
    ['directory', { name: 'tarballs/', type: 'directory' as const }, /has a directory entry/],
    ['unexpected name', { name: 'node_modules/x/index.js', data: 'x' }, /has an unexpected entry/],
  ])('refuses a bundle with a %s entry', async (_label, entry, reason) => {
    const r = await crafted([{ name: 'manifest.json', data: '{}' }, entry]);
    const opened = await openDependencyBundle(r, work);
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.unsupported).toBe(false);
    expect(!opened.ok && opened.reason).toMatch(reason);
  });

  it('refuses duplicate entries', async () => {
    const r = await crafted([
      { name: 'manifest.json', data: '{}' },
      { name: 'manifest.json', data: '{}' },
    ]);
    expect((await openDependencyBundle(r, work)) as { reason: string }).toMatchObject({
      reason: 'dependency bundle has a duplicate entry "manifest.json"',
    });
  });

  it('refuses an oversized bundle before reading it', async () => {
    const b = await build(await fixture());
    const opened = await openDependencyBundle(ref(b.file, b.sha256), work, {
      ...DEPENDENCY_BUNDLE_CAPS,
      maxBundleBytes: 1024,
    });
    expect(opened).toEqual({
      ok: false,
      unsupported: false,
      reason: 'dependency bundle is over 1024 bytes',
    });
  });

  it('refuses an oversized tarball entry and too many entries', async () => {
    const b = await build(await fixture());
    const small = await openDependencyBundle(ref(b.file, b.sha256), work, {
      ...DEPENDENCY_BUNDLE_CAPS,
      maxTarballBytes: 10,
    });
    expect(!small.ok && small.reason).toMatch(/is over 10 bytes/);
    const few = await openDependencyBundle(ref(b.file, b.sha256), work, {
      ...DEPENDENCY_BUNDLE_CAPS,
      maxEntries: 1,
    });
    expect(!few.ok && few.reason).toBe('dependency bundle has more than 1 entries');
  });

  it('refuses a bundle outside the allowed root', async () => {
    const b = await build(await fixture());
    const outside = join(root, 'outside.tar');
    writeFileSync(outside, readFileSync(b.file));
    expect(await openDependencyBundle(ref(outside, b.sha256), work)).toMatchObject({
      ok: false,
      reason: 'dependency bundle is outside the allowed bundle root',
    });
  });

  it.runIf(process.platform !== 'win32')('refuses a bundle path that is a symlink', async () => {
    const b = await build(await fixture());
    const link = join(bundles, 'link.tar');
    symlinkSync(b.file, link);
    expect(await openDependencyBundle(ref(link, b.sha256), work)).toMatchObject({
      ok: false,
      reason: 'dependency bundle path is a symlink',
    });
  });

  it('refuses a manifest whose section digest was edited', async () => {
    const fx = await fixture();
    const manifest = await manifestFor(fx);
    const forged = {
      ...manifest,
      sections: { ...manifest.sections, dev: { ...manifest.sections.dev, sha256: 'e'.repeat(64) } },
    };
    expect(parseBundleManifest(JSON.stringify(forged))).toEqual({
      ok: false,
      reason: 'manifest section dev digest does not match',
    });
  });
});

describe('materializeNpmCache', () => {
  it('lays out only the requested sections, at npm content-cache paths derived from integrity', async () => {
    const fx = await fixture();
    const b = await build(fx);
    const opened = await openDependencyBundle(ref(b.file, b.sha256), work);
    if (!opened.ok) throw new Error(opened.reason);
    const cache = join(work, 'cache');
    expect(await materializeNpmCache(opened.bundle, ['production'], cache)).toBe(1);
    const left = parseIntegrity(integrityOf(fx.tarballs.get('node_modules/left') as Buffer))?.[0];
    const right = parseIntegrity(integrityOf(fx.tarballs.get('node_modules/right') as Buffer))?.[0];
    const at = (h: { algo: string; hex: string }) =>
      join(
        cache,
        '_cacache',
        'content-v2',
        h.algo,
        h.hex.slice(0, 2),
        h.hex.slice(2, 4),
        h.hex.slice(4),
      );
    expect(readFileSync(at(left as { algo: string; hex: string })).length).toBeGreaterThan(0);
    expect(() => readFileSync(at(right as { algo: string; hex: string }))).toThrow();
  });
});

describe('bundleCoverageProblem', () => {
  it('accepts a lockfile the bundle covers, for production and for production plus dev', async () => {
    const fx = await fixture();
    const manifest = await manifestFor(fx);
    expect(bundleCoverageProblem(fx.lockText, manifest, ['production'])).toBeNull();
    expect(bundleCoverageProblem(fx.lockText, manifest, ['production', 'dev'])).toBeNull();
  });

  it('names a package the bundle lacks or pins differently (a patch that changes a dependency)', async () => {
    const fx = await fixture();
    const manifest = await manifestFor(fx);
    const lock = JSON.parse(fx.lockText) as { packages: Record<string, Record<string, unknown>> };
    const changed = structuredClone(lock);
    (changed.packages['node_modules/left'] as Record<string, unknown>).version = '1.0.1';
    expect(bundleCoverageProblem(JSON.stringify(changed), manifest, ['production'])).toBe(
      'node_modules/left (left@1.0.1) is pinned differently in the dependency bundle',
    );
    const added = structuredClone(lock);
    added.packages['node_modules/new'] = {
      version: '1.0.0',
      resolved: resolvedFor('new', '1.0.0'),
      integrity: integrityOf(Buffer.from('n')),
    };
    expect(bundleCoverageProblem(JSON.stringify(added), manifest, ['production'])).toBe(
      "node_modules/new (new@1.0.0) is not in the dependency bundle's production section",
    );
  });

  it('refuses the dev section when the bundle marks it unsupported, but not a production build', async () => {
    const fx = await fixture();
    const manifest = await manifestFor(fx);
    const devless = {
      ...manifest,
      sections: {
        ...manifest.sections,
        dev: makeSection({
          status: 'unsupported',
          reason: 'node_modules/cypress needs install scripts',
        }),
      },
    };
    expect(bundleCoverageProblem(fx.lockText, devless, ['production'])).toBeNull();
    expect(bundleCoverageProblem(fx.lockText, devless, ['production', 'dev'])).toBe(
      "the dependency bundle's dev section is unsupported: node_modules/cypress needs install scripts",
    );
  });
});

describe('bundleInstallCommand', () => {
  const forbidden = /registry|proxy|--network|https?:|--add-host|--build-arg|--dns/;

  it('installs offline with lifecycle scripts disabled and no network option', () => {
    for (const sections of [['production'], ['production', 'dev']] as const) {
      const cmd = bundleInstallCommand(sections);
      const text = cmd.join(' ');
      expect(text).toContain('npm ci --offline --ignore-scripts');
      expect(text).toContain(`${DEPENDENCY_MOUNT}/_cacache`);
      expect(text).not.toMatch(forbidden);
    }
    expect(bundleInstallCommand(['production']).join(' ')).toContain(
      'NODE_ENV=production exec npm ci',
    );
    expect(bundleInstallCommand(['production']).join(' ')).toContain('--omit=dev');
    expect(bundleInstallCommand(['production', 'dev']).join(' ')).not.toContain('--omit=dev');
  });
});

describe('dependencyBundleToolVersions', () => {
  it('pins each variant bundle digest under toolVersions keys', () => {
    expect(
      dependencyBundleToolVersions({
        vulnerable: 'a'.repeat(64),
        safe: `sha256:${'b'.repeat(64)}`,
        patched: undefined,
      }),
    ).toEqual({
      'dependency-bundle:vulnerable': `sha256:${'a'.repeat(64)}`,
      'dependency-bundle:safe': `sha256:${'b'.repeat(64)}`,
    });
  });
});

describe('pins.json', () => {
  it('parses, and every pin is either null or a sha256', () => {
    const pins = readDependencyBundlePins();
    expect(pins.find((p) => p.app === 'nodegoat')).toBeDefined();
    for (const p of pins)
      expect(p.bundleSha256 === null || /^[0-9a-f]{64}$/.test(p.bundleSha256)).toBe(true);
  });
});
