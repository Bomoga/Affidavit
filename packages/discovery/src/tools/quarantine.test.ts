import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  QuarantinedSnapshot,
  ScratchNotFreshError,
  SnapshotNotCleanError,
  assertSnapshotClean,
  findOsvLockfiles,
  findToolControlPaths,
  gitDirExtraContent,
  isOsvLockfileName,
  isToolControlName,
  NonUtf8NameError,
  prepareScratch,
  quarantineSnapshot,
} from './index.js';
import { cleanupTmp, put, rawNames, snapDir, symlinks, tmp } from './testkit.js';

afterAll(cleanupTmp);

const CONTROL = [
  '.git/config',
  '.gitignore',
  '.gitattributes',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.gitleaksbaseline',
  'osv-scanner.toml',
  '.osv-scanner.toml',
  '.semgrepignore',
  'src/nested/.semgrepignore',
  'sub/pkg/osv-scanner.toml',
  'sub/.GITIGNORE',
];

describe('tool-control path quarantine', () => {
  it('matches exact control names only, never prefixes', () => {
    for (const n of [
      '.git',
      '.gitignore',
      '.GitLeaks.toml',
      '.semgrepignore',
      'osv-scanner.toml',
    ]) {
      expect(isToolControlName(n)).toBe(true);
    }
    for (const n of [
      '.github',
      'src',
      'package.json',
      'gitignore.md',
      'osv-scanner-notes.md',
      '.semgrep',
      '.semgrep.yml',
      '.semgrep-lib',
      '.gitleaks-fixtures',
      '.gitlab-ci.yml',
    ]) {
      expect(isToolControlName(n)).toBe(false);
    }
  });

  it('moves every control path out of the snapshot into a sidecar, with a mapping back', async () => {
    const root = snapDir();
    for (const f of CONTROL) put(root, f, `content of ${f}`);
    put(root, 'src/app.js');
    put(root, '.github/workflows/ci.yml');
    const snap = await quarantineSnapshot(root);
    expect(snap).toBeInstanceOf(QuarantinedSnapshot);
    expect(snap.dir).toBe(root);
    expect([...snap.removed]).toEqual(
      [
        '.git',
        '.gitattributes',
        '.gitignore',
        '.gitleaks.toml',
        '.gitleaksbaseline',
        '.gitleaksignore',
        '.osv-scanner.toml',
        '.semgrepignore',
        'osv-scanner.toml',
        'src/nested/.semgrepignore',
        'sub/.GITIGNORE',
        'sub/pkg/osv-scanner.toml',
      ].sort(),
    );
    expect(existsSync(join(root, 'src', 'app.js'))).toBe(true);
    expect(existsSync(join(root, '.github', 'workflows', 'ci.yml'))).toBe(true);
    expect(await findToolControlPaths(root)).toEqual([]);

    // Nothing was destroyed: each entry is in the sidecar under a neutral name.
    expect(snap.sidecarDir).toBe(`${root}.quarantine`);
    expect(snap.mapping.size).toBe(snap.removed.length);
    for (const [neutral, original] of snap.mapping) {
      expect(neutral).toMatch(/^q\d{4}$/);
      expect(existsSync(join(snap.sidecarDir!, neutral))).toBe(true);
      if (original === '.gitignore') {
        expect(readFileSync(join(snap.sidecarDir!, neutral), 'utf8')).toBe('content of .gitignore');
      }
    }
  });

  it('has no sidecar and an empty list when nothing needed quarantine', async () => {
    const root = snapDir({ 'src/app.js': 'x' });
    const snap = await quarantineSnapshot(root);
    expect(snap.sidecarDir).toBeNull();
    expect(snap.removed).toEqual([]);
  });

  it('keeps application code in look-alike directories, so it is still scanned', async () => {
    const root = snapDir();
    put(root, '.semgrep-x/app.js', 'eval(x)');
    put(root, '.semgrep-lib/index.js');
    put(root, '.semgrep.yml');
    put(root, '.semgrep/code.js', 'eval(x)');
    put(root, '.gitleaks-fixtures/key.txt');
    put(root, '.semgrepignore');
    const snap = await quarantineSnapshot(root);
    expect([...snap.removed]).toEqual(['.semgrepignore']);
    for (const kept of [
      '.semgrep-x/app.js',
      '.semgrep-lib/index.js',
      '.semgrep.yml',
      '.semgrep/code.js',
      '.gitleaks-fixtures/key.txt',
    ]) {
      expect(existsSync(join(root, kept))).toBe(true);
    }
  });

  it('moves only .git as a directory; other control-named directories stay and are scanned', async () => {
    const root = snapDir();
    put(root, 'src/.gitignore/evil.js', 'eval(x)');
    put(root, 'lib/osv-scanner.toml/package-lock.json', '{}');
    put(root, '.git/config');
    put(root, 'real/.gitignore');
    const snap = await quarantineSnapshot(root);
    expect([...snap.removed]).toEqual(['.git', 'real/.gitignore']);
    expect(existsSync(join(root, 'src', '.gitignore', 'evil.js'))).toBe(true);
    expect(existsSync(join(root, 'lib', 'osv-scanner.toml', 'package-lock.json'))).toBe(true);
    // and the lockfile inside such a directory is still found for OSV
    expect(await findOsvLockfiles(root)).toEqual(['lib/osv-scanner.toml/package-lock.json']);
    await expect(assertSnapshotClean(root)).resolves.toBeUndefined();
  });

  it('changes nothing when collection fails (two-phase)', async () => {
    const root = snapDir({ '.gitignore': 'x', 'src/app.js': 'x' });
    const taken = `${root}.quarantine`;
    mkdirSync(taken); // sidecar already exists, so quarantine must refuse before moving anything
    await expect(quarantineSnapshot(root)).rejects.toThrow();
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
  });

  it.skipIf(!rawNames)(
    'stops with a typed error on a non-UTF-8 name, and moves nothing',
    async () => {
      const root = snapDir({ '.gitignore': 'x' });
      mkdirSync(Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x66, 0xff, 0xfe, 0x6f])]));
      await expect(quarantineSnapshot(root)).rejects.toBeInstanceOf(NonUtf8NameError);
      expect(existsSync(join(root, '.gitignore'))).toBe(true);
    },
  );

  it('flags non-metadata content hidden inside .git subdirectories', async () => {
    const root = snapDir();
    put(root, '.git/config', '[core]');
    put(root, '.git/hooks/pre-commit.sample', '#!/bin/sh');
    put(root, '.git/hooks/pre-commit', '#!/bin/sh');
    put(root, '.git/hooks/evil.js', 'eval(x)');
    put(root, '.git/info/exclude', '');
    put(root, '.git/info/payload.js', 'eval(x)');
    put(root, '.git/refs/heads/main', 'a'.repeat(40));
    put(root, '.git/refs/heads/big', 'x'.repeat(2000));
    put(root, '.git/index', 'DIRC');
    put(root, '.git/objects/ab/cdef', 'x');
    put(root, '.git/objects/pack/p.pack', 'x');
    put(root, '.git/objects/loose.js', 'eval(x)');
    const snap = await quarantineSnapshot(root);
    expect(await gitDirExtraContent(snap)).toEqual([
      '.git/hooks/evil.js',
      '.git/info/payload.js',
      '.git/objects/loose.js',
      '.git/refs/heads/big',
    ]);
  });

  it.skipIf(!symlinks)(
    'moves a symlink named like a control file without following it',
    async () => {
      const root = snapDir();
      const outside = tmp();
      put(outside, 'keep.txt');
      symlinkSync(outside, join(root, '.git'), 'dir');
      expect([...(await quarantineSnapshot(root)).removed]).toEqual(['.git']);
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    },
  );

  it('assertSnapshotClean fails closed until the snapshot is quarantined', async () => {
    const root = snapDir({ 'src/.semgrepignore': 'x' });
    await expect(assertSnapshotClean(root)).rejects.toBeInstanceOf(SnapshotNotCleanError);
    await quarantineSnapshot(root);
    await expect(assertSnapshotClean(root)).resolves.toBeUndefined();
  });

  it('cannot be built by hand', () => {
    expect(
      () => new QuarantinedSnapshot(Symbol('forged') as never, '/x', null, new Map()),
    ).toThrow();
  });

  it('prepareScratch demands a new or empty directory per run', async () => {
    const scratch = join(tmp(), 'run1');
    await prepareScratch(scratch, ['tmp']);
    expect(existsSync(join(scratch, 'tmp'))).toBe(true);
    await expect(prepareScratch(scratch, ['tmp'])).rejects.toBeInstanceOf(ScratchNotFreshError);
  });
});

describe('OSV lockfile detection', () => {
  it('recognises lockfile names and finds them at any depth', async () => {
    for (const n of [
      'package-lock.json',
      'go.mod',
      'Cargo.lock',
      'requirements-dev.txt',
      'bom.xml',
      'sbom.spdx',
      'x.spdx.yml',
      'app.deps.json',
      'Directory.Packages.props',
      'x.cdx.json',
    ]) {
      expect(isOsvLockfileName(n)).toBe(true);
    }
    expect(isOsvLockfileName('app.js')).toBe(false);
    const root = snapDir({ 'a/b/yarn.lock': 'x', 'src/app.js': 'x' });
    expect(await findOsvLockfiles(root)).toEqual(['a/b/yarn.lock']);
  });
});
