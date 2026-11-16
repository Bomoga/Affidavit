import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import {
  OutputNotFreshError,
  QuarantinedSnapshot,
  ScratchNotFreshError,
  SnapshotNotCleanError,
  ToolFailedError,
  ToolOutputMissingError,
  assertSnapshotClean,
  findOsvLockfiles,
  findToolControlPaths,
  isOsvLockfileName,
  isToolControlName,
  loadToolManifest,
  prepareScratch,
  quarantineSnapshot,
  runTool,
} from './index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'affidavit-quarantine-'));
  tmpDirs.push(d);
  return d;
}

/** A parent dir holding a `snap` directory, so the sidecar `snap.quarantine` has room beside it. */
function snapDir(files: Record<string, string> = {}): string {
  const dir = join(tmp(), 'snap');
  mkdirSync(dir);
  for (const [f, body] of Object.entries(files)) put(dir, f, body);
  return dir;
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

/** Raw non-UTF-8 names are rejected by some filesystems. Probe once so the test skips visibly. */
function canMakeRawNames(): boolean {
  const base = tmp();
  try {
    mkdirSync(Buffer.concat([Buffer.from(base + '/'), Buffer.from([0x66, 0xff, 0xfe, 0x6f])]));
    return true;
  } catch {
    return false;
  }
}
const rawNames = canMakeRawNames();

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

  it.skipIf(!rawNames)('walks directories with non-UTF-8 names without error', async () => {
    const root = snapDir();
    const odd = Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x66, 0xff, 0xfe, 0x6f])]);
    mkdirSync(odd);
    writeFileSync(Buffer.concat([odd, Buffer.from('/.semgrepignore')]), 'x');
    const snap = await quarantineSnapshot(root);
    expect(snap.removed).toHaveLength(1);
    expect(snap.removed[0]).toMatch(/\.semgrepignore$/);
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
      'x.cdx.json',
    ]) {
      expect(isOsvLockfileName(n)).toBe(true);
    }
    expect(isOsvLockfileName('app.js')).toBe(false);
    const root = snapDir({ 'a/b/yarn.lock': 'x', 'src/app.js': 'x' });
    expect(await findOsvLockfiles(root)).toEqual(['a/b/yarn.lock']);
  });
});

