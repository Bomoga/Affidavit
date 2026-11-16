import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import {
  ControlDirectoryHoldsCodeError,
  OutputNotFreshError,
  QuarantinedSnapshot,
  ScratchNotFreshError,
  SnapshotNotCleanError,
  ToolOutputMissingError,
  assertSnapshotClean,
  findToolControlPaths,
  isToolControlName,
  loadToolManifest,
  prepareScratch,
  quarantineSnapshot,
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

/** Symlinks need privileges on some Windows setups. Probe once so the tests skip visibly. */
function canSymlink(): boolean {
  const base = tmp();
  try {
    symlinkSync(base, join(base, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  }
}
const symlinks = canSymlink();

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
  '.semgrep/rules.yml',
  '.semgrep.yml',
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
      '.semgrep-lib',
      '.semgrep-x',
      '.gitleaks-fixtures',
      '.gitlab-ci.yml',
    ]) {
      expect(isToolControlName(n)).toBe(false);
    }
  });

  it('removes every control path at any depth and returns what it removed with the snapshot', async () => {
    const root = tmp();
    for (const f of CONTROL) put(root, f);
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
        '.semgrep',
        '.semgrep.yml',
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
  });

  it('keeps application code in look-alike directories, so it is still scanned', async () => {
    const root = tmp();
    put(root, '.semgrep-x/app.js', 'eval(x)');
    put(root, '.semgrep-lib/index.js');
    put(root, '.gitleaks-fixtures/key.txt');
    put(root, '.semgrepignore');
    const snap = await quarantineSnapshot(root);
    expect([...snap.removed]).toEqual(['.semgrepignore']);
    expect(existsSync(join(root, '.semgrep-x', 'app.js'))).toBe(true);
    expect(existsSync(join(root, '.semgrep-lib', 'index.js'))).toBe(true);
    expect(existsSync(join(root, '.gitleaks-fixtures', 'key.txt'))).toBe(true);
  });

  it('refuses to delete a .semgrep directory that holds code, instead of hiding it', async () => {
    const root = tmp();
    put(root, '.semgrep/rules.yml');
    put(root, '.semgrep/payload.js', 'eval(x)');
    await expect(quarantineSnapshot(root)).rejects.toBeInstanceOf(ControlDirectoryHoldsCodeError);
    expect(existsSync(join(root, '.semgrep', 'payload.js'))).toBe(true);
  });

  it('walks directories with non-UTF-8 names without error', async () => {
    const root = tmp();
    const odd = Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x66, 0xff, 0xfe, 0x6f])]);
    try {
      mkdirSync(odd);
      writeFileSync(Buffer.concat([odd, Buffer.from('/.semgrepignore')]), 'x');
    } catch {
      return; // this filesystem rejects raw non-UTF-8 names; nothing to check here
    }
    const snap = await quarantineSnapshot(root);
    expect(snap.removed).toHaveLength(1);
    expect(snap.removed[0]).toMatch(/\.semgrepignore$/);
  });

  it.skipIf(!symlinks)(
    'removes a symlink named like a control file without following it',
    async () => {
      const root = tmp();
      const outside = tmp();
      put(outside, 'keep.txt');
      symlinkSync(outside, join(root, '.git'), 'dir');
      expect([...(await quarantineSnapshot(root)).removed]).toEqual(['.git']);
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    },
  );

  it('assertSnapshotClean fails closed until the snapshot is quarantined', async () => {
    const root = tmp();
    put(root, 'src/.semgrepignore');
    await expect(assertSnapshotClean(root)).rejects.toBeInstanceOf(SnapshotNotCleanError);
    await quarantineSnapshot(root);
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

  function fakeRunner(
    onRun?: (outputDir: string) => void,
    exitCode = 0,
  ): { runner: ToolRunnerPort; calls: number[] } {
    const calls: number[] = [];
    return {
      calls,
      runner: {
        run(_image, _args, mounts) {
          calls.push(1);
          const out = mounts.find((m) => m.containerPath === '/out')?.hostPath ?? '';
          onRun?.(out);
          return Promise.resolve({ exitCode, outputPath: out });
        },
      },
    };
  }

  async function snapshot(files: Record<string, string> = { 'src/app.js': 'x' }) {
    const dir = tmp();
    for (const [f, body] of Object.entries(files)) put(dir, f, body);
    return quarantineSnapshot(dir);
  }

  const options = async (snap?: QuarantinedSnapshot) => ({
    snapshot: snap ?? (await snapshot()),
    outputDir: join(tmp(), 'out'),
    scratchDir: join(tmp(), 's'),
  });

  it('refuses a dirty snapshot and never reaches the runner', async () => {
    const dirty = new QuarantinedSnapshot(tmp(), []);
    put(dirty.dir, '.gitleaksignore');
    const { runner, calls } = fakeRunner();
    await expect(
      runTool(runner, manifest, 'gitleaks', await options(dirty)),
    ).rejects.toBeInstanceOf(SnapshotNotCleanError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a scratch dir reused from an earlier run', async () => {
    const scratch = tmp();
    put(scratch, 'tmp/leftover');
    const { runner, calls } = fakeRunner();
    await expect(
      runTool(runner, manifest, 'gitleaks', { ...(await options()), scratchDir: scratch }),
    ).rejects.toBeInstanceOf(ScratchNotFreshError);
    expect(calls).toHaveLength(0);
  });

  it('refuses an output dir that already has content', async () => {
    const out = tmp();
    put(out, 'gitleaks.sarif', 'stale results from another case');
    const { runner, calls } = fakeRunner();
    await expect(
      runTool(runner, manifest, 'gitleaks', { ...(await options()), outputDir: out }),
    ).rejects.toBeInstanceOf(OutputNotFreshError);
    expect(calls).toHaveLength(0);
  });

  it('runs a clean snapshot through the port and passes the quarantine list through', async () => {
    const snap = await snapshot({ 'src/app.js': 'x', '.semgrepignore': '*' });
    const { runner, calls } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), '{}'));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res).toMatchObject({
      ok: true,
      empty: false,
      outputFile: 'gitleaks.sarif',
      exitCode: 0,
      quarantined: ['.semgrepignore'],
    });
    expect(calls).toHaveLength(1);
  });

  it('throws when a normal exit leaves no report', async () => {
    const { runner } = fakeRunner();
    await expect(runTool(runner, manifest, 'gitleaks', await options())).rejects.toBeInstanceOf(
      ToolOutputMissingError,
    );
  });

  it('throws when the report is empty', async () => {
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), ''));
    await expect(runTool(runner, manifest, 'gitleaks', await options())).rejects.toBeInstanceOf(
      ToolOutputMissingError,
    );
  });

  it.skipIf(!symlinks)('refuses a symlink planted at the report path', async () => {
    const target = join(tmp(), 'elsewhere.json');
    writeFileSync(target, '{"runs":[]}');
    const { runner } = fakeRunner((out) => symlinkSync(target, join(out, 'gitleaks.sarif')));
    await expect(runTool(runner, manifest, 'gitleaks', await options())).rejects.toBeInstanceOf(
      ToolOutputMissingError,
    );
  });

  it('reports a failing exit code as not ok, without demanding a report', async () => {
    const { runner } = fakeRunner(undefined, 2);
    const res = await runTool(runner, manifest, 'gitleaks', await options());
    expect(res.ok).toBe(false);
  });

  it('treats OSV exit 128 (no packages found) as an empty result with no report', async () => {
    const { runner } = fakeRunner(undefined, 128);
    const res = await runTool(runner, manifest, 'osv-scanner', {
      ...(await options()),
      osvDatabaseDir: tmp(),
    });
    expect(res).toMatchObject({ ok: true, empty: true, exitCode: 128 });
    rmSync(res.outputPath, { recursive: true, force: true });
  });
});
