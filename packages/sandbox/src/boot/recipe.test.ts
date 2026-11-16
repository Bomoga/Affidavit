import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootHints } from '@affidavit/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stageTree } from './build.js';
import {
  MAX_HEALTH_TIMEOUT_MS,
  SYNTHETIC_VALUE,
  deriveRecipe,
  recipeProblem,
  type BootRecipe,
} from './recipe.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-recipe-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': {} } });
const hints = (over: Partial<BootHints> = {}): BootHints => ({
  kind: 'dockerfile',
  path: 'Dockerfile',
  ports: [3000],
  healthRoute: '/health',
  healthTimeoutMs: 30_000,
  stubs: [],
  env: { STRIPE_KEY: 'synthetic' },
  ...over,
});

function app(dockerfile: string, scripts: Record<string, string> = { start: 'node server.js' }) {
  write('Dockerfile', dockerfile);
  write('package.json', JSON.stringify({ name: 'a', scripts }));
  write('package-lock.json', LOCK);
}

describe('deriveRecipe (Dockerfile targets)', () => {
  it('takes the base, workdir, env and command from the final stage', async () => {
    app('FROM node:22-alpine\nWORKDIR /srv\nENV PORT=3000 HOME=/root\nCMD ["node", "server.js"]\n');
    expect(await deriveRecipe(root, hints())).toEqual({
      ok: true,
      recipe: {
        base: 'node:22-alpine',
        workdir: '/srv',
        command: ['node', 'server.js'],
        env: { PORT: '3000', STRIPE_KEY: SYNTHETIC_VALUE },
        port: 3000,
        healthRoute: '/health',
        healthTimeoutMs: 30_000,
        sidecars: [],
        stubs: [],
        buildScript: false,
      },
    });
  });

  it('falls back to npm start when the image would only run `node`, and notices a build script', async () => {
    app('FROM node:22\n', { start: 'node index.js', build: 'tsc' });
    const r = await deriveRecipe(root, hints());
    expect(r).toMatchObject({
      ok: true,
      recipe: { command: ['npm', 'start'], workdir: '/app', buildScript: true },
    });
  });

  it.each([
    ['no package.json', () => write('Dockerfile', 'FROM node:22')],
    [
      'no npm lockfile',
      () => {
        write('Dockerfile', 'FROM node:22');
        write('package.json', '{}');
        write('yarn.lock', '');
      },
    ],
    [
      'a lockfile pointing elsewhere',
      () => {
        app('FROM node:22\nCMD ["node","x"]');
        write(
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: { 'node_modules/x': { resolved: 'https://evil.example/x.tgz' } },
          }),
        );
      },
    ],
    ['no start command', () => app('FROM node:22', {})],
    ['a SQL seed', () => app('FROM node:22\nCMD ["node","x"]')],
  ])('is unsupported with %s', async (name, setup) => {
    setup();
    const h = name === 'a SQL seed' ? hints({ seed: { kind: 'sql', path: 'seed.sql' } }) : hints();
    expect((await deriveRecipe(root, h)).ok).toBe(false);
  });

  it('refuses a Dockerfile or seed path that leaves the tree', async () => {
    app('FROM node:22\nCMD ["node","x"]');
    expect((await deriveRecipe(root, hints({ path: '../Dockerfile' }))).ok).toBe(false);
    expect(
      (await deriveRecipe(root, hints({ seed: { kind: 'script', path: '../x.js' } }))).ok,
    ).toBe(false);
  });

  it('clamps the health timeout the hints ask for to the Lane 2 maximum', async () => {
    app('FROM node:22\nCMD ["node","x"]');
    const r = await deriveRecipe(root, hints({ healthTimeoutMs: 24 * 3600 * 1000 }));
    expect(r).toMatchObject({ ok: true, recipe: { healthTimeoutMs: MAX_HEALTH_TIMEOUT_MS } });
  });

  it.each([
    ['a workdir the jail owns', 'FROM node:22\nWORKDIR /scratch\nCMD ["node","x"]'],
    ['a workdir under /proc', 'FROM node:22\nWORKDIR /proc/self\nCMD ["node","x"]'],
    ['an env name with a dash', 'FROM node:22\nENV A=b C-D=e\nCMD ["node","x"]'],
  ])('is unsupported, not an exception, with %s', async (_, dockerfile) => {
    app(dockerfile);
    expect((await deriveRecipe(root, hints())).ok).toBe(false);
  });
});

describe('recipeProblem', () => {
  const good: BootRecipe = {
    base: 'node:22',
    workdir: '/app',
    command: ['node', 'x'],
    env: { A: 'b' },
    port: 3000,
    healthRoute: '/health',
    healthTimeoutMs: 30_000,
    sidecars: [{ name: 'mongo', image: 'mongo:4.4', env: {} }],
    stubs: [],
    buildScript: false,
  };

  it('accepts a sound recipe', () => expect(recipeProblem(good)).toBeNull());

  it.each<[string, Partial<BootRecipe>]>([
    ['an over-long timeout', { healthTimeoutMs: MAX_HEALTH_TIMEOUT_MS + 1 }],
    ['a zero timeout', { healthTimeoutMs: 0 }],
    ['a fractional timeout', { healthTimeoutMs: 1.5 }],
    ['a bad port', { port: 70_000 }],
    ['a health route without a slash', { healthRoute: 'health' }],
    ['a health route with a space', { healthRoute: '/a b' }],
    ['workdir /', { workdir: '/' }],
    ['workdir /etc', { workdir: '/etc/x' }],
    ['a relative workdir', { workdir: 'app' }],
    ['an env key with "="', { env: { 'A=B': 'c' } }],
    [
      'a sidecar name that is not an alias',
      { sidecars: [{ name: 'Mongo_1', image: 'm', env: {} }] },
    ],
    [
      'a sidecar env value with a NUL',
      { sidecars: [{ name: 'm', image: 'm', env: { A: 'x\0' } }] },
    ],
    [
      'a stub alias that is not an alias',
      { stubs: [{ hostAlias: 'a b', kind: 'http', responses: [] } as never] },
    ],
  ])('refuses %s', (_, over) => expect(recipeProblem({ ...good, ...over })).not.toBeNull());
});

describe('stageTree', () => {
  it('copies regular files only and leaves out VCS data, modules, env files, npm config and links', async () => {
    write('src/a.js', 'a');
    write('run.sh', '#!/bin/sh');
    write('.git/config', 'x');
    write('node_modules/x/index.js', 'x');
    write('.env', 'SECRET=1');
    write('.env.production', 'SECRET=2');
    write('.npmrc', 'registry=https://evil.example/');
    symlinkSync('/etc/passwd', join(root, 'passwd'));
    symlinkSync('/', join(root, 'src', 'rootlink'));
    const dest = join(mkdtempSync(join(tmpdir(), 'affidavit-stage-')), 'tree');
    try {
      const report = await stageTree(root, dest);
      expect(report).toEqual({ files: 2, bytes: 10, skippedLinks: 2 });
      expect(readdirSync(dest).sort()).toEqual(['run.sh', 'src']);
      expect(readdirSync(join(dest, 'src'))).toEqual(['a.js']);
      expect(statSync(dest).mode & 0o777).toBe(0o777);
      expect(statSync(join(dest, 'run.sh')).mode & 0o777).toBe(0o666);
      expect(lstatSync(join(dest, 'src', 'a.js')).isFile()).toBe(true);
    } finally {
      rmSync(join(dest, '..'), { recursive: true, force: true });
    }
  });
});
