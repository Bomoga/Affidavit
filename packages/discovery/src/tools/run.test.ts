import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import {
  NonUtf8NameError,
  OutputNotFreshError,
  QuarantinedSnapshot,
  SEMGREP_CANARY,
  SEMGREP_NO_TMP_EXIT,
  ScratchNotFreshError,
  SnapshotNotCleanError,
  ToolFailedError,
  ToolOutputMissingError,
  UnsafeRunDirError,
  findOsvLockfiles,
  loadToolManifest,
  quarantineSnapshot,
  resolveQuarantinedUri,
  runTool,
  windowHitNotification,
} from './index.js';
import {
  canaryResult,
  cleanupTmp,
  put,
  rawNames,
  snapDir,
  symlinks,
  tmp,
  withSemgrepCanary,
} from './testkit.js';

afterAll(cleanupTmp);

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
    // The pre-created report file is replaced by a link (a 0755 /out stops a jailed tool from
    // doing this, but runTool must refuse the link on its own too).
    const { runner } = fakeRunner((out) => {
      rmSync(join(out, 'gitleaks.sarif'));
      symlinkSync(target, join(out, 'gitleaks.sarif'));
    });
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
      'docs/manual.dat': '%PDF-1.4 AFFIDAVIT_FAKE_KEY_0123456789ABCDEF',
    });
    writeFileSync(
      join(snap.dir, 'src', 'utf16.txt'),
      Buffer.from('k\0=\0"\0s\0e\0c\0"\0', 'latin1'),
    );
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res.partial).toBe(true);
    const messages = res.notifications.map((n) => n.message).join('\n');
    expect(messages).toContain('/src/docs/manual.dat');
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
    let placeholderSeen = false;
    const { runner } = fakeRunner((out) => {
      // runTool pre-creates the report file so the jail's user can write it.
      placeholderSeen = existsSync(join(out, 'osv-scanner.json'));
    }, 128);
    const o = await options();
    const res = await runTool(runner, manifest, 'osv-scanner', { ...o, osvDatabaseDir: tmp() });
    expect(res).toMatchObject({ empty: true, exitCode: 128, reports: [], partial: false });
    expect(placeholderSeen).toBe(true);
    // The empty placeholder is removed, so no empty report is left to be read as a result.
    expect(existsSync(join(o.outputDir, 'osv-scanner.json'))).toBe(false);
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

  it('does not let a good nested lockfile hide a malformed root lockfile', async () => {
    const snap = await snapshot({ 'package-lock.json': '{ bad', 'extra/package-lock.json': '{}' });
    const { runner } = fakeRunner(
      (out) =>
        writeFileSync(
          join(out, 'osv-scanner.json'),
          JSON.stringify({ results: [{ source: { path: '/src/extra/package-lock.json' } }] }),
        ),
      1,
    );
    const res = await runTool(runner, manifest, 'osv-scanner', {
      ...(await options(snap)),
      osvDatabaseDir: tmp(),
    });
    expect(res.partial).toBe(true);
    const messages = res.notifications.map((n) => n.message);
    expect(messages.some((m) => m.startsWith('/src/package-lock.json '))).toBe(true);
    expect(messages.some((m) => m.startsWith('/src/extra/package-lock.json '))).toBe(false);
  });

  it('turns any error thrown by the runner into a typed ToolFailedError', async () => {
    const runner: ToolRunnerPort = {
      run: () => Promise.reject(new Error('mount /tmp is reserved')),
    };
    const err = await runTool(runner, manifest, 'gitleaks', await options()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolFailedError);
    expect((err as Error).message).toMatch(/runner threw: mount \/tmp is reserved/);
  });

  it('flags loose files inside a quarantined .git, but not its objects', async () => {
    const snap = await snapshot({
      'src/app.js': 'x',
      '.git/config': '[core]',
      '.git/doc.dat': '%PDF-1.4 hidden',
      '.git/objects/ab/cdef': 'x\0y',
    });
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    const messages = res.notifications.map((n) => n.message).join('\n');
    expect(messages).toContain('/src/.git/doc.dat');
    expect(messages).not.toContain('objects');
  });

  it('marks Semgrep and OSV partial when a quarantined .git holds more than git metadata', async () => {
    const snap = await snapshot({
      'src/app.js': 'x',
      '.git/config': '[core]',
      '.git/objects/ab/cdef': 'x',
      '.git/payload.js': 'eval(x)',
    });
    const semgrep = fakeRunner((out) =>
      writeFileSync(join(out, 'semgrep.sarif'), withSemgrepCanary(sarif())),
    );
    const s = await runTool(semgrep.runner, manifest, 'semgrep', {
      ...(await options(snap)),
      rulesDir: tmp(),
    });
    expect(s.partial).toBe(true);
    expect(s.notifications.map((n) => n.id)).toContain('git-dir-extra-content');
    expect(s.notifications[0]?.message).toContain('/src/.git/payload.js');

    const plain = await snapshot({
      'src/app.js': 'x',
      '.git/config': '[core]',
      '.git/HEAD': 'ref',
    });
    const ok = await runTool(semgrep.runner, manifest, 'semgrep', {
      ...(await options(plain)),
      rulesDir: tmp(),
    });
    expect(ok.partial).toBe(false);
  });

  it('names the kind of each file gitleaks may skip', async () => {
    const snap = await snapshot({
      'src/notes.txt': '%PDF-1.4 secret',
      'src/blob.dat': '\u0001\u0002\u0003',
    });
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    const byPath: Record<string, string | undefined> = {};
    for (const n of res.notifications) byPath[n.message.split(' ')[0] ?? ''] = n.id;
    expect(byPath['/src/src/notes.txt']).toBe('binary-header-mismatch');
    expect(byPath['/src/src/blob.dat']).toBe('non-text-content');
  });

  it('lists well-formed binary assets apart, without making the run partial', async () => {
    const snap = await snapshot({ 'src/app.js': 'x' });
    mkdirSync(join(snap.dir, 'img'));
    writeFileSync(
      join(snap.dir, 'img', 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    );
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res.partial).toBe(false);
    expect(res.notifications).toEqual([]);
    expect(res.binaryMediaFiles).toEqual(['/src/img/logo.png']);
  });

  it('treats every file type gitleaks skips as a coverage loss, even with a matching extension', async () => {
    const snap = await snapshot({ 'src/app.js': 'x' });
    const secret = '\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF\n';
    const files: Record<string, Buffer> = {
      'a.zip': Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(secret)]),
      'a.pdf': Buffer.from(`%PDF-1.4${secret}`),
      'a.sqlite': Buffer.from(`SQLite format 3\0${secret}`, 'latin1'),
      'a.exe': Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0]), Buffer.from(secret)]),
      'utf16.gz': gzipSync(Buffer.from('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF', 'utf16le')),
      'nested.gz': gzipSync(gzipSync(Buffer.from(secret))),
      'truncated.gz': gzipSync(Buffer.from(secret.repeat(50))).subarray(0, 20),
    };
    mkdirSync(join(snap.dir, 'bin'));
    for (const [n, b] of Object.entries(files)) writeFileSync(join(snap.dir, 'bin', n), b);
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res.partial).toBe(true);
    for (const n of Object.keys(files)) {
      const note = res.notifications.find((x) => x.message.startsWith(`/src/bin/${n} `));
      expect(note?.id, n).toBe('skipped-file-type');
    }
    expect(res.binaryMediaFiles).toEqual([]);
  });

  it('checks the text files inside a quarantined .git, but not index or objects', async () => {
    const snap = await snapshot({ 'src/app.js': 'x', '.git/HEAD': 'ref: refs/heads/main' });
    const gitDir = join(snap.sidecarDir ?? '', [...snap.mapping.keys()][0] ?? '');
    writeFileSync(join(gitDir, 'config'), Buffer.from('[core]\nkey=secret', 'utf16le'));
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(join(gitDir, 'info', 'exclude'), Buffer.from('x\0y'));
    writeFileSync(join(gitDir, 'index'), Buffer.from('DIRC\0\0\0\u0002', 'latin1'));
    mkdirSync(join(gitDir, 'objects', 'ab'), { recursive: true });
    writeFileSync(join(gitDir, 'objects', 'ab', 'cdef'), Buffer.from([0, 1, 2]));
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    const messages = res.notifications.map((n) => n.message).join('\n');
    expect(messages).toContain('/src/.git/config ');
    expect(messages).toContain('/src/.git/info/exclude ');
    expect(messages).not.toContain('/src/.git/index');
    expect(messages).not.toContain('objects');
  });

  it('refuses to read a report larger than the cap', async () => {
    const { runner } = fakeRunner((out) =>
      writeFileSync(
        join(out, 'gitleaks.sarif'),
        JSON.stringify({ runs: [{ pad: 'x'.repeat(2000) }] }),
      ),
    );
    const err = await runTool(runner, manifest, 'gitleaks', {
      ...(await options()),
      maxReportBytes: 1000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolOutputMissingError);
    expect((err as Error).message).toMatch(/report too large/);
  });

  describe('windows pass', () => {
    const bigText = (extra = '') => {
      const line = `${'a'.repeat(79)}\n`;
      return extra + line.repeat(1400);
    };

    it('reports a window that gitleaks would skip because of an offset signature', async () => {
      // 'ustar' at byte 238 of the file is byte 257 of the first window (after the 19 byte prefix)
      const text = Buffer.from(bigText());
      Buffer.from('ustar').copy(text, 238);
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'notes.txt'), text);
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
      const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
      expect(res.partial).toBe(true);
      const note = res.notifications.find((n) => n.id === 'window-skipped');
      expect(note?.message).toContain('/src/src/notes.txt');
      expect(res.windowedFiles).toEqual(['/src/src/notes.txt']);
      expect(res.reports.map((x) => x.origin)).toEqual(['snapshot', 'windows']);
    });

    it('flags plain text with an archive name and scans it in a window under a neutral name', async () => {
      const snap = await snapshot({ 'src/app.js': 'x', 'src/config.gz.yaml': 'key: value\n' });
      const { runner, calls } = fakeRunner((out) =>
        writeFileSync(join(out, 'gitleaks.sarif'), sarif()),
      );
      const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
      expect(res.partial).toBe(true);
      expect(
        res.notifications.some(
          (n) => n.id === 'archive-name-mismatch' && n.message.includes('/src/src/config.gz.yaml'),
        ),
      ).toBe(true);
      expect(res.windowedFiles).toEqual(['/src/src/config.gz.yaml']);
      expect(calls).toHaveLength(2);
    });

    it("two runs on one copy do not delete each other's windows, and a leftover directory is not touched", async () => {
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'big.txt'), bigText());
      // an old-style or foreign directory next to the copy must survive both runs
      const foreign = `${snap.dir}.windows`;
      mkdirSync(foreign);
      writeFileSync(join(foreign, 'keep.txt'), 'not ours');
      const slowRunner = (delay: number): ToolRunnerPort => ({
        run: async (_image, _args, mounts) => {
          const out = mounts.find((m) => m.containerPath === '/out')?.hostPath ?? '';
          await new Promise((resolve) => setTimeout(resolve, delay));
          writeFileSync(join(out, 'gitleaks.sarif'), sarif());
          return { exitCode: 0, outputPath: out };
        },
      });
      const [a, b] = await Promise.all([
        runTool(slowRunner(30), manifest, 'gitleaks', await options(snap)),
        runTool(slowRunner(5), manifest, 'gitleaks', await options(snap)),
      ]);
      expect(a.windowedFiles).toEqual(['/src/src/big.txt']);
      expect(b.windowedFiles).toEqual(['/src/src/big.txt']);
      expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('not ours');
      expect(
        readdirSync(join(snap.dir, '..')).filter((n) => n.startsWith('snap.windows-')),
      ).toEqual([]);
    });

    it('still reports a path in the windows directory that does not map to a window', () => {
      const byName = new Map([['w0001/p0001', { original: 'src/big.txt', startLine: 1 }]]);
      const mapped = windowHitNotification(
        { path: 'w0001/p0001/src/big.txt', kind: 'skipped-file-type' },
        byName,
      );
      expect(mapped.id).toBe('window-skipped');
      expect(mapped.message).toContain('/src/src/big.txt');
      const unmapped = windowHitNotification({ path: 'w0009/p0001', kind: 'unreadable' }, byName);
      expect(unmapped.id).toBe('window-skipped');
      expect(unmapped.message).toContain('w0009/p0001');
      expect(unmapped.message).toContain('could not be mapped');
    });

    it('does not claim a window scan for an archive-named file in the quarantine sidecar', async () => {
      const snap = await snapshot({
        'src/app.js': 'x',
        '.git/config': '[core]',
        '.git/notes.gz': 'plain text',
      });
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
      const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
      const note = res.notifications.find((n) => n.id === 'archive-name-mismatch');
      expect(note?.message).toContain('/src/.git/notes.gz');
      expect(note?.message).toContain('quarantine sidecar');
      expect(note?.message).toContain('NOT scanned');
      expect(note?.message).not.toContain('window under a neutral name');
    });

    it('marks the run partial when the window byte budget runs out', async () => {
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'big.txt'), bigText());
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
      const res = await runTool(runner, manifest, 'gitleaks', {
        ...(await options(snap)),
        maxWindowBytes: 1000,
      });
      expect(res.partial).toBe(true);
      expect(res.notifications.some((n) => n.id === 'windows-budget-exceeded')).toBe(true);
      expect(res.windowedFiles).toEqual([]);
    });

    it('removes the windows directory afterwards, so a retry does not fail', async () => {
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'big.txt'), bigText());
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
      await runTool(runner, manifest, 'gitleaks', await options(snap));
      expect(existsSync(`${snap.dir}.windows`)).toBe(false);
      await runTool(runner, manifest, 'gitleaks', await options(snap)); // would throw if it were left
    });

    it('removes the windows directory when the windows run fails', async () => {
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'big.txt'), bigText());
      let n = 0;
      const { runner } = fakeRunner((out) => {
        if (n++ === 0) writeFileSync(join(out, 'gitleaks.sarif'), sarif());
      });
      await expect(
        runTool(runner, manifest, 'gitleaks', await options(snap)),
      ).rejects.toBeInstanceOf(ToolOutputMissingError);
      expect(existsSync(`${snap.dir}.windows`)).toBe(false);
    });

    it('says NOT scanned for archive-named files that are not windowed (other signatures)', async () => {
      const snap = await snapshot({
        'src/app.js': 'x',
        'src/doc.tar.pdf': '%PDF-1.4 secret',
        'src/data.zip.db': 'SQLite format 3\0 more',
        'src/config.gz.yaml': 'key: value\n',
      });
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
      const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
      const note = (p: string) =>
        res.notifications.find((n) => n.id === 'archive-name-mismatch' && n.message.includes(p));
      for (const p of ['/src/src/doc.tar.pdf', '/src/src/data.zip.db']) {
        expect(note(p)?.message, p).toContain('NOT scanned');
        expect(note(p)?.message, p).not.toContain('scanned in a window under');
      }
      // a windowed one keeps the window wording
      expect(note('/src/src/config.gz.yaml')?.message).toContain('scanned in a window');
      expect(note('/src/src/config.gz.yaml')?.message).not.toContain('NOT scanned');
      expect(res.windowedFiles).toEqual(['/src/src/config.gz.yaml']);
    });

    it('gives a risk-flagged file the window budget over an earlier-walked, smaller one', async () => {
      // a-plain.txt is walked first and is smaller, but has blank lines, so it carries no flag.
      // z-flagged.txt has 25 KB with no blank line (chunk-split-risk), so it must win the budget.
      const plain = `${`${'a'.repeat(79)}\n`.repeat(9)}\n`.repeat(140);
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'a-plain.txt'), plain);
      writeFileSync(join(snap.dir, 'src', 'z-flagged.txt'), bigText());
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
      const res = await runTool(runner, manifest, 'gitleaks', {
        ...(await options(snap)),
        maxWindowBytes: 160_000,
      });
      expect(res.notifications.some((n) => n.id === 'chunk-split-risk')).toBe(true);
      expect(res.windowedFiles).toEqual(['/src/src/z-flagged.txt']);
      const over = res.notifications.filter((n) => n.id === 'windows-budget-exceeded');
      expect(over.map((n) => n.message.split(' ')[0])).toEqual(['/src/src/a-plain.txt']);
    });

    it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
      'refuses maxWindowBytes %s before running anything',
      async (bad) => {
        const { runner, calls } = fakeRunner();
        await expect(
          runTool(runner, manifest, 'gitleaks', { ...(await options()), maxWindowBytes: bad }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(calls).toHaveLength(0);
      },
    );

    it('accepts maxWindowBytes of 0 and reports every windowed file as over budget', async () => {
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'big.txt'), bigText());
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
      const res = await runTool(runner, manifest, 'gitleaks', {
        ...(await options(snap)),
        maxWindowBytes: 0,
      });
      expect(res.notifications.some((n) => n.id === 'windows-budget-exceeded')).toBe(true);
    });

    it('never lets an internal window path into the message text of a windows finding', async () => {
      const snap = await snapshot({ 'src/app.js': 'x' });
      writeFileSync(join(snap.dir, 'src', 'big.txt'), bigText());
      let n = 0;
      const winFinding = {
        runs: [
          {
            results: [
              {
                ruleId: 'r',
                message: { text: 'r has detected secret for file /src/w0001/p0001/src/big.txt.' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: '/src/w0001/p0001/src/big.txt' },
                      region: { startLine: 3, endLine: 3, startColumn: 1, endColumn: 5 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      let winOut = '';
      const { runner } = fakeRunner((out) => {
        const isWindows = n++ === 1;
        if (isWindows) winOut = out;
        writeFileSync(
          join(out, 'gitleaks.sarif'),
          isWindows ? JSON.stringify(winFinding) : sarif(),
        );
      });
      await runTool(runner, manifest, 'gitleaks', await options(snap));
      const text = readFileSync(join(winOut, 'gitleaks.sarif'), 'utf8');
      expect(text).not.toMatch(/w\d{4}\/p\d{4}/);
      expect(text).toContain('for file /src/src/big.txt.');
    });

    it('never lets a sidecar name into the message text of a quarantine finding', async () => {
      const snap = await snapshot({ 'src/app.js': 'x', '.git/config': '[core]' });
      const neutral = [...snap.mapping.keys()][0]!;
      let n = 0;
      let sideOut = '';
      const { runner } = fakeRunner((out) => {
        const isSide = n++ === 1;
        if (isSide) sideOut = out;
        const doc = {
          runs: [
            {
              results: [
                {
                  ruleId: 'r',
                  message: { text: `r has detected secret for file /src/${neutral}.` },
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: `/src/${neutral}` },
                        region: { startLine: 1 },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        };
        writeFileSync(join(out, 'gitleaks.sarif'), isSide ? JSON.stringify(doc) : sarif());
      });
      await runTool(runner, manifest, 'gitleaks', await options(snap));
      const text = readFileSync(join(sideOut, 'gitleaks.sarif'), 'utf8');
      expect(text).not.toContain(neutral);
      expect(text).toContain(`for file /src/${snap.mapping.get(neutral)}.`);
    });
  });

  it('never truncates coverage notifications, however many files', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`src/n${i}.txt`] = '%PDF-1.4 x';
    const snap = await snapshot(files);
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res.notifications.filter((n) => n.id === 'binary-header-mismatch')).toHaveLength(300);
  });

  it('flags a non-text byte found anywhere in the file, not only near the start', async () => {
    const snap = await snapshot({ 'src/app.js': 'x' });
    const tail = Buffer.from('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF', 'utf16le');
    writeFileSync(
      join(snap.dir, 'src', 'late.txt'),
      Buffer.concat([Buffer.alloc(9000, 0x61), tail]),
    );
    writeFileSync(
      join(snap.dir, 'src', 'badutf8.txt'),
      Buffer.concat([Buffer.alloc(20000, 0x61), Buffer.from([0xc3, 0x28])]),
    );
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    const messages = res.notifications.map((n) => n.message).join('\n');
    expect(messages).toContain('/src/src/late.txt');
    expect(messages).toContain('/src/src/badutf8.txt');
    expect(messages).not.toContain('/src/src/app.js');
  });

  it('flags long text with no blank line, where gitleaks could cut through a secret', async () => {
    const snap = await snapshot({ 'src/app.js': 'x' });
    const line = `${'a'.repeat(79)}\n`;
    writeFileSync(join(snap.dir, 'src', 'dense.txt'), line.repeat(1700)); // about 136 KB, no blank line
    writeFileSync(join(snap.dir, 'src', 'oneline.txt'), 'b'.repeat(130_000));
    writeFileSync(join(snap.dir, 'src', 'spaced.txt'), `${line.repeat(100)}\n`.repeat(17)); // blank lines
    writeFileSync(join(snap.dir, 'src', 'short.txt'), line.repeat(500)); // under 100 KB
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    const risk = res.notifications.filter((n) => n.id === 'chunk-split-risk').map((n) => n.message);
    expect(risk.some((m) => m.includes('/src/src/dense.txt'))).toBe(true);
    expect(risk.some((m) => m.includes('/src/src/oneline.txt'))).toBe(true);
    expect(risk.some((m) => m.includes('spaced.txt') || m.includes('short.txt'))).toBe(false);
    expect(res.partial).toBe(true);
  });

  it('does not make a normal clone partial: .git/index and other git bookkeeping are expected binary', async () => {
    const snap = await snapshot({
      'src/app.js': 'x',
      '.git/config': '[core]',
      '.git/HEAD': 'ref: refs/heads/main',
    });
    // a binary index file, as every real clone has
    const gitDir = join(snap.sidecarDir ?? '', [...snap.mapping.keys()][0] ?? '');
    writeFileSync(join(gitDir, 'index'), Buffer.from('DIRC\0\0\0\u0002\0\0\0\u0001', 'latin1'));
    mkdirSync(join(gitDir, 'objects', 'pack'), { recursive: true });
    writeFileSync(
      join(gitDir, 'objects', 'pack', 'p.pack'),
      Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0]),
    );
    const { runner } = fakeRunner((out) => writeFileSync(join(out, 'gitleaks.sarif'), sarif()));
    const res = await runTool(runner, manifest, 'gitleaks', await options(snap));
    expect(res.notifications).toEqual([]);
    expect(res.partial).toBe(false);
  });

  it('rejects a report that is valid JSON but the wrong shape', async () => {
    const semgrep = fakeRunner((out) => writeFileSync(join(out, 'semgrep.sarif'), '{"hello":1}'));
    await expect(
      runTool(semgrep.runner, manifest, 'semgrep', { ...(await options()), rulesDir: tmp() }),
    ).rejects.toBeInstanceOf(ToolOutputMissingError);
    const osv = fakeRunner((out) => writeFileSync(join(out, 'osv-scanner.json'), '[1,2]'), 1);
    await expect(
      runTool(osv.runner, manifest, 'osv-scanner', { ...(await options()), osvDatabaseDir: tmp() }),
    ).rejects.toBeInstanceOf(ToolOutputMissingError);
  });

  it('resolves a rewritten /src/<original> URI back to the sidecar file', async () => {
    const snap = await snapshot({
      'src/app.js': 'x',
      '.gitignore': 'hello',
      'sub/.git/config': 'c',
    });
    const resolved = resolveQuarantinedUri(snap, '/src/.gitignore');
    expect(resolved && readFileSync(resolved, 'utf8')).toBe('hello');
    const nested = resolveQuarantinedUri(snap, '/src/sub/.git/config');
    expect(nested && readFileSync(nested, 'utf8')).toBe('c');
    expect(resolveQuarantinedUri(snap, '/src/src/app.js')).toBeUndefined();
    expect(resolveQuarantinedUri(snap, '/src/.gitignore/../../etc/passwd')).toBeUndefined();
  });

  it.skipIf(!rawNames)('stops with a typed error on a non-UTF-8 name in a host walk', async () => {
    const root = snapDir();
    mkdirSync(Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x66, 0xff, 0xfe, 0x6f])]));
    await expect(findOsvLockfiles(root)).rejects.toBeInstanceOf(NonUtf8NameError);
  });

  it('marks a Semgrep run partial and attaches its notifications', async () => {
    const { runner } = fakeRunner((out) =>
      writeFileSync(
        join(out, 'semgrep.sarif'),
        withSemgrepCanary(
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
        withSemgrepCanary(
          sarif({ invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }] }),
        ),
      ),
    );
    const res = await runTool(runner, manifest, 'semgrep', {
      ...(await options()),
      rulesDir: tmp(),
    });
    expect(res).toMatchObject({ partial: false, notifications: [] });
  });

  describe('the Semgrep liveness canary', () => {
    const finding = {
      ruleId: 'affidavit.injection.sql-concat',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: '/src/src/app.js' },
            region: { startLine: 1 },
          },
        },
      ],
    };
    const tool = {
      driver: { name: 'semgrep', rules: [{ id: finding.ruleId }, { id: SEMGREP_CANARY.ruleId }] },
    };
    const report = (results: object[]) => JSON.stringify({ runs: [{ tool, results }] });
    const run = async (body: string) => {
      const { runner } = fakeRunner((out) => writeFileSync(join(out, 'semgrep.sarif'), body));
      const o = { ...(await options()), rulesDir: tmp() };
      return { o, res: runTool(runner, manifest, 'semgrep', o) };
    };

    it('fails, never reads as clean, when the canary did not match (an empty report)', async () => {
      const { res } = await run(sarif());
      const err = await res.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolOutputMissingError);
      expect((err as Error).message).toMatch(/liveness canary matched 0 times/);
    });

    it('fails when the canary matched twice, or on another file or line', async () => {
      for (const results of [
        [canaryResult(), canaryResult()],
        [canaryResult('/src/canary/canary.js')],
        [canaryResult(SEMGREP_CANARY.uri, 2)],
        [{ ...canaryResult(), locations: [] }],
      ]) {
        const { res } = await run(report([finding, ...results]));
        await expect(res).rejects.toBeInstanceOf(ToolOutputMissingError);
      }
    });

    it('accepts the canary match as a file:// URI', async () => {
      const { res } = await run(report([canaryResult(`file://${SEMGREP_CANARY.uri}`)]));
      await expect(res).resolves.toMatchObject({ partial: false });
    });

    it('strips every canary result and rule from the report, so it never becomes a candidate', async () => {
      const { o, res } = await run(report([finding, canaryResult()]));
      await res;
      const doc = JSON.parse(readFileSync(join(o.outputDir, 'semgrep.sarif'), 'utf8')) as {
        runs: { results: { ruleId: string }[]; tool: { driver: { rules: { id: string }[] } } }[];
      };
      expect(doc.runs[0]?.results.map((r) => r.ruleId)).toEqual([finding.ruleId]);
      expect(doc.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual([finding.ruleId]);
      expect(JSON.stringify(doc)).not.toContain('canary');
    });

    it('reports exit 97 as a failure: the wrapper found no writable temp directory', async () => {
      const { runner } = fakeRunner(undefined, SEMGREP_NO_TMP_EXIT);
      const err = await runTool(runner, manifest, 'semgrep', {
        ...(await options()),
        rulesDir: tmp(),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolFailedError);
      expect((err as Error).message).toMatch(/no writable temp directory/);
    });
  });

  it.runIf(process.platform !== 'win32')(
    'refuses output and scratch dirs whose parent is not a private 0700 dir of the worker',
    async () => {
      const shared = tmp();
      chmodSync(shared, 0o755);
      const { runner, calls } = fakeRunner();
      const o = await options();
      for (const bad of [{ outputDir: join(shared, 'out') }, { scratchDir: join(shared, 's') }]) {
        await expect(
          runTool(runner, manifest, 'gitleaks', { ...o, ...bad }),
        ).rejects.toBeInstanceOf(UnsafeRunDirError);
      }
      const real = tmp();
      const link = join(tmp(), 'link');
      symlinkSync(real, link);
      await expect(
        runTool(runner, manifest, 'gitleaks', { ...o, outputDir: join(link, 'out') }),
      ).rejects.toBeInstanceOf(UnsafeRunDirError);
      expect(calls).toEqual([]);
    },
  );
});
