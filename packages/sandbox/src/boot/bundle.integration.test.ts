import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootHints } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleBundleFile } from '../bundle/assemble.js';
import { pinnedBundleSha256 } from '../bundle/pins.js';
import { integrityOf, lockfile, packageTgz, resolvedFor } from '../bundle/testkit.js';
import { createCaseNetwork, removeCaseNetwork } from '../gvisor/network.js';
import { bootTarget } from './boot.js';
import { buildTarget } from './build.js';

// Sandbox-host only (gVisor and Docker): `pnpm --filter @affidavit/sandbox test:sandbox-host`.
// The NodeGoat case also needs AFFIDAVIT_NODEGOAT_DIR (a checkout at the corpus pin) and
// AFFIDAVIT_NODEGOAT_BUNDLE (the bundle tar a human built), and a digest in pins.json.
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';
const nodegoat = process.env.AFFIDAVIT_NODEGOAT_DIR;
const nodegoatBundle = process.env.AFFIDAVIT_NODEGOAT_BUNDLE;
const NODEGOAT_COMMIT = 'c5cb68a7084e4ae7dcc60e6a98768720a81841e8';

const hints: BootHints = {
  kind: 'dockerfile',
  path: 'Dockerfile',
  ports: [3000],
  healthRoute: '/health',
  healthTimeoutMs: 30_000,
  stubs: [],
  env: {},
};

describe.runIf(onSandboxHost)('dependency bundles on a sandbox host', { timeout: 900_000 }, () => {
  let root = '';
  let workRoot = '';
  let bundles = '';
  let src = '';
  let bundleFile = '';
  let bundleSha = '';

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'affidavit-bundle-host-'));
    workRoot = join(root, 'work');
    bundles = join(root, 'bundles');
    src = join(root, 'app');
    for (const d of [workRoot, bundles, src]) mkdirSync(d);
    const lib = await packageTgz(
      { name: 'answer-lib', version: '1.0.0', main: 'index.js' },
      { 'index.js': 'module.exports = 42;' },
    );
    const tool = await packageTgz(
      { name: 'suite-tool', version: '1.0.0', main: 'index.js' },
      { 'index.js': 'module.exports = "dev";' },
    );
    const deps = {
      dependencies: { 'answer-lib': '1.0.0' },
      devDependencies: { 'suite-tool': '1.0.0' },
    };
    const lockText = lockfile(
      {
        'node_modules/answer-lib': {
          version: '1.0.0',
          resolved: resolvedFor('answer-lib', '1.0.0'),
          integrity: integrityOf(lib),
        },
        'node_modules/suite-tool': {
          version: '1.0.0',
          resolved: resolvedFor('suite-tool', '1.0.0'),
          integrity: integrityOf(tool),
          dev: true,
        },
      },
      deps,
    );
    writeFileSync(
      join(src, 'Dockerfile'),
      'FROM node:22-alpine\nWORKDIR /srv\nCMD ["node", "server.js"]\n',
    );
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        scripts: { start: 'node server.js' },
        ...deps,
      }),
    );
    writeFileSync(join(src, 'package-lock.json'), lockText);
    writeFileSync(
      join(src, 'server.js'),
      `const n = require('answer-lib'); require('http').createServer((q, s) => s.end(String(n))).listen(3000);`,
    );
    const tarballs = new Map([
      ['node_modules/answer-lib', lib],
      ['node_modules/suite-tool', tool],
    ]);
    bundleFile = join(bundles, 'b.tar');
    const built = await assembleBundleFile(
      {
        app: 'testapp',
        commit: 'c'.repeat(40),
        lockText,
        tarballFor: (p) => Promise.resolve(tarballs.get(p.path) ?? null),
      },
      bundleFile,
    );
    bundleSha = built.sha256;
  });

  afterAll(() => {
    expect(readdirSync(workRoot)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('builds and boots a target whose dependency comes only from the bundle, offline', async () => {
    const build = await buildTarget(src, hints, {
      workRoot,
      dependencyBundle: { path: bundleFile, sha256: bundleSha, allowedRoot: bundles },
    });
    expect(build).toMatchObject({
      ok: true,
      dependencyBundle: { sha256: `sha256:${bundleSha}`, packages: 1 },
    });
    if (!build.ok) return;
    expect(Object.keys(build.dependencyBundle?.sections ?? {})).toEqual(['production']);
    const net = await createCaseNetwork();
    try {
      const boot = await bootTarget(net, build.imageId, build.recipe);
      expect(boot.status).toBe('healthy');
    } finally {
      await removeCaseNetwork(net);
    }
  });

  it('the suite build resolves a devDependency from the bundle with no network', async () => {
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        scripts: { start: 'node server.js', build: `node -e "require('suite-tool')"` },
        dependencies: { 'answer-lib': '1.0.0' },
        devDependencies: { 'suite-tool': '1.0.0' },
      }),
    );
    const build = await buildTarget(src, hints, {
      workRoot,
      devDependencies: true,
      dependencyBundle: { path: bundleFile, sha256: bundleSha, allowedRoot: bundles },
    });
    expect(build).toMatchObject({ ok: true, dependencyBundle: { packages: 2 } });
    expect(Object.keys((build.ok && build.dependencyBundle?.sections) || {}).sort()).toEqual([
      'dev',
      'production',
    ]);
  });

  it('refuses a bundle with the wrong digest before staging anything', async () => {
    const build = await buildTarget(src, hints, {
      workRoot,
      dependencyBundle: { path: bundleFile, sha256: '0'.repeat(64), allowedRoot: bundles },
    });
    expect(build).toMatchObject({ ok: false, unsupported: false, step: 'bundle' });
  });

  const pinned = pinnedBundleSha256('nodegoat', NODEGOAT_COMMIT);
  it.runIf(nodegoat !== undefined && nodegoatBundle !== undefined && pinned !== null)(
    'builds and boots NodeGoat from its pinned bundle',
    async () => {
      const bundleRoot = join(nodegoatBundle as string, '..');
      const build = await buildTarget(
        nodegoat as string,
        {
          kind: 'compose',
          path: 'docker-compose.yml',
          service: 'web',
          ports: [4000],
          healthRoute: '/login',
          healthTimeoutMs: 90_000,
          stubs: [],
          env: {},
        },
        {
          workRoot,
          dependencyBundle: {
            path: nodegoatBundle as string,
            sha256: pinned as string,
            allowedRoot: bundleRoot,
          },
        },
      );
      expect(build).toMatchObject({ ok: true, dependencyBundle: { sha256: `sha256:${pinned}` } });
      if (!build.ok) return;
      const net = await createCaseNetwork();
      try {
        const boot = await bootTarget(net, build.imageId, build.recipe);
        expect(boot.status).toBe('healthy');
      } finally {
        await removeCaseNetwork(net);
      }
    },
  );
});
