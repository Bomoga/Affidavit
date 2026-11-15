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
import { SYNTHETIC_VALUE, deriveRecipe } from './recipe.js';

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
