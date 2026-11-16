/**
 * Docker tests. The Docker half is skipped unless AFFIDAVIT_DOCKER_TESTS=1, so plain `pnpm test`
 * (and CI, which has no tool images) never runs it. Run with:
 *   AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker
 * PowerShell: $env:AFFIDAVIT_DOCKER_TESTS = '1'; pnpm --filter @affidavit/discovery test:docker
 *
 * Each tool runs from its pinned digest with --network none against fixtures/corpus/tool-smoke and
 * writes its report into its own mounted output dir.
 */
import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInvocation } from './invocations.js';
import {
  isOkExit,
  loadToolManifest,
  prepareOutput,
  prepareScratch,
  SnapshotNotCleanError,
  ToolFailedError,
  quarantineSnapshot,
  repoRoot,
  runTool,
  type ToolName,
  type ToolRunResult,
  type ToolRunOptions,
} from './index.js';

const enabled = process.env['AFFIDAVIT_DOCKER_TESTS'] === '1';
const manifest = loadToolManifest();
const smoke = join(repoRoot(), 'fixtures', 'corpus', 'tool-smoke');
const TOOLS = ['semgrep', 'osv-scanner', 'gitleaks'] as const;

/**
 * The jail flags this test uses, in order. They mirror buildDockerRunArgs in
 * packages/testing/src/infra.ts, which discovery cannot import (it is not a dependency, and adding
 * one would change the lockfile). The pin test below compares the exact ordered sequence against
 * that file's source, so the smoke run keeps testing what the fake runner actually does.
 */
const JAIL_FLAGS: readonly string[] = [
  '--rm',
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '256',
  '--memory',
  '1g',
];

function dockerRunArgs(
  image: string,
  args: readonly string[],
  mounts: readonly { hostPath: string; containerPath: string; readOnly: boolean }[],
): string[] {
  return [
    'run',
    ...JAIL_FLAGS,
    ...mounts.flatMap((m) => ['-v', `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`]),
    image,
    ...args,
  ];
}

/** stderr of every docker run, keyed by image digest, so tests can assert what a tool did. */
const stderrByImage = new Map<string, string>();

function makeRunner(): ToolRunnerPort {
  return {
    run(image, args, mounts) {
      return new Promise((resolve) => {
        execFile('docker', dockerRunArgs(image, args, mounts), (error, _out, stderr) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          stderrByImage.set(image, stderr);
          // Like the real runners, report a directory unrelated to the /out mount.
          resolve({ exitCode, outputPath: tmpdir() });
        });
      });
    },
  };
}

describe('smoke test jail flags', () => {
  it('are, in order, the flags the fake ToolRunner uses', () => {
    const infra = readFileSync(join(repoRoot(), 'packages', 'testing', 'src', 'infra.ts'), 'utf8');
    const body = /buildDockerRunArgs[\s\S]*?return \[([\s\S]*?)\.\.\.mounts/.exec(infra)?.[1] ?? '';
    const tokens = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(tokens).toEqual(['run', ...JAIL_FLAGS]);
    expect(dockerRunArgs('img@sha256:x', ['a'], [])).toEqual([
      'run',
      ...JAIL_FLAGS,
      'img@sha256:x',
      'a',
    ]);
  });
});

/** A one-entry stored (uncompressed) zip, the layout osv-scanner reads for an offline database. */
function storedZip(name: string, data: Buffer): Buffer {
  const n = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const body = Buffer.concat([local, n, data]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, n, end]);
}

/**
 * Copies a fixture tree and restores names that are kept inert in the repo: a `.fixture` suffix is
 * dropped (so .json data does not look like a contract fixture, and node_modules is not ignored by
 * git) and a `dot-` prefix becomes `.` (so planted .git, .gitignore and friends are not live files
 * inside this repository).
 */
function materialize(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
  const fix = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      let p = join(dir, entry);
      const name = entry.replace(/\.fixture$/, '').replace(/^dot-/, '.');
      if (name !== entry) {
        renameSync(p, join(dir, name));
        p = join(dir, name);
      }
      if (statSync(p).isDirectory()) fix(p);
    }
  };
  fix(to);
  if (existsSync(join(to, '.git'))) {
    mkdirSync(join(to, '.git', 'refs'), { recursive: true });
    mkdirSync(join(to, '.git', 'objects'), { recursive: true });
  }
}

interface Finding {
  ruleId?: string;
  uri: string;
}

function sarifFindings(raw: string): Finding[] {
  const sarif = JSON.parse(raw) as {
    runs: {
      results?: {
        ruleId?: string;
        locations?: { physicalLocation?: { artifactLocation?: { uri?: string } } }[];
      }[];
    }[];
  };
  return sarif.runs.flatMap((r) =>
    (r.results ?? []).map((x) => ({
      ruleId: x.ruleId,
      uri: x.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? '',
    })),
  );
}

function semgrepNotes(raw: string): string[] {
  const sarif = JSON.parse(raw) as {
    runs: { invocations?: { toolExecutionNotifications?: { message?: { text?: string } }[] }[] }[];
  };
  return sarif.runs.flatMap((r) =>
    (r.invocations ?? []).flatMap((i) =>
      (i.toolExecutionNotifications ?? []).map((n) => n.message?.text ?? ''),
    ),
  );
}

