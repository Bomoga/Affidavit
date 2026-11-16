import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootHints } from '@affidavit/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JANITOR_COMMAND, buildTarget, checkBuiltTree } from './build.js';
import { COMPOSE_BIN_PATHS } from './compose.js';
import { deriveRecipe } from './recipe.js';
import { execErrorText, scrubPaths } from './scrub.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-build-unit-'));
});
afterEach(() => {
  try {
    chmodSync(join(root, 'locked'), 0o755);
  } catch {
    // only some tests lock a directory
  }
  rmSync(root, { recursive: true, force: true });
});

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('checkBuiltTree', () => {
  const caps = { maxEntries: 10, maxBytes: 1024 * 1024 };

  it('accepts a tree within the caps', async () => {
    mkdirSync(join(root, 'a/b'), { recursive: true });
    writeFileSync(join(root, 'a/b/x.js'), 'x');
    expect(await checkBuiltTree(root, caps)).toBeNull();
  });

  it('counts the logical size of a sparse file, which COPY would write in full', async () => {
    writeFileSync(join(root, 'big'), '');
    truncateSync(join(root, 'big'), 3 * 1024 * 1024);
    expect(await checkBuiltTree(root, caps)).toMatch(/over 1048576 bytes/);
  });

  it('refuses too many entries, directories included', async () => {
    for (let i = 0; i < 11; i++) mkdirSync(join(root, `d${i}`));
    expect(await checkBuiltTree(root, caps)).toMatch(/more than 10 entries/);
  });

  it('reports paths relative to the tree, never host paths', async () => {
    writeFileSync(join(root, 'big'), '');
    truncateSync(join(root, 'big'), 2 * 1024 * 1024);
    const why = await checkBuiltTree(root, caps);
    expect(why).not.toContain(root);
  });

  it.runIf(canChmod)('refuses a directory the host cannot read (chmod 000)', async () => {
    mkdirSync(join(root, 'locked/e'), { recursive: true });
    chmodSync(join(root, 'locked'), 0o000);
    expect(await checkBuiltTree(root, caps)).toBe('built tree has an unreadable directory: locked');
  });

  it.runIf(process.platform !== 'win32')('refuses a FIFO', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(await checkBuiltTree(root, caps)).toBe('built tree has a special file: pipe');
  });
});

describe('the janitor', () => {
  it('makes every directory it owns readable before deleting, and reports find', () => {
    const script = JANITOR_COMMAND.at(-1) ?? '';
    expect(JANITOR_COMMAND.slice(0, 2)).toEqual(['sh', '-c']);
    expect(script.indexOf('chmod -R u+rwX /w')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('chmod')).toBeLessThan(script.indexOf('find /w -mindepth 1 -delete'));
    // find is last, so its exit status is the janitor's.
    expect(script.trim().endsWith('-delete')).toBe(true);
  });
});

describe('scrubPaths and execErrorText', () => {
  it('replaces the longest path first and every occurrence', () => {
    const build = '/work/build-abc';
    const text = `cannot read ${build}/tree/x and ${build}/iid; also ${build}/tree/y`;
    expect(
      scrubPaths(text, [
        ['<build>', build],
        ['<tree>', `${build}/tree`],
      ]),
    ).toBe('cannot read <tree>/x and <build>/iid; also <tree>/y');
  });

  it('replaces the host temp directory', () => {
    expect(scrubPaths(`at ${join(tmpdir(), 'x')}`, [])).toBe(`at ${join('<tmp>', 'x')}`);
  });

  it('prefers stderr and drops the command line from an execFile error', () => {
    const withStderr = Object.assign(
      new Error('Command failed: docker build -f /work/build-abc/dockerfile/Dockerfile /work/t'),
      { stderr: 'ERROR: failed to solve: no space left\n' },
    );
    expect(execErrorText(withStderr)).toBe('ERROR: failed to solve: no space left');
    const noStderr = Object.assign(
      new Error('Command failed: /usr/libexec/docker/cli-plugins/docker-compose -f /x\nkilled'),
      { stderr: '' },
    );
    expect(execErrorText(noStderr)).toBe('killed');
    expect(execErrorText(Object.assign(new Error('Command failed: x /a'), { code: 1 }))).toBe(
      'command failed (1)',
    );
  });
});

describe('host paths never reach outcome reasons', () => {
  const hints: BootHints = {
    kind: 'dockerfile',
    path: 'Dockerfile',
    ports: [3000],
    healthRoute: '/health',
    healthTimeoutMs: 30_000,
    stubs: [],
    env: {},
  };

  it('scrubs a stage error that names the source and work directories', async () => {
    const workRoot = join(root, 'work');
    mkdirSync(workRoot);
    const src = join(root, 'no-such-checkout');
    const r = await buildTarget(src, hints, { workRoot });
    expect(r).toMatchObject({ ok: false, step: 'stage' });
    const reason = r.ok ? '' : r.reason;
    expect(reason).toContain('<src>');
    expect(reason).not.toContain(src);
    expect(reason).not.toContain(workRoot);
    expect(reason).not.toContain(tmpdir());
  });

  it('scrubs a compose error that names the tree and the compose binary', async () => {
    writeFileSync(join(root, 'package.json'), '{"scripts":{"start":"node s.js"}}');
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
    );
    writeFileSync(join(root, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');
    const before = process.env.AFFIDAVIT_COMPOSE_BIN;
    // A binary that cannot run, so normalizeCompose fails whatever the host has installed.
    process.env.AFFIDAVIT_COMPOSE_BIN = join(root, 'package.json');
    try {
      const r = await deriveRecipe(root, {
        ...hints,
        kind: 'compose',
        path: 'docker-compose.yml',
        service: 'app',
      });
      expect(r.ok).toBe(false);
      const reason = r.ok ? '' : r.reason;
      expect(reason).toMatch(/^compose file did not parse/);
      expect(reason).not.toContain(root);
      expect(reason).not.toContain(tmpdir());
      for (const p of COMPOSE_BIN_PATHS) expect(reason).not.toContain(p);
    } finally {
      if (before === undefined) delete process.env.AFFIDAVIT_COMPOSE_BIN;
      else process.env.AFFIDAVIT_COMPOSE_BIN = before;
    }
  });
});
