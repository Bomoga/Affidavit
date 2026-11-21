// Runs the real npm on this host against a bundle's materialized cache, with every network path
// pointed at a closed local port. It shows the cache layout and flags the jailed install step uses
// resolve dependencies with no network at all: dev dependencies for the suite build, production
// ones for the runtime image. Needs npm next to node; skipped when it is not found.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBundleFile } from './assemble.js';
import { bundleNpmArgs } from './coverage.js';
import { materializeNpmCache, openDependencyBundle, type OpenedBundle } from './open.js';
import type { BundleSection } from './plan.js';
import { integrityOf, lockfile, packageTgz, resolvedFor } from './testkit.js';

const exec = promisify(execFile);

const NPM_CLI = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  // Fedora and RHEL nodejsNN packages keep npm in a versioned lib directory.
  join(
    dirname(process.execPath),
    '..',
    'lib',
    `node_modules_${process.versions.node.split('.')[0]}`,
    'npm',
    'bin',
    'npm-cli.js',
  ),
].find((p) => existsSync(p));

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-offline-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CLOSED = 'http://127.0.0.1:9/';

async function openFixture(): Promise<{ bundle: OpenedBundle; lockText: string; pkg: string }> {
  const lib = await packageTgz(
    { name: 'runtime-lib', version: '1.0.0' },
    { 'index.js': 'module.exports = "runtime"' },
  );
  const tool = await packageTgz(
    { name: 'suite-tool', version: '2.0.0' },
    { 'index.js': 'module.exports = "suite"' },
  );
  const deps = {
    dependencies: { 'runtime-lib': '1.0.0' },
    devDependencies: { 'suite-tool': '2.0.0' },
  };
  const lockText = lockfile(
    {
      'node_modules/runtime-lib': {
        version: '1.0.0',
        resolved: resolvedFor('runtime-lib', '1.0.0'),
        integrity: integrityOf(lib),
      },
      'node_modules/suite-tool': {
        version: '2.0.0',
        resolved: resolvedFor('suite-tool', '2.0.0'),
        // A sha1-only pin, as many older lockfiles have (NodeGoat's among them).
        integrity: integrityOf(tool, 'sha1'),
        dev: true,
      },
    },
    deps,
  );
  const tarballs = new Map([
    ['node_modules/runtime-lib', lib],
    ['node_modules/suite-tool', tool],
  ]);
  const bundles = join(root, 'bundles');
  mkdirSync(bundles);
  const file = join(bundles, 'b.tar');
  const built = await assembleBundleFile(
    {
      app: 'testapp',
      commit: 'c'.repeat(40),
      lockText,
      tarballFor: (p) => Promise.resolve(tarballs.get(p.path) ?? null),
    },
    file,
  );
  const opened = await openDependencyBundle(
    { path: file, sha256: built.sha256, allowedRoot: bundles },
    join(root, 'w'),
  );
  if (!opened.ok) throw new Error(opened.reason);
  return {
    bundle: opened.bundle,
    lockText,
    pkg: JSON.stringify({ name: 'app', version: '1.0.0', ...deps }),
  };
}

async function install(
  fx: Awaited<ReturnType<typeof openFixture>>,
  mounted: readonly BundleSection[],
  installFor: readonly BundleSection[],
): Promise<{ ok: boolean; app: string; out: string }> {
  const cache = join(root, `cache-${mounted.join('-')}-${installFor.join('-')}`);
  await materializeNpmCache(fx.bundle, mounted, cache);
  const app = join(root, `app-${mounted.join('-')}-${installFor.join('-')}`);
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), fx.pkg);
  writeFileSync(join(app, 'package-lock.json'), fx.lockText);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^npm_/i.test(k) && !/proxy/i.test(k)) env[k] = v;
  }
  Object.assign(env, {
    npm_config_cache: cache,
    npm_config_registry: CLOSED,
    npm_config_userconfig: join(root, 'empty-npmrc'),
    HTTP_PROXY: CLOSED,
    HTTPS_PROXY: CLOSED,
    ...(installFor.includes('dev') ? {} : { NODE_ENV: 'production' }),
  });
  writeFileSync(join(root, 'empty-npmrc'), '');
  try {
    const r = await exec(process.execPath, [NPM_CLI as string, ...bundleNpmArgs(installFor)], {
      cwd: app,
      env,
      timeout: 120_000,
    });
    return { ok: true, app, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, app, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe.runIf(NPM_CLI !== undefined)(
  'offline install from a bundle (host npm, no network)',
  () => {
    it('the suite build resolves a devDependency from the bundle with no network', async () => {
      const fx = await openFixture();
      const r = await install(fx, ['production', 'dev'], ['production', 'dev']);
      expect(r.out).not.toMatch(/ECONNREFUSED|ENOTCACHED/);
      expect(r.ok).toBe(true);
      expect(existsSync(join(r.app, 'node_modules', 'suite-tool', 'index.js'))).toBe(true);
      expect(existsSync(join(r.app, 'node_modules', 'runtime-lib', 'index.js'))).toBe(true);
    }, 180_000);

    it('the runtime build installs production only, and never sees the dev section', async () => {
      const fx = await openFixture();
      const r = await install(fx, ['production'], ['production']);
      expect(r.ok).toBe(true);
      expect(existsSync(join(r.app, 'node_modules', 'runtime-lib', 'index.js'))).toBe(true);
      expect(existsSync(join(r.app, 'node_modules', 'suite-tool'))).toBe(false);
    }, 180_000);

    it('fails, rather than fetching, when a needed section was not mounted', async () => {
      const fx = await openFixture();
      const r = await install(fx, ['production'], ['production', 'dev']);
      expect(r.ok).toBe(false);
      expect(existsSync(join(r.app, 'node_modules', 'suite-tool', 'index.js'))).toBe(false);
    }, 180_000);
  },
);
