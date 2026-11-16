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
import { crc32 } from 'node:zlib';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildInvocation,
  isOkExit,
  loadToolManifest,
  prepareOutput,
  prepareScratch,
  QuarantinedSnapshot,
  quarantineSnapshot,
  repoRoot,
  runTool,
  type ToolName,
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
      const out = mounts.find((m) => m.containerPath === '/out')?.hostPath ?? '';
      return new Promise((resolve) => {
        execFile(
          'docker',
          dockerRunArgs(image, args, mounts),
          { maxBuffer: 16 * 1024 * 1024 },
          (error, _out, stderr) => {
            const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            stderrByImage.set(image, stderr);
            resolve({ exitCode, outputPath: out });
          },
        );
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
  const addBigFile = (src: string) =>
    writeFileSync(
      join(src, 'src', 'big.js'),
      'export const run = (x) => eval(x);\n' + '// padding\n'.repeat(120_000),
    );

  async function runAll(s: Scenario) {
    const snap = await quarantineSnapshot(s.src);
    for (const tool of TOOLS) {
      const { sourceDir: _ignored, ...rest } = s.options(tool);
      void _ignored;
      const res = await runTool(s.runner, manifest, tool, { ...rest, snapshot: snap });
      expect(res.ok, `${tool} exit ${res.exitCode}`).toBe(true);
    }
    return snap;
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

  function expectHostileFindingsSurvive(s: Scenario) {
    const semgrep = sarifFindings(read(s, 'semgrep', 'semgrep.sarif')).map((f) => f.uri);
    for (const file of [
      'src/app.js',
      'src/ignored/hidden.js',
      'src/nested/deep.js',
      'src/nosem.js',
      'src/hidden-by-gitignore.js',
      'src/big.js',
    ]) {
      expect(
        semgrep.some((u) => u.endsWith(file)),
        `semgrep finding in ${file}`,
      ).toBe(true);
    }

    const leaksRaw = read(s, 'gitleaks', 'gitleaks.sarif');
    const leaks = sarifFindings(leaksRaw).map((f) => f.uri);
    for (const file of [
      'src/config.js',
      'src/allowed.js',
      'node_modules/leaky/index.js',
      'vendor/github.com/acme/key.js',
    ]) {
      expect(
        leaks.some((u) => u.endsWith(file)),
        `gitleaks finding in ${file}`,
      ).toBe(true);
    }
    expect(leaksRaw).not.toContain('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF');

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
    const s = scenario('repo');
    await runAll(s);
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
    const s = scenario('hostile', addBigFile);
    const snap = await runAll(s);
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
    expectHostileFindingsSurvive(s);
    expectNoGoToolchain();
  }, 240_000);

  it('hostile repo, flags alone (no quarantine, minus .gitleaksignore): findings survive, no canary', async () => {
    const s = scenario('hostile', addBigFile);
    // gitleaks has no flag that stops it reading a repo .gitleaksignore (next test), so that one
    // file is only ever handled by quarantine. Everything else must be covered by flags.
    rmSync(join(s.src, '.gitleaksignore'));
    for (const tool of TOOLS) await runWithoutGate(s, tool);
    expectHostileFindingsSurvive(s);
    expectNoGoToolchain();
  }, 240_000);

  it('gitleaks still honors a repo .gitleaksignore despite our flags, which is why runTool demands quarantine', async () => {
    const s = scenario('hostile');
    await runWithoutGate(s, 'gitleaks');
    const leaks = sarifFindings(read(s, 'gitleaks', 'gitleaks.sarif')).map((f) => f.uri);
    expect(leaks.some((u) => u.endsWith('src/config.js'))).toBe(false);
    const { sourceDir: _ignored, ...rest } = s.options('gitleaks');
    void _ignored;
    await expect(
      runTool(s.runner, manifest, 'gitleaks', {
        ...rest,
        outputDir: join(work, 'fresh-out'),
        snapshot: new QuarantinedSnapshot(s.src, []),
      }),
    ).rejects.toThrow(/quarantine/);
  }, 240_000);

  it('OSV-Scanner exits 128 with no report when there is nothing to scan, which runTool reports as empty', async () => {
    const s = scenario('repo', (src) => {
      rmSync(join(src, 'package.json'));
      rmSync(join(src, 'package-lock.json'));
    });
    const snap = await quarantineSnapshot(s.src);
    const { sourceDir: _ignored, ...rest } = s.options('osv-scanner');
    void _ignored;
    const res = await runTool(s.runner, manifest, 'osv-scanner', { ...rest, snapshot: snap });
    expect(res).toMatchObject({ ok: true, empty: true, exitCode: 128 });
  }, 240_000);
});