describe('runTool', () => {
  const manifest = loadToolManifest();

  function fakeRunner(
    onRun?: (outputDir: string) => void,
    exitCode = 0,
    outputPath?: string,
  ): { runner: ToolRunnerPort; calls: { image: string; sourceHost: string }[] } {
    const calls: { image: string; sourceHost: string }[] = [];
    return {
      calls,
      runner: {
        run(image, _args, mounts) {
          const out = mounts.find((m) => m.containerPath === '/out')?.hostPath ?? '';
          calls.push({
            image,
            sourceHost: mounts.find((m) => m.containerPath === '/src')?.hostPath ?? '',
          });
          onRun?.(out);
          return Promise.resolve({ exitCode, outputPath: outputPath ?? out });
        },
      },
    };
  }

  async function snapshot(files: Record<string, string> = { 'src/app.js': 'x' }) {
    return quarantineSnapshot(snapDir(files));
  }

  const options = async (snap?: QuarantinedSnapshot) => ({
    snapshot: snap ?? (await snapshot()),
    outputDir: join(tmp(), 'out'),
    scratchDir: join(tmp(), 's'),
  });

  const sarif = (extra: object = {}) => JSON.stringify({ runs: [{ results: [], ...extra }] });

  it('refuses a snapshot that went dirty after quarantine and never reaches the runner', async () => {
    const snap = await snapshot();
    put(snap.dir, '.gitleaksignore');
    const { runner, calls } = fakeRunner();
    await expect(runTool(runner, manifest, 'gitleaks', await options(snap))).rejects.toBeInstanceOf(
      SnapshotNotCleanError,
    );
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
    const snap = await snapshot({ 'src/app.js': 'x' });
    const { runner, calls } = fakeRunner((out) =>
      writeFileSync(join(out, 'gitleaks.sarif'), sarif()),
    );
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res).toMatchObject({
      empty: false,
      partial: false,
      outputFile: 'gitleaks.sarif',
      exitCode: 0,
      quarantined: [],
    });
    expect(res.reports).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('also scans the quarantined files with gitleaks and maps their paths back', async () => {
    const snap = await snapshot({ 'src/app.js': 'x', '.gitignore': 'secret' });
    const neutral = [...snap.mapping.keys()][0]!;
    const seen: string[] = [];
    const { runner, calls } = fakeRunner((out) => {
      const uri = seen.length === 0 ? 'src/app.js' : `/src/${neutral}`;
      seen.push(uri);
      writeFileSync(
        join(out, 'gitleaks.sarif'),
        sarif({
          results: [{ locations: [{ physicalLocation: { artifactLocation: { uri } } }] }],
        }),
      );
    });
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.sourceHost).toBe(snap.sidecarDir);
    expect(res.reports.map((r) => r.origin)).toEqual(['snapshot', 'quarantine']);
    const mapped = readFileSync(res.reports[1]!.file, 'utf8');
    expect(mapped).toContain('"uri":"/src/.gitignore"');
    expect(res.quarantined).toEqual(['.gitignore']);
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

  it('throws ToolFailedError, with the exit code and quarantine list, for a failing exit', async () => {
    const snap = await snapshot({ '.gitignore': 'x' });
    const { runner } = fakeRunner(undefined, 2);
    const err = await runTool(runner, manifest, 'gitleaks', await options(snap)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolFailedError);
    expect(err).toMatchObject({ exitCode: 2, quarantined: ['.gitignore'] });
  });

  it('works with runners that return a fixed, unrelated output directory and ignore /out', async () => {
    // LocalDockerToolRunner and the gVisor runner behave like this: outputPath is fixed at
    // construction, while the tool writes into the /out mount.
    const snap = await snapshot({ 'src/app.js': 'x', '.gitignore': 'x' });
    const fixed = tmp();
    const { runner } = fakeRunner(
      (out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()),
      0,
      fixed,
    );
    const opts = await options(snap);
    const res = await runTool(runner, manifest, 'gitleaks', opts);
    expect(res.reports).toHaveLength(2); // including the quarantine pass
    expect(res.outputPath).toBe(resolve(opts.outputDir));
  });

  it('keeps the sidecar report beside the output dir even when the path has a trailing slash', async () => {
    const snap = await snapshot({ 'src/app.js': 'x', '.gitignore': 'x' });
    const out = join(tmp(), 'out');
    const { runner } = fakeRunner((o) => writeFileSync(join(o, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', {
      ...(await options(snap)),
      outputDir: `${out}/`,
    });
    expect(res.reports[1]?.file).toBe(join(`${out}-quarantine`, 'gitleaks.sarif'));
  });

  it('rejects a report that is not valid JSON, as truncated', async () => {
    const { runner } = fakeRunner((out) =>
      writeFileSync(join(out, 'gitleaks.sarif'), '{"runs":[{'),
    );
    const err = await runTool(runner, manifest, 'gitleaks', await options()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolOutputMissingError);
    expect((err as ToolOutputMissingError).tool).toBe('gitleaks');
  });

  it('says so when the quarantine pass is the one that failed', async () => {
    const snap = await snapshot({ 'src/app.js': 'x', '.gitignore': 'x' });
    let n = 0;
    const { runner } = fakeRunner((out) => {
      if (n++ === 0) writeFileSync(join(out, 'gitleaks.sarif'), sarif());
    });
    const err = await runTool(runner, manifest, 'gitleaks', await options(snap)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolOutputMissingError);
    expect((err as Error).message).toMatch(/quarantine pass/);
    expect((err as ToolOutputMissingError).quarantined).toEqual(['.gitignore']);
  });

  it('marks gitleaks partial for files it silently skips as binary, including UTF-16', async () => {
    const snap = await snapshot({
      'src/app.js': 'x',
      'docs/manual.pdf': '%PDF-1.4 AFFIDAVIT_FAKE_KEY_0123456789ABCDEF',
    });
    writeFileSync(
      join(snap.dir, 'src', 'utf16.txt'),
      Buffer.from('k\0=\0"\0s\0e\0c\0"\0', 'latin1'),
    );
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res.partial).toBe(true);
    const messages = res.notifications.map((n) => n.message).join('\n');
    expect(messages).toContain('/src/docs/manual.pdf');
    expect(messages).toContain('/src/src/utf16.txt');
    expect(messages).not.toContain('/src/src/app.js');
  });

  it('marks OSV partial when a lockfile the snapshot has is missing from the report', async () => {
    const snap = await snapshot({ 'a/package-lock.json': '{}', 'b/yarn.lock': 'x' });
    const report = (paths: string[]) =>
      JSON.stringify({ results: paths.map((path) => ({ source: { path, type: 'lockfile' } })) });
    const partial = fakeRunner(
      (out) => writeFileSync(join(out, 'osv-scanner.json'), report(['/src/a/package-lock.json'])),
      1,
    );
    const res = await runTool(partial.runner, manifest, 'osv-scanner', {
      ...(await options(snap)),
      osvDatabaseDir: tmp(),
    });
    expect(res.partial).toBe(true);
    expect(res.notifications.map((n) => n.message).join('\n')).toContain('/src/b/yarn.lock');

    const full = fakeRunner(
      (out) =>
        writeFileSync(
          join(out, 'osv-scanner.json'),
          report(['/src/a/package-lock.json', '/src/b/yarn.lock']),
        ),
      1,
    );
    const ok = await runTool(full.runner, manifest, 'osv-scanner', {
      ...(await options(snap)),
      osvDatabaseDir: tmp(),
    });
    expect(ok.partial).toBe(false);
  });

  it('treats OSV exit 128 as an empty result only when the snapshot has no lockfile', async () => {
    const { runner } = fakeRunner(undefined, 128);
    const res = await runTool(runner, manifest, 'osv-scanner', {
      ...(await options()),
      osvDatabaseDir: tmp(),
    });
    expect(res).toMatchObject({ empty: true, exitCode: 128, reports: [], partial: false });
  });

  it('fails OSV exit 128 when a lockfile is present, because it probably failed to parse', async () => {
    const snap = await snapshot({ 'package-lock.json': '{ not json' });
    const { runner } = fakeRunner(undefined, 128);
    const err = await runTool(runner, manifest, 'osv-scanner', {
      ...(await options(snap)),
      osvDatabaseDir: tmp(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolFailedError);
    expect((err as Error).message).toMatch(/lockfile/);
  });

  it('marks a Semgrep run partial and attaches its notifications', async () => {
    const { runner } = fakeRunner((out) =>
      writeFileSync(
        join(out, 'semgrep.sarif'),
        sarif({
          invocations: [
            {
              executionSuccessful: true,
              toolExecutionNotifications: [
                {
                  level: 'warning',
                  descriptor: { id: 'Syntax error' },
                  message: { text: 'Syntax error at line /src/broken.js:1' },
                },
              ],
            },
          ],
        }),
      ),
    );
    const res = await runTool(runner, manifest, 'semgrep', {
      ...(await options()),
      rulesDir: tmp(),
    });
    expect(res.partial).toBe(true);
    expect(res.notifications).toEqual([
      { level: 'warning', id: 'Syntax error', message: 'Syntax error at line /src/broken.js:1' },
    ]);
  });

  it('does not mark a clean Semgrep run partial', async () => {
    const { runner } = fakeRunner((out) =>
      writeFileSync(
        join(out, 'semgrep.sarif'),
        sarif({ invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }] }),
      ),
    );
    const res = await runTool(runner, manifest, 'semgrep', {
      ...(await options()),
      rulesDir: tmp(),
    });
    expect(res).toMatchObject({ partial: false, notifications: [] });
  });
});
