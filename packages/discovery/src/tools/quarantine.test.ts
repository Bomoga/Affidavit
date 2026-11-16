import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import {
  ScratchNotFreshError,
  SnapshotNotCleanError,
  assertSnapshotClean,
  findToolControlPaths,
  isToolControlName,
  loadToolManifest,
  prepareScratch,
  quarantineToolControlPaths,
  runTool,
} from './index.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'affidavit-quarantine-'));
}

function put(root: string, rel: string, body = 'x'): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

const CONTROL = [
  '.git/config',
  '.gitignore',
  '.gitattributes',
  '.gitleaks.toml',
  '.gitleaksignore',
  'osv-scanner.toml',
  '.osv-scanner.toml',
  '.semgrepignore',
  'src/nested/.semgrepignore',
  'sub/pkg/osv-scanner.toml',
  'sub/.GITIGNORE',
  '.semgrep/rules.yml',
  '.semgrep.yml',
];

describe('tool-control path quarantine', () => {
  it('recognises the control names and leaves ordinary names alone', () => {
    for (const n of [
      '.git',
      '.gitignore',
      '.GitLeaks.toml',
      '.semgrepignore',
      'osv-scanner.toml',
    ]) {
      expect(isToolControlName(n)).toBe(true);
    }
    for (const n of ['.github', 'src', 'package.json', 'gitignore.md', 'osv-scanner-notes.md']) {
      expect(isToolControlName(n)).toBe(false);
    }
  });

  it('removes every control path at any depth and reports what it removed', async () => {
    const root = tmp();
    for (const f of CONTROL) put(root, f);
    put(root, 'src/app.js');
    put(root, '.github/workflows/ci.yml');
    const removed = await quarantineToolControlPaths(root);
    expect(removed).toEqual(
      [
        '.git',
        '.gitattributes',
        '.gitignore',
        '.gitleaks.toml',
        '.gitleaksignore',
        '.osv-scanner.toml',
        '.semgrep',
        '.semgrep.yml',
        '.semgrepignore',
        'src/nested/.semgrepignore',
        'sub/.GITIGNORE',
        'sub/pkg/osv-scanner.toml',
        'osv-scanner.toml',
      ].sort(),
    );
    expect(existsSync(join(root, 'src', 'app.js'))).toBe(true);
    expect(existsSync(join(root, '.github', 'workflows', 'ci.yml'))).toBe(true);
    expect(await findToolControlPaths(root)).toEqual([]);
  });

  it('removes a symlink named like a control file without following it', async () => {
    const root = tmp();
    const outside = tmp();
    put(outside, 'keep.txt');
    try {
      symlinkSync(outside, join(root, '.git'), 'dir');
    } catch {
      return; // symlinks need privileges on some Windows setups; nothing to check there
    }
    expect(await quarantineToolControlPaths(root)).toEqual(['.git']);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('assertSnapshotClean fails closed until the snapshot is quarantined', async () => {
    const root = tmp();
    put(root, 'src/.semgrepignore');
    await expect(assertSnapshotClean(root)).rejects.toBeInstanceOf(SnapshotNotCleanError);
    await quarantineToolControlPaths(root);
    await expect(assertSnapshotClean(root)).resolves.toBeUndefined();
  });

  it('prepareScratch demands a new or empty directory per run', async () => {
    const base = tmp();
    const scratch = join(base, 'run1');
    await prepareScratch(scratch, ['tmp']);
    expect(existsSync(join(scratch, 'tmp'))).toBe(true);
    await expect(prepareScratch(scratch, ['tmp'])).rejects.toBeInstanceOf(ScratchNotFreshError);
  });
});

describe('runTool', () => {
  const manifest = loadToolManifest();
  const calls: { image: string; args: readonly string[] }[] = [];
  const runner: ToolRunnerPort = {
    run(image, args) {
      calls.push({ image, args });
      return Promise.resolve({ exitCode: 0, outputPath: '/out' });
    },
  };

  it('refuses a dirty snapshot and never reaches the runner', async () => {
    const src = tmp();
    put(src, '.gitleaksignore');
    await expect(
      runTool(runner, manifest, 'gitleaks', {
        sourceDir: src,
        outputDir: tmp(),
        scratchDir: join(tmp(), 's'),
      }),
    ).rejects.toBeInstanceOf(SnapshotNotCleanError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a scratch dir reused from an earlier run', async () => {
    const src = tmp();
    const scratch = tmp();
    put(scratch, 'tmp/leftover');
    await expect(
      runTool(runner, manifest, 'gitleaks', {
        sourceDir: src,
        outputDir: tmp(),
        scratchDir: scratch,
      }),
    ).rejects.toBeInstanceOf(ScratchNotFreshError);
    expect(calls).toHaveLength(0);
  });

  it('runs a clean snapshot through the port with the pinned image', async () => {
    const src = tmp();
    put(src, 'src/app.js');
    const res = await runTool(runner, manifest, 'gitleaks', {
      sourceDir: src,
      outputDir: tmp(),
      scratchDir: join(tmp(), 's'),
    });
    expect(res).toMatchObject({ ok: true, outputFile: 'gitleaks.sarif', exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});
