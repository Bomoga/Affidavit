import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootHints } from '@affidavit/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleBundle, assembleBundleFile } from '../bundle/assemble.js';
import { DEPENDENCY_MOUNT } from '../bundle/coverage.js';
import { integrityOf, lockfile, packageTgz, resolvedFor } from '../bundle/testkit.js';
import { applyDevExclusions, assembleBuildArgs, buildTarget } from './build.js';
import { deriveRecipe, recipeProblem } from './recipe.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-bundle-build-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const hints: BootHints = {
  kind: 'dockerfile',
  path: 'Dockerfile',
  ports: [3000],
  healthRoute: '/health',
  healthTimeoutMs: 30_000,
  stubs: [],
  env: {},
};

async function app(
  dir: string,
  scripts: Record<string, string> = { start: 'node server.js' },
  gitDev = false,
) {
  const lib = await packageTgz({ name: 'lib', version: '1.0.0' });
  const tool = await packageTgz({ name: 'tool', version: '1.0.0' });
  const deps = { dependencies: { lib: '1.0.0' }, devDependencies: { tool: '1.0.0' } };
  const entries = {
    'node_modules/lib': {
      version: '1.0.0',
      resolved: resolvedFor('lib', '1.0.0'),
      integrity: integrityOf(lib),
    },
    'node_modules/tool': {
      version: '1.0.0',
      resolved: resolvedFor('tool', '1.0.0'),
      integrity: integrityOf(tool),
      dev: true,
    },
  };
  const lockText = lockfile(entries, deps);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'Dockerfile'),
    'FROM node:22-alpine\nWORKDIR /srv\nCMD ["node", "server.js"]\n',
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'a', scripts, ...deps }));
  writeFileSync(join(dir, 'package-lock.json'), lockText);
  const tarballs = new Map([
    ['node_modules/lib', lib],
    ['node_modules/tool', tool],
  ]);
  const input = {
    app: 'testapp',
    commit: 'c'.repeat(40),
    lockText,
    tarballFor: (p: { path: string }) => Promise.resolve(tarballs.get(p.path) ?? null),
  };
  // The same app, written to `dir` with one more dev package that comes from git (never bundlable).
  const withGit = { ...deps, devDependencies: { ...deps.devDependencies, unbundlable: '1.0.0' } };
  const gitLock = lockfile(
    {
      ...entries,
      'node_modules/unbundlable': {
        version: '1.0.0',
        resolved: 'https://github.com/x/unbundlable/tarball/master',
        integrity: integrityOf(Buffer.from('u')),
        dev: true,
      },
    },
    withGit,
  );
  if (gitDev) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'a', scripts, ...withGit }));
    writeFileSync(join(dir, 'package-lock.json'), gitLock);
  }
  const pkgText = JSON.stringify({ name: 'a', scripts, ...withGit });
  const excludedInput = { ...input, lockText: gitLock, pkgText };
  return { input, excludedInput };
}