describe.skipIf(!enabled)('tool images, offline', () => {
  let work: string;
  let osvDb: string;
  let gitleaksConfigDir: string;
  let counter = 0;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'affidavit-tools-'));

    osvDb = join(work, 'osv-db');
    for (const [eco, id] of [
      ['npm', 'AFFIDAVIT-SMOKE-0001'],
      ['Go', 'AFFIDAVIT-SMOKE-0002'],
    ] as const) {
      mkdirSync(join(osvDb, eco), { recursive: true });
      const advisory = readFileSync(join(smoke, 'osv-advisories', `${id}.json.fixture`));
      writeFileSync(join(osvDb, eco, 'all.zip'), storedZip(`${id}.json`, advisory));
    }

    // Our real vendored gitleaks config plus the fixture rule that recognises the fake key.
    gitleaksConfigDir = join(work, 'gitleaks-config');
    mkdirSync(gitleaksConfigDir);
    writeFileSync(
      join(gitleaksConfigDir, 'gitleaks.toml'),
      readFileSync(join(repoRoot(), 'docker', 'tools', 'config', 'gitleaks.toml'), 'utf8') +
        readFileSync(join(smoke, 'rules', 'gitleaks', 'affidavit-fixture.toml'), 'utf8'),
    );
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** A fresh snapshot, per-tool output and scratch dirs for one scenario. */
  function scenario(fixture: string, extra?: (src: string) => void) {
    const id = `s${++counter}`;
    const src = join(work, id, 'src');
    materialize(join(smoke, fixture), src);
    extra?.(src);
    const out = (tool: ToolName) => join(work, id, `out-${tool}`);
    const options = (tool: ToolName): ToolRunOptions => ({
      sourceDir: src,
      outputDir: out(tool),
      scratchDir: join(work, id, `scratch-${tool}`),
      rulesDir: join(smoke, 'rules', 'semgrep'),
      configDir: tool === 'gitleaks' ? gitleaksConfigDir : undefined,
      osvDatabaseDir: osvDb,
    });
    return { src, out, options, runner: makeRunner() };
  }
  type Scenario = ReturnType<typeof scenario>;

  const read = (s: Scenario, tool: ToolName, file: string) =>
    readFileSync(join(s.out(tool), file), 'utf8');

  /** Writes a source file larger than Semgrep's default 1 MB cap, with the unsafe call at the top. */
  const addGenerated = (src: string) => {
    writeFileSync(
      join(src, 'src', 'big.js'),
      'export const run = (x) => eval(x);\n' + '// padding\n'.repeat(120_000),
    );
    // Files gitleaks silently skips as binary-looking, with a secret inside.
    writeFileSync(join(src, 'src', 'doc.dat'), '%PDF-1.4\nAFFIDAVIT_FAKE_KEY_1122334455667788\n');
    writeFileSync(
      join(src, 'src', 'utf16.txt'),
      Buffer.from('AFFIDAVIT_FAKE_KEY_99AABBCCDDEEFF00', 'utf16le'),
    );
    // Loose files inside the quarantined .git: a secret behind a PDF header, and non-metadata.
    writeFileSync(join(src, '.git', 'doc.dat'), '%PDF-1.4\nAFFIDAVIT_FAKE_KEY_0011223344556677\n');
    writeFileSync(join(src, '.git', 'payload.js'), 'export const run = (x) => eval(x);\n');
    // A secret hidden inside a gzip archive.
    writeFileSync(
      join(src, 'src', 'secret.txt.gz'),
      gzipSync('const k = "AFFIDAVIT_FAKE_KEY_5566778899AABBCC";\n'),
    );
  };

  async function runAll(s: Scenario) {
    const snap = await quarantineSnapshot(s.src);
    const results: Partial<Record<ToolName, ToolRunResult>> = {};
    for (const tool of TOOLS) {
      const { sourceDir: _ignored, ...rest } = s.options(tool);
      void _ignored;
      results[tool] = await runTool(s.runner, manifest, tool, { ...rest, snapshot: snap });
    }
    return { snap, results };
  }

  async function runWithoutGate(s: Scenario, tool: ToolName) {
    const o = s.options(tool);
    const inv = buildInvocation(manifest, tool, o);
    await prepareScratch(o.scratchDir, inv.scratchSubdirs);
    await prepareOutput(o.outputDir);
    // Deliberately bypasses runTool's snapshot gate to see what the flags alone achieve.
    const res = await s.runner.run(inv.image, inv.args, inv.mounts);
    expect(isOkExit(manifest, tool, res.exitCode), `${tool} exit ${res.exitCode}`).toBe(true);
  }

  function expectHostileFindingsSurvive(s: Scenario, gitignoreReport: 'quarantine' | 'tree') {
    const semgrepFindings = sarifFindings(read(s, 'semgrep', 'semgrep.sarif'));
    // Rule files planted in the repo (.semgrep.yml, .semgrep/) must never be loaded.
    expect(semgrepFindings.some((f) => f.ruleId?.includes('planted'))).toBe(false);
    const semgrep = semgrepFindings.map((f) => f.uri);
    for (const file of [
      'src/app.js',
      'src/ignored/hidden.js',
      'src/nested/deep.js',
      'src/nosem.js',
      'src/hidden-by-gitignore.js',
    ]) {
      expect(
        semgrep.some((u) => u.endsWith(file)),
        `semgrep finding in ${file}`,
      ).toBe(true);
    }

    // A file over 1 MB is either scanned or reported by Semgrep as a notification (it may time out
    // on a slow machine), never silently absent.
    const notes = semgrepNotes(read(s, 'semgrep', 'semgrep.sarif'));
    expect(
      semgrep.some((u) => u.endsWith('src/big.js')) || notes.some((n) => n.includes('big.js')),
      'src/big.js scanned or reported',
    ).toBe(true);

    const leaksRaw = read(s, 'gitleaks', 'gitleaks.sarif');
    const leaks = sarifFindings(leaksRaw).map((f) => f.uri);
    for (const file of [
      'src/config.js',
      'src/allowed.js',
      'node_modules/leaky/index.js',
      'vendor/github.com/acme/key.js',
      'src/secret.txt.gz',
    ]) {
      expect(
        leaks.some((u) => u.endsWith(file)),
        `gitleaks finding in ${file}`,
      ).toBe(true);
    }
    expect(leaksRaw).not.toContain('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF');

    // A secret inside a file that quarantine moved aside is still found, under its original path.
    const gitignoreSource =
      gitignoreReport === 'quarantine'
        ? sarifFindings(
            readFileSync(join(`${s.out('gitleaks')}-quarantine`, 'gitleaks.sarif'), 'utf8'),
          )
        : sarifFindings(leaksRaw);
    expect(
      gitignoreSource.some((f) =>
        gitignoreReport === 'quarantine'
          ? f.uri === '/src/.gitignore'
          : f.uri.endsWith('/.gitignore'),
      ),
      '.gitignore finding',
    ).toBe(true);

    const osv = read(s, 'osv-scanner', 'osv-scanner.json');
    expect(osv).toContain('AFFIDAVIT-SMOKE-0001');
    expect(osv).toContain('AFFIDAVIT-SMOKE-0002');

    for (const tool of TOOLS) expect(existsSync(join(s.out(tool), 'canary'))).toBe(false);
  }

  function expectNoGoToolchain() {
    const stderr =
      stderrByImage.get(manifest.tools.find((t) => t.name === 'osv-scanner')?.reference ?? '') ??
      '';
    expect(stderr).not.toMatch(/govulncheck|go-build|go toolchain|\/go\/bin|cargo|rustc/i);
  }

  it('benign fixture: each tool runs offline and writes its report to the mounted output', async () => {
    const s = scenario('repo', (src) => {
      // What every real clone has: a binary index and pack files inside .git.
      mkdirSync(join(src, '.git', 'objects', 'pack'), { recursive: true });
      writeFileSync(
        join(src, '.git', 'index'),
        Buffer.from('DIRC\0\0\0\u0002\0\0\0\u0001', 'latin1'),
      );
      writeFileSync(
        join(src, '.git', 'objects', 'pack', 'p.pack'),
        Buffer.from('PACK\0\0\0\u0002', 'latin1'),
      );
      writeFileSync(join(src, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    });
    const { results } = await runAll(s);
    // A fully parsed, text-only repo is not partial for OSV or gitleaks.
    expect(results['osv-scanner']?.partial).toBe(false);
    expect(results.gitleaks?.partial).toBe(false);
    expect(results.semgrep?.partial).toBe(false);
    expect(
      sarifFindings(read(s, 'semgrep', 'semgrep.sarif')).some((f) =>
        f.ruleId?.endsWith('affidavit.smoke.no-eval'),
      ),
    ).toBe(true);
    expect(read(s, 'osv-scanner', 'osv-scanner.json')).toContain('AFFIDAVIT-SMOKE-0001');
    expect(
      sarifFindings(read(s, 'gitleaks', 'gitleaks.sarif')).some(
        (f) => f.ruleId === 'affidavit-fake-fixture-key',
      ),
    ).toBe(true);
  }, 240_000);

  it('hostile repo, after quarantine: no finding is hidden, nothing is skipped, no canary', async () => {
    const s = scenario('hostile', addGenerated);
    const { snap, results } = await runAll(s);
    // The unparsable file is a signal, not silence: Semgrep exits 0 but reports a notification.
    expect(results.semgrep?.partial).toBe(true);
    // gitleaks skips binary-looking files silently, so discovery lists them.
    expect(results.gitleaks?.partial).toBe(true);
    const skipped = results.gitleaks?.notifications.map((n) => n.message).join('\n') ?? '';
    for (const f of ['src/doc.dat', 'src/utf16.txt']) expect(skipped).toContain(`/src/${f}`);
    // Archives are always a coverage loss: gitleaks unpacks some, but not members it cannot read.
    expect(skipped).toContain('/src/src/secret.txt.gz');
    // OSV drops the malformed second lockfile without failing; discovery notices.
    expect(results['osv-scanner']?.partial).toBe(true);
    // Code hidden inside the quarantined .git was never seen by Semgrep or OSV.
    for (const tool of ['semgrep', 'osv-scanner'] as const) {
      expect(results[tool]?.notifications.some((n) => n.id === 'git-dir-extra-content')).toBe(true);
    }
    expect(skipped).toContain('/src/.git/doc.dat');
    expect(
      results['osv-scanner']?.notifications.some((n) =>
        n.message.includes('/src/extra/package-lock.json'),
      ),
    ).toBe(true);
    expect(results.semgrep?.notifications.some((n) => n.message.includes('broken.js'))).toBe(true);
    expect(snap.removed).toEqual(
      expect.arrayContaining([
        '.git',
        '.gitignore',
        '.gitleaks.toml',
        '.gitleaksignore',
        '.semgrepignore',
        'osv-scanner.toml',
        'src/nested/.semgrepignore',
      ]),
    );
    expectHostileFindingsSurvive(s, 'quarantine');
    expectNoGoToolchain();
  }, 240_000);

  it('hostile repo, flags alone (no quarantine, minus .gitleaksignore): findings survive, no canary', async () => {
    const s = scenario('hostile', addGenerated);
    // gitleaks has no flag that stops it reading a repo .gitleaksignore (next test), so that one
    // file is only ever handled by quarantine. Everything else must be covered by flags.
    rmSync(join(s.src, '.gitleaksignore'));
    for (const tool of TOOLS) await runWithoutGate(s, tool);
    expectHostileFindingsSurvive(s, 'tree');
    expectNoGoToolchain();
  }, 240_000);

  it('gitleaks still honors a repo .gitleaksignore despite our flags, which is why runTool demands quarantine', async () => {
    const s = scenario('hostile');
    await runWithoutGate(s, 'gitleaks');
    const leaks = sarifFindings(read(s, 'gitleaks', 'gitleaks.sarif')).map((f) => f.uri);
    expect(leaks.some((u) => u.endsWith('src/config.js'))).toBe(false);
    // Quarantine, then plant the file again: runTool must refuse rather than run.
    const snap = await quarantineSnapshot(s.src);
    writeFileSync(join(s.src, '.gitleaksignore'), 'x');
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    await expect(
      runTool(s.runner, manifest, 'gitleaks', {
        ...rest,
        outputDir: join(work, 'fresh-out'),
        snapshot: snap,
      }),
    ).rejects.toBeInstanceOf(SnapshotNotCleanError);
  }, 240_000);

  it('a malformed lockfile makes OSV-Scanner exit 128, which runTool fails instead of calling empty', async () => {
    const s = scenario('repo', (src) =>
      writeFileSync(join(src, 'package-lock.json'), '{ not json'),
    );
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('osv-scanner');
    void _ignored;
    await expect(
      runTool(s.runner, manifest, 'osv-scanner', { ...rest, snapshot: snap }),
    ).rejects.toBeInstanceOf(ToolFailedError);
  }, 240_000);

  it('flags every file header gitleaks is known to skip, so none is silently clean', async () => {
    const secret = 'AFFIDAVIT_FAKE_KEY_0123456789ABCDEF';
    const headers: Record<string, Buffer> = {
      mz: Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00, 0x03, 0x00])]),
      rtf: Buffer.from('{\\rtf1\\ansi'),
      ps: Buffer.from('%!PS-Adobe-3.0'),
      ar: Buffer.from('!<arch>\n'),
      crx: Buffer.from('Cr24'),
      zstd: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      cab: Buffer.concat([Buffer.from('MSCF'), Buffer.from([0, 0, 0, 0])]),
      swf: Buffer.concat([Buffer.from('FWS'), Buffer.from([9])]),
      nes: Buffer.from('NES\x1a'),
      elf: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      pdf: Buffer.from('%PDF-1.4'),
      xz: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      sevenz: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
      wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
      java: Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    };
    const s = scenario('repo', (src) => {
      mkdirSync(join(src, 'hdr'));
      for (const [name, head] of Object.entries(headers)) {
        writeFileSync(join(src, 'hdr', name), Buffer.concat([head, Buffer.from(`\n${secret}\n`)]));
      }
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'gitleaks', { ...rest, snapshot: snap });
    expect(res.partial).toBe(true);
    const messages = res.notifications.map((n) => n.message).join('\n');
    for (const name of Object.keys(headers)) expect(messages).toContain(`/src/hdr/${name} `);
  }, 240_000);

  it('a malformed root lockfile is not hidden by a good nested one', async () => {
    const s = scenario('repo', (src) => {
      writeFileSync(join(src, 'package-lock.json'), '{ not json');
      mkdirSync(join(src, 'extra'));
      cpSync(
        join(smoke, 'repo', 'package-lock.json.fixture'),
        join(src, 'extra', 'package-lock.json'),
      );
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('osv-scanner');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'osv-scanner', { ...rest, snapshot: snap });
    expect(res.partial).toBe(true);
    const messages = res.notifications.map((n) => n.message);
    expect(messages.some((m) => m.startsWith('/src/package-lock.json '))).toBe(true);
    expect(messages.some((m) => m.startsWith('/src/extra/package-lock.json '))).toBe(false);
  }, 240_000);

  it('every file type gitleaks skips is a coverage loss, with plaintext secrets behind real headers', async () => {
    const secret = Buffer.from('\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF\n');
    const files: Record<string, Buffer> = {
      'a.zip': Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), secret]),
      'a.pdf': Buffer.concat([Buffer.from('%PDF-1.4'), secret]),
      'a.sqlite': Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), secret]),
      'a.exe': Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00]), secret]),
      'a.rtf': Buffer.concat([Buffer.from('{\\rtf1'), secret]),
      'utf16.gz': gzipSync(Buffer.from('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF', 'utf16le')),
      'pdfmember.gz': gzipSync(Buffer.concat([Buffer.from('%PDF-1.4'), secret])),
      'nested.gz': gzipSync(gzipSync(secret)),
      'truncated.gz': gzipSync(Buffer.from(secret.toString().repeat(50))).subarray(0, 20),
    };
    const s = scenario('repo', (src) => {
      mkdirSync(join(src, 'bin'));
      for (const [n, b] of Object.entries(files)) writeFileSync(join(src, 'bin', n), b);
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'gitleaks', { ...rest, snapshot: snap });
    expect(res.partial).toBe(true);
    for (const n of Object.keys(files)) {
      const note = res.notifications.find((x) => x.message.startsWith(`/src/bin/${n} `));
      expect(note?.id, n).toBe('skipped-file-type');
    }
  }, 240_000);

  it('real images are read by gitleaks, and fonts are skipped even with complete headers', async () => {
    const secret = Buffer.from('\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF\n');
    const zeros = (n: number) => Buffer.alloc(n);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
      Buffer.from('IHDR'),
      zeros(17),
    ]);
    const s = scenario('repo', (src) => {
      mkdirSync(join(src, 'm'));
      writeFileSync(join(src, 'm', 'logo.png'), Buffer.concat([png, secret]));
      // complete font headers: gitleaks logs "skipping binary file" for these
      writeFileSync(
        join(src, 'm', 'a.woff'),
        Buffer.concat([Buffer.from('wOFF'), Buffer.from([0, 1, 0, 0]), zeros(24), secret]),
      );
      writeFileSync(
        join(src, 'm', 'a.woff2'),
        Buffer.concat([Buffer.from('wOF2'), Buffer.from([0, 1, 0, 0]), zeros(24), secret]),
      );
      writeFileSync(
        join(src, 'm', 'a.ttf'),
        Buffer.concat([Buffer.from([0, 1, 0, 0, 0]), zeros(24), secret]),
      );
      writeFileSync(
        join(src, 'm', 'a.otf'),
        Buffer.concat([Buffer.from('OTTO'), Buffer.from([0]), zeros(24), secret]),
      );
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'gitleaks', { ...rest, snapshot: snap });
    expect(res.binaryMediaFiles).toEqual(['/src/m/logo.png']);
    for (const f of ['a.woff', 'a.woff2', 'a.ttf', 'a.otf']) {
      const note = res.notifications.find((n) => n.message.startsWith(`/src/m/${f} `));
      expect(note?.id, f).toBe('skipped-file-type');
    }
    const found = sarifFindings(
      readFileSync(join(s.out('gitleaks'), 'gitleaks.sarif'), 'utf8'),
    ).map((f) => f.uri);
    expect(found.some((u) => u.endsWith('m/logo.png'))).toBe(true);
    expect(found.some((u) => u.endsWith('m/a.woff'))).toBe(false); // really skipped
  }, 240_000);

  it('a media signature on a file with another extension cannot switch off the checks', async () => {
    const key16 = Buffer.from('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF', 'utf16le');
    const s = scenario('repo', (src) => {
      mkdirSync(join(src, 'h'));
      writeFileSync(join(src, 'h', 'app.env'), 'GIF89a=1\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF\n');
      writeFileSync(
        join(src, 'h', 'c.js'),
        'ID3\nconst k = "AFFIDAVIT_FAKE_KEY_0123456789ABCDEF";\n',
      );
      writeFileSync(
        join(src, 'h', 'notes.txt'),
        Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0]), key16]),
      );
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'gitleaks', { ...rest, snapshot: snap });
    expect(res.partial).toBe(true);
    for (const f of ['app.env', 'c.js', 'notes.txt']) {
      const note = res.notifications.find((n) => n.message.startsWith(`/src/h/${f} `));
      expect(note?.id, f).toBe('binary-header-mismatch');
    }
  }, 240_000);

  it('flags every private key that the pinned gitleaks really misses because of a blank line inside', async () => {
    // Same layout as the probe that found the misses: 300 KB of JS with a blank line every ~1.6 KB
    // and a key with an extra line inside. gitleaks misses these keys at offsets 105,000 and
    // 186,000 (and others), and finds the same key without the extra line.
    const body = Array.from({ length: 4 }, (_, i) =>
      Buffer.from(`affidavit-fake-key-body-1-${i}-`.repeat(3)).toString('base64').slice(0, 64),
    );
    const key = (inner: string | null, begin: string, end: string) =>
      [begin, body[0], body[1], ...(inner === null ? [] : [inner]), body[2], body[3], end].join(
        '\n',
      ) + '\n';
    const filler = (bytes: number) => {
      let out = '';
      let n = 0;
      while (out.length < bytes) {
        out += `var v${n} = '${'x'.repeat(60)}';\n`;
        if (++n % 20 === 0) out += '\n';
      }
      return `${out.slice(0, bytes - 1)}\n`;
    };
    const RSA = ['-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----'] as const;
    const variants: Record<string, string> = {
      empty: key('', ...RSA),
      space: key(' ', ...RSA),
      tabs: key('\t \t', ...RSA),
      lower: key('', '-----begin rsa private key-----', '-----end rsa private key-----'),
      under: key('', '-----BEGIN_RSA_PRIVATE KEY-----', '-----END_RSA_PRIVATE KEY-----'),
    };
    const files: string[] = [];
    const s = scenario('repo', (src) => {
      mkdirSync(join(src, 'k'));
      for (const [name, k] of Object.entries(variants)) {
        for (const off of [105_000, 186_000]) {
          const f = `k_${name}_${off}.js`;
          files.push(f);
          writeFileSync(join(src, 'k', f), filler(off) + k + filler(300_000 - off - k.length));
        }
      }
      // control: the same key without the extra line is found by gitleaks and not flagged
      writeFileSync(
        join(src, 'k', 'k_control.js'),
        filler(105_000) + key(null, ...RSA) + filler(300_000 - 105_000 - key(null, ...RSA).length),
      );
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'gitleaks', { ...rest, snapshot: snap });
    const keyFindings = JSON.parse(
      readFileSync(join(s.out('gitleaks'), 'gitleaks.sarif'), 'utf8'),
    ) as {
      runs: {
        results?: {
          ruleId?: string;
          locations?: { physicalLocation?: { artifactLocation?: { uri?: string } } }[];
        }[];
      }[];
    };
    const found = new Set(
      keyFindings.runs
        .flatMap((r) => r.results ?? [])
        .filter((x) => x.ruleId === 'private-key')
        .map((x) => x.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? ''),
    );
    const flagged = new Set(
      res.notifications
        .filter((n) => n.id === 'multiline-split-risk')
        .map((n) => n.message.split(' ')[0]),
    );
    for (const f of files) {
      // the pinned gitleaks really misses this key ...
      expect(
        [...found].some((u) => u.endsWith(`k/${f}`)),
        `gitleaks should miss ${f}`,
      ).toBe(false);
      // ... and discovery says so
      expect(flagged.has(`/src/k/${f}`), `discovery should flag ${f}`).toBe(true);
    }
    expect([...found].some((u) => u.endsWith('k/k_control.js'))).toBe(true);
    expect(flagged.has('/src/k/k_control.js')).toBe(false);
    expect(res.partial).toBe(true);
  }, 300_000);

  describe('secrets the pinned gitleaks misses at a chunk cut', () => {
    // A tiny seeded generator keeps every run reproducible.
    const rng = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const randomChars = (r: () => number, n: number, set = ALNUM) =>
      Array.from({ length: n }, () => set[Math.floor(r() * set.length)]).join('');

    const body = Array.from({ length: 4 }, (_, i) =>
      Buffer.from(`affidavit-fake-key-body-1-${i}-`.repeat(3)).toString('base64').slice(0, 64),
    );
    const pem = (above = '', afterHeader = '') =>
      `${above}-----BEGIN RSA PRIVATE KEY-----\n${afterHeader}${body[0]}\n${body[1]}\n\n${body[2]}\n${body[3]}\n-----END RSA PRIVATE KEY-----\n`;
    /** JS with a blank line every ~1.6 KB, the layout of the probe that found the misses. */
    const filler = (bytes: number) => {
      let out = '';
      let n = 0;
      while (out.length < bytes) {
        out += `var v${n} = '${'x'.repeat(60)}';\n`;
        if (++n % 20 === 0) out += '\n';
      }
      return `${out.slice(0, bytes - 1)}\n`;
    };
    /** Lines with no blank line at all. */
    const dense = (bytes: number) => {
      const line = `${'x'.repeat(79)}\n`;
      return line.repeat(Math.floor(bytes / 80)) + 'y'.repeat(bytes % 80);
    };

    type Findings = { ruleId?: string; uri: string }[];
    const mainFindings = (sc: Scenario): Findings =>
      sarifFindings(readFileSync(join(sc.out('gitleaks'), 'gitleaks.sarif'), 'utf8')).map((f) => ({
        ruleId: f.ruleId,
        uri: f.uri,
      }));
    const windowFindings = (res: ToolRunResult): Findings => {
      const rep = res.reports.find((r) => r.origin === 'windows');
      return rep
        ? sarifFindings(readFileSync(rep.file, 'utf8')).map((f) => ({
            ruleId: f.ruleId,
            uri: f.uri,
          }))
        : [];
    };
    const has = (f: Findings, rule: string, path: string) =>
      f.some((x) => x.ruleId === rule && x.uri.endsWith(path));

    async function runGitleaks(sc: Scenario) {
      const snap = await quarantineSnapshot(sc.src);
      const { sourceDir: _ignored, ...rest } = sc.options('gitleaks');
      void _ignored;
      return runTool(sc.runner, manifest, 'gitleaks', { ...rest, snapshot: snap });
    }

    it('decoy begin markers cannot hide a key: gitleaks misses it, the windows pass finds it, and it is flagged', async () => {
      const decoys: Record<string, string> = {
        commentAbove: pem('// -----BEGIN RSA PRIVATE KEY-----\n'),
        noCloseAbove: pem('-----BEGIN PRIVATE KEY\n'),
        kilobyteAbove: pem(`# see -----BEGIN PRIVATE KEY----- in the docs\n${'z'.repeat(1000)}\n`),
        fakeCloseAfterHeader: pem('', 'xKEY-----\n'),
      };
      const files: string[] = [];
      const sc = scenario('repo', (src) => {
        mkdirSync(join(src, 'd'));
        for (const [name, k] of Object.entries(decoys)) {
          for (const off of [105_000, 186_000]) {
            const f = `d_${name}_${off}.js`;
            files.push(f);
            writeFileSync(join(src, 'd', f), filler(off) + k + filler(300_000 - off - k.length));
          }
        }
      });
      const res = await runGitleaks(sc);
      const main = mainFindings(sc);
      const win = windowFindings(res);
      const flagged = new Set(
        res.notifications
          .filter((n) => n.id === 'multiline-split-risk')
          .map((n) => n.message.split(' ')[0]),
      );
      // Whether gitleaks alone misses a given file depends on where its cuts fall relative to the
      // key; some of these are found. The test needs real misses to mean anything, and for every
      // file discovery must find it in the windows pass and flag it.
      const missed = files.filter((f) => !has(main, 'private-key', `d/${f}`));
      expect(missed.length, 'gitleaks alone really misses several of these').toBeGreaterThanOrEqual(
        4,
      );
      for (const f of files) {
        expect(has(win, 'private-key', `d/${f}`), `windows pass should find ${f}`).toBe(true);
        expect(flagged.has(`/src/d/${f}`), `${f} should be flagged`).toBe(true);
      }
    }, 300_000);

    it('a whitespace-only line that straddles byte 100,000 cannot hide a token across the hard cut', async () => {
      const r = rng(42);
      const token = `ghp_${randomChars(r, 36)}`;
      // 100,000 bytes ending "y\n " (newline at 99,998, space at 99,999), then 300 spaces and a
      // newline, then non-blank lines, with the token across offset 125,001
      const head = `${'x'.repeat(79)}\n`.repeat(1249) + `${'x'.repeat(77)}y\n `;
      const ws = `${' '.repeat(300)}\n`;
      const pre = head + ws;
      const before = dense(124_990 - pre.length);
      const text = `${pre}${before}token ${token}\n${dense(20_000)}`;
      expect(text.indexOf(token)).toBeLessThan(125_001);
      expect(text.indexOf(token) + token.length).toBeGreaterThan(125_001);
      const sc = scenario('repo', (src) => writeFileSync(join(src, 'src', 'straddle.txt'), text));
      const res = await runGitleaks(sc);
      expect(
        has(mainFindings(sc), 'github-pat', 'src/straddle.txt'),
        'gitleaks alone should miss it',
      ).toBe(false);
      expect(
        has(windowFindings(res), 'github-pat', 'src/straddle.txt'),
        'windows pass finds it',
      ).toBe(true);
      expect(
        res.notifications.some(
          (n) => n.id === 'chunk-split-risk' && n.message.includes('straddle.txt'),
        ),
      ).toBe(true);
    }, 300_000);

    it('a keyword and value split by a blank line just past byte 100,000 are found by the windows pass', async () => {
      const r = rng(7);
      const hex = (n: number) => randomChars(r, n, '0123456789abcdef');
      const uuid = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
      const text = `${dense(99_985)}heroku_api_key =\n\n"${uuid}"\n${dense(30_000)}`;
      const sc = scenario('repo', (src) => writeFileSync(join(src, 'src', 'heroku.txt'), text));
      const res = await runGitleaks(sc);
      expect(
        has(mainFindings(sc), 'heroku-api-key', 'src/heroku.txt'),
        'gitleaks alone should miss it',
      ).toBe(false);
      expect(
        has(windowFindings(res), 'heroku-api-key', 'src/heroku.txt'),
        'windows pass finds it',
      ).toBe(true);
      expect(res.windowedFiles).toContain('/src/src/heroku.txt');
    }, 300_000);

    for (const lead of ['MZ', '%PDF']) {
      it(`windows that would start with ${JSON.stringify(lead)} are not skipped as binary`, async () => {
        const r = rng(11);
        const hex = (n: number) => randomChars(r, n, '0123456789abcdef');
        const uuid = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
        // every line starts with the signature; the first line does not, so the whole file is text
        const line = `${lead}${'x'.repeat(78 - lead.length)}\n`;
        const lines = (bytes: number) => line.repeat(Math.floor(bytes / 80));
        const head = 'start\n';
        // 6 + 99,920 + 59 = 99,985: the keyword starts before byte 100,000, as in the plain case
        const text = `${head}${lines(99_920)}${'y'.repeat(59)}heroku_api_key =\n\n"${uuid}"\n${lines(60_000)}`;
        const name = lead === 'MZ' ? 'mz.txt' : 'pdf.txt';
        const sc = scenario('repo', (src) => writeFileSync(join(src, 'src', name), text));
        const res = await runGitleaks(sc);
        // Whether gitleaks alone finds this one depends on its cuts, so the test does not rely on
        // it. The point is the windows pass: the window that holds the key starts at a line that
        // begins with the signature, and without the neutral first line gitleaks skips it.
        expect(
          has(windowFindings(res), 'heroku-api-key', `src/${name}`),
          'windows pass finds it',
        ).toBe(true);
      }, 300_000);
    }

    it('path-scoped rules still fire on windows: a Kubernetes secret split by a blank line in a yaml file', async () => {
      const r = rng(5);
      const b64 = Buffer.from(randomChars(r, 24)).toString('base64');
      const pad = `${'p'.repeat(69)}\n`;
      const text = `${`${'x'.repeat(79)}\n`.repeat(1249)}${pad}kind: Secret\ndata:\n\n  dsn: ${b64}\n${`${'x'.repeat(79)}\n`.repeat(400)}`;
      expect(text.indexOf('data:\n\n')).toBeGreaterThan(100_000);
      const sc = scenario('repo', (src) => {
        mkdirSync(join(src, 'deploy'));
        writeFileSync(join(src, 'deploy', 'cut.yaml'), text);
      });
      const res = await runGitleaks(sc);
      expect(
        has(mainFindings(sc), 'kubernetes-secret-yaml', 'deploy/cut.yaml'),
        'gitleaks alone should miss it',
      ).toBe(false);
      expect(
        has(windowFindings(res), 'kubernetes-secret-yaml', 'deploy/cut.yaml'),
        'windows pass finds it',
      ).toBe(true);
    }, 300_000);

    describe('names gitleaks reads as archives', () => {
      // plain text under names that make the pinned gitleaks try to extract it and drop it. Every
      // token of the probed rule is here, in lower and upper case, mid-name and as the extension.
      const dropped = [
        'a.gz',
        'a.zip',
        'a.tar',
        'a.tar.gz',
        'a.tar.bz2',
        'a.tar.zst',
        'a.bz2',
        'a.xz',
        'a.zst',
        'a.lz4',
        'a.lz',
        'a.br',
        'a.sz',
        'a.mz',
        'a.7z',
        'a.rar',
        'a.zipx',
        'a.zz',
        'a.gzip',
        'a.zstd',
        'a.tarx',
        'a.gzx',
        'case1.GZ',
        'case2.Zip',
        'case3.TAR',
        'case4.MZ',
        'a.gz.txt',
        'a.zip.js',
        'config.zip.env',
        'a.xz.yaml',
        'a.tar.foo',
        'a.7z.txt',
        'a.rar.cfg',
        'a.br.json',
        'a.sz.md',
        'a.zz.py',
      ];
      const scanned = [
        'a.tgz',
        'a.tbz2',
        'a.jar',
        'a.war',
        'a.Z',
        'a.lzma',
        'a.cpio',
        'a.rpm',
        'a.lz.txt',
        'a.mz.txt',
        'plain.txt',
      ];
      const secret = 'const k = "AFFIDAVIT_FAKE_KEY_0123456789ABCDEF";\n';

      it('every probed name is flagged, dropped by gitleaks alone, and found in a window', async () => {
        const sc = scenario('repo', (src) => {
          mkdirSync(join(src, 'n'));
          for (const n of [...dropped, ...scanned]) writeFileSync(join(src, 'n', n), secret);
        });
        const res = await runGitleaks(sc);
        const main = mainFindings(sc);
        const win = windowFindings(res);
        const flagged = new Set(
          res.notifications
            .filter((x) => x.id === 'archive-name-mismatch')
            .map((x) => x.message.split(' ')[0]),
        );
        for (const n of dropped) {
          const rule = 'affidavit-fake-fixture-key';
          expect(has(main, rule, `n/${n}`), `gitleaks alone should drop ${n}`).toBe(false);
          expect(flagged.has(`/src/n/${n}`), `${n} should be flagged`).toBe(true);
          expect(has(win, rule, `n/${n}`), `${n} should be found in a window`).toBe(true);
        }
        for (const n of scanned) {
          expect(
            has(main, 'affidavit-fake-fixture-key', `n/${n}`),
            `${n} is scanned normally`,
          ).toBe(true);
          expect(flagged.has(`/src/n/${n}`), `${n} is not flagged`).toBe(false);
        }
      }, 300_000);
    });

    describe('columns of windows findings', () => {
      const K = 'AFFIDAVIT_FAKE_KEY_0123456789ABCDEF';
      type Region = {
        startLine?: number;
        endLine?: number;
        startColumn?: number;
        endColumn?: number;
      };
      const regionsOf = (raw: string, path: string): string[] => {
        const doc = JSON.parse(raw) as {
          runs: {
            results?: {
              ruleId?: string;
              locations?: {
                physicalLocation?: { artifactLocation?: { uri?: string }; region?: Region };
              }[];
            }[];
          }[];
        };
        return doc.runs
          .flatMap((r) => r.results ?? [])
          .filter((x) => x.ruleId === 'affidavit-fake-fixture-key')
          .flatMap((x) => x.locations ?? [])
          .filter((l) => l.physicalLocation?.artifactLocation?.uri?.endsWith(path))
          .map((l) => {
            const g = l.physicalLocation?.region;
            return `${g?.startLine}:${g?.startColumn}-${g?.endLine}:${g?.endColumn}`;
          })
          .sort();
      };
      const tail = (n: number) => `${'z'.repeat(79)}\n`.repeat(Math.ceil(n / 80));

      it('remapped columns equal the snapshot pass for LF, CRLF, minified and multibyte text', async () => {
        const cases: Record<string, string> = {
          'lf.txt': `x = "${K}"\nline two\ny = "${K}"\n${tail(110_000)}`,
          'crlf.txt': `x = "${K}"\r\nline two\r\ny = "${K}"\r\n${tail(110_000)}`,
          'min.txt': `${'a'.repeat(50)} "${K}" ${'b'.repeat(40)} "${K}" end${'c'.repeat(110_000)}`,
          'utf8.txt': `é€é€é€ "${K}"\nüñí "${K}"\n${tail(110_000)}`,
        };
        const sc = scenario('repo', (src) => {
          mkdirSync(join(src, 'c'));
          for (const [n, t] of Object.entries(cases)) writeFileSync(join(src, 'c', n), t);
        });
        const res = await runGitleaks(sc);
        const snapshotRaw = readFileSync(join(sc.out('gitleaks'), 'gitleaks.sarif'), 'utf8');
        const windowRaw = readFileSync(
          res.reports.find((r) => r.origin === 'windows')?.file ?? '',
          'utf8',
        );
        for (const n of Object.keys(cases)) {
          const fromSnapshot = regionsOf(snapshotRaw, `c/${n}`);
          expect(fromSnapshot.length, `${n}: findings in the snapshot pass`).toBe(2);
          // all findings are in the first 100 KB chunk, where the snapshot pass's columns are right
          expect(regionsOf(windowRaw, `c/${n}`), n).toEqual(fromSnapshot);
        }
      }, 300_000);
    });

    it('seeded sweep: a decoy-wrapped key is always found or flagged, never silently missed', async () => {
      const r = rng(2024);
      const shapes = [
        (k: string) => k,
        (k: string) => `// -----BEGIN PRIVATE KEY\n${k}`,
        (k: string) => `-----BEGIN RSA PRIVATE KEY-----\n${k}`,
        (k: string) => `${'#'.repeat(500)} -----BEGIN PRIVATE KEY-----\n${k}`,
      ];
      const picks: { f: string; k: string; off: number }[] = [];
      for (let i = 0; i < 12; i++) {
        const k = shapes[Math.floor(r() * shapes.length)]!(pem());
        const off = 96_000 + Math.floor(r() * 38) * 3_000;
        picks.push({ f: `sweep_${i}_${off}.js`, k, off });
      }
      const sc = scenario('repo', (src) => {
        mkdirSync(join(src, 'sw'));
        for (const p of picks) {
          writeFileSync(
            join(src, 'sw', p.f),
            filler(p.off) + p.k + filler(300_000 - p.off - p.k.length),
          );
        }
      });
      const res = await runGitleaks(sc);
      const main = mainFindings(sc);
      const win = windowFindings(res);
      const flagged = new Set(res.notifications.map((n) => n.message.split(' ')[0]));
      for (const p of picks) {
        const ok =
          has(main, 'private-key', `sw/${p.f}`) ||
          has(win, 'private-key', `sw/${p.f}`) ||
          flagged.has(`/src/sw/${p.f}`);
        expect(ok, `silently missed: ${p.f} at ${p.off}`).toBe(true);
      }
    }, 300_000);
  });

  it('flags a secret that straddles gitleaks chunk boundary, in dense lines and in one long line', async () => {
    const secret = 'AFFIDAVIT_FAKE_KEY_0123456789ABCDEF';
    const s = scenario('repo', (src) => {
      // 80-character lines with no blank line; the key crosses byte 125,000.
      const dense = Buffer.alloc(130_000, 0x61);
      for (let i = 79; i < dense.length; i += 80) dense[i] = 0x0a;
      dense.write(secret, 124_990);
      writeFileSync(join(src, 'src', 'dense.txt'), dense);
      // the same in a single long line
      const one = Buffer.alloc(130_000, 0x62);
      one.write(secret, 124_990);
      writeFileSync(join(src, 'src', 'oneline.txt'), one);
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'gitleaks', { ...rest, snapshot: snap });
    expect(res.partial).toBe(true);
    const risk = res.notifications.filter((n) => n.id === 'chunk-split-risk').map((n) => n.message);
    expect(risk.some((m) => m.includes('/src/src/dense.txt'))).toBe(true);
    expect(risk.some((m) => m.includes('/src/src/oneline.txt'))).toBe(true);
  }, 240_000);

  // Names OSV-Scanner 2.7.0 reacted to in a probe that were not on discovery's list before.
  for (const name of [
    'bom.xml',
    'sbom.spdx',
    'app.spdx.json',
    'x.spdx.yml',
    'x.spdx.rdf',
    'app.deps.json',
    'Directory.Packages.props',
  ]) {
    it(`a lone unparseable ${name} is a failure or a partial result, never silently clean`, async () => {
      const s = scenario('repo', (src) => {
        rmSync(join(src, 'package.json'));
        rmSync(join(src, 'package-lock.json'));
        writeFileSync(join(src, name), 'garbage {{{ not valid\n');
      });
      const snap = await quarantineSnapshot(s.src);
      const { sourceDir: _ignored, ...rest } = s.options('osv-scanner');
      void _ignored;
      const outcome: ToolRunResult | Error = await runTool(s.runner, manifest, 'osv-scanner', {
        ...rest,
        snapshot: snap,
      }).catch((e: unknown) => e as Error);
      if (outcome instanceof Error) expect(outcome).toBeInstanceOf(ToolFailedError);
      else expect(outcome.partial).toBe(true);
    }, 240_000);
  }

  it('OSV-Scanner exits 128 with no report when there is nothing to scan, which runTool reports as empty', async () => {
    const s = scenario('repo', (src) => {
      rmSync(join(src, 'package.json'));
      rmSync(join(src, 'package-lock.json'));
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('osv-scanner');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'osv-scanner', { ...rest, snapshot: snap });
    expect(res).toMatchObject({ empty: true, exitCode: 128 });
  }, 240_000);
});