describe('deriveRecipe with a dependency bundle', () => {
  it('without a bundle, a target with dependencies stays unsupported', async () => {
    await app(root);
    const r = await deriveRecipe(root, hints);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/needs a dependency fetch at build time/);
  });

  it('with a covering bundle, the runtime recipe installs only the production section', async () => {
    const { input } = await app(root);
    const { manifest } = await assembleBundle(input);
    const r = await deriveRecipe(root, hints, { bundle: manifest });
    expect(r.ok && r.recipe.install).toEqual({ sections: ['production'] });
  });

  it('the suite recipe (devDependencies) installs production and dev', async () => {
    const { input } = await app(root);
    const { manifest } = await assembleBundle(input);
    const r = await deriveRecipe(root, hints, { bundle: manifest, devDependencies: true });
    expect(r.ok && r.recipe.install).toEqual({ sections: ['production', 'dev'] });
  });

  it('a build script needs the dev section too', async () => {
    const { input } = await app(root, { start: 'node server.js', build: 'tsc' });
    const { manifest } = await assembleBundle(input);
    const r = await deriveRecipe(root, hints, { bundle: manifest });
    expect(r.ok && r.recipe.install).toEqual({ sections: ['production', 'dev'] });
  });

  it("reports the target's own install scripts that --ignore-scripts skips, rather than hiding them", async () => {
    const { input } = await app(root, {
      start: 'node server.js',
      preinstall: 'node check.js',
      postinstall: 'node setup.js',
      prepare: 'husky install',
    });
    const { manifest } = await assembleBundle(input);
    const r = await deriveRecipe(root, hints, { bundle: manifest });
    expect(r.ok && r.recipe.install?.ignoredRootScripts).toEqual([
      'preinstall',
      'postinstall',
      'prepare',
    ]);
  });

  it('the suite recipe reads the lockfile with the reviewed dev exclusions pruned, and reports them', async () => {
    const { input, excludedInput } = await app(root, undefined, true);
    const excluded = [{ name: 'unbundlable', version: '1.0.0', reason: 'not used by the suite' }];
    const { manifest } = await assembleBundle({ ...excludedInput, excludedDev: excluded });
    const r = await deriveRecipe(root, hints, { bundle: manifest, devDependencies: true });
    expect(r.ok && r.recipe.install).toEqual({
      sections: ['production', 'dev'],
      excludedDev: excluded,
    });
    // The runtime recipe does not mount dev, so it has no exclusions to apply.
    const rt = await deriveRecipe(root, hints, { bundle: manifest });
    expect(rt.ok && rt.recipe.install).toEqual({ sections: ['production'] });
    // A bundle without the list does not cover the unbundlable dev package.
    const plain = await assembleBundle(input);
    const bad = await deriveRecipe(root, hints, { bundle: plain.manifest, devDependencies: true });
    expect(bad.ok).toBe(false);
  });

  it('applyDevExclusions rewrites the staged package.json and lockfile', async () => {
    await app(root, undefined, true);
    const excluded = [{ name: 'unbundlable', version: '1.0.0', reason: 'not used by the suite' }];
    const removed = await applyDevExclusions(root, excluded);
    expect(removed).toEqual(['node_modules/unbundlable']);
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, unknown>;
    };
    expect(Object.keys(lock.packages).sort()).toEqual([
      '',
      'node_modules/lib',
      'node_modules/tool',
    ]);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      devDependencies: object;
    };
    expect(pkg.devDependencies).toEqual({ tool: '1.0.0' });
    await expect(
      applyDevExclusions(root, [{ name: 'gone', version: '1.0.0', reason: 'stale entry here' }]),
    ).rejects.toThrow(/matches nothing/);
  });

  it('a recipe that installs may not work under the bundle mount', async () => {
    const { input } = await app(root);
    const { manifest } = await assembleBundle(input);
    const r = await deriveRecipe(root, hints, { bundle: manifest });
    if (!r.ok) throw new Error(r.reason);
    expect(recipeProblem({ ...r.recipe, workdir: `${DEPENDENCY_MOUNT}/app` })).toBe(
      `working directory may not be under ${DEPENDENCY_MOUNT}`,
    );
  });
});

describe('buildTarget with a dependency bundle', () => {
  it('refuses a bundle with the wrong digest at step bundle, before staging the checkout', async () => {
    const src = join(root, 'src');
    const { input } = await app(src);
    const bundles = join(root, 'bundles');
    mkdirSync(bundles);
    const file = join(bundles, 'b.tar');
    const built = await assembleBundleFile(input, file);
    const workRoot = join(root, 'work');
    mkdirSync(workRoot);
    const wrong = built.sha256.replace(/^./, built.sha256[0] === '0' ? '1' : '0');
    const outcome = await buildTarget(src, hints, {
      workRoot,
      dependencyBundle: { path: file, sha256: wrong, allowedRoot: bundles },
    });
    expect(outcome).toEqual({
      ok: false,
      unsupported: false,
      step: 'bundle',
      reason: `dependency bundle sha256 ${built.sha256} does not match the pinned ${wrong}`,
    });
    // The build directory, with anything written from the bundle, is gone.
    expect(readdirSync(workRoot)).toEqual([]);
  });
});

describe('assembleBuildArgs', () => {
  it('has --network none and no flag that could open a route out', () => {
    const args = assembleBuildArgs('/b/Dockerfile', '/b/tree', '/b/iid');
    const i = args.indexOf('--network');
    expect(args[i + 1]).toBe('none');
    expect(args.filter((a) => a === '--network')).toHaveLength(1);
    const text = args.join(' ');
    expect(text).not.toMatch(
      /--build-arg|proxy|--add-host|--secret|--ssh|--allow|host\b|registry|https?:/i,
    );
  });
});
