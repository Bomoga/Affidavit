/**
 * Docker smoke tests. The Docker half is skipped unless AFFIDAVIT_DOCKER_TESTS=1, so plain
 * `pnpm test` (and CI, which has no tool images) never runs it. Run with:
 *   AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker
 * PowerShell: $env:AFFIDAVIT_DOCKER_TESTS = '1'; pnpm --filter @affidavit/discovery test:docker
 *
 * Each tool runs from its pinned digest with --network none against fixtures/corpus/tool-smoke and
 * writes its report into the mounted output dir.
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
  prepareScratch,
  quarantineToolControlPaths,
  repoRoot,
  runTool,
  type ToolName,
  type ToolRunOptions,
} from './index.js';

const enabled = process.env['AFFIDAVIT_DOCKER_TESTS'] === '1';
const manifest = loadToolManifest();
const smoke = join(repoRoot(), 'fixtures', 'corpus', 'tool-smoke');

/**
 * The jail flags this test uses. They mirror buildDockerRunArgs in packages/testing/src/infra.ts,
 * which discovery cannot import (it is not a dependency). The pin test below fails if the two
 * drift apart, so the smoke run keeps testing what the fake runner actually does.
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

function makeRunner(outputDir: string): ToolRunnerPort {
  return {
    run(image, args, mounts) {
      return new Promise((resolve) => {
        execFile(
          'docker',
          dockerRunArgs(image, args, mounts),
          { maxBuffer: 16 * 1024 * 1024 },
          (error, _out, stderr) => {
            const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            if (exitCode !== 0) process.stderr.write(stderr);
            resolve({ exitCode, outputPath: outputDir });
          },
        );
      });
    },
  };
}

describe('smoke test jail flags', () => {
  it('match the flags the fake ToolRunner uses', () => {
    const infra = readFileSync(join(repoRoot(), 'packages', 'testing', 'src', 'infra.ts'), 'utf8');
    for (const flag of JAIL_FLAGS) expect(infra).toContain(`'${flag}'`);
    expect(JAIL_FLAGS).toEqual(expect.arrayContaining(['--network', 'none', '--read-only']));
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
 * dropped (so .json data does not look like a contract fixture) and a `dot-` prefix becomes `.`
 * (so planted .git, .gitignore and friends are not live files inside this repository).
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
  let counter = 0;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'affidavit-tools-'));
    osvDb = join(work, 'osv-db');
    mkdirSync(join(osvDb, 'npm'), { recursive: true });
    const advisory = readFileSync(
      join(smoke, 'osv-advisories', 'AFFIDAVIT-SMOKE-0001.json.fixture'),
    );
    writeFileSync(join(osvDb, 'npm', 'all.zip'), storedZip('AFFIDAVIT-SMOKE-0001.json', advisory));
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** A fresh snapshot, output dir and per-tool scratch dirs for one scenario. */
  function scenario(fixture: string) {
    const id = `s${++counter}`;
    const src = join(work, id, 'src');
    const out = join(work, id, 'out');
    materialize(join(smoke, fixture), src);
    mkdirSync(out, { recursive: true });
    const options = (tool: ToolName): ToolRunOptions => ({
      sourceDir: src,
      outputDir: out,
      scratchDir: join(work, id, `scratch-${tool}`),
      rulesDir: join(smoke, 'rules', 'semgrep'),
      // Our committed config plus the fixture rule that recognises the obviously fake key.
      configDir: tool === 'gitleaks' ? join(smoke, 'rules', 'gitleaks') : undefined,
      gitleaksConfigFile: tool === 'gitleaks' ? 'affidavit-fixture.toml' : undefined,
      osvDatabaseDir: osvDb,
    });
    return { src, out, options, runner: makeRunner(out) };
  }

  const read = (out: string, file: string) => readFileSync(join(out, file), 'utf8');

  function expectHostileFindingsSurvive(out: string) {
    const semgrep = sarifFindings(read(out, 'semgrep.sarif')).map((f) => f.uri);
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

    const leaks = sarifFindings(read(out, 'gitleaks.sarif')).map((f) => f.uri);
    expect(leaks.some((u) => u.endsWith('src/config.js'))).toBe(true);
    expect(leaks.some((u) => u.endsWith('src/allowed.js'))).toBe(true);
    expect(read(out, 'gitleaks.sarif')).not.toContain('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF');

    const osv = read(out, 'osv-scanner.json');
    expect(osv).toContain('AFFIDAVIT-SMOKE-0001');

    expect(existsSync(join(out, 'canary'))).toBe(false);
  }

  it('benign fixture: each tool runs offline and writes its report to the mounted output', async () => {
    const s = scenario('repo');
    for (const tool of ['semgrep', 'osv-scanner', 'gitleaks'] as const) {
      const res = await runTool(s.runner, manifest, tool, s.options(tool));
      expect(res.ok, `${tool} exit ${res.exitCode}`).toBe(true);
    }
    expect(
      sarifFindings(read(s.out, 'semgrep.sarif')).some((f) =>
        f.ruleId?.endsWith('affidavit.smoke.no-eval'),
      ),
    ).toBe(true);
    expect(read(s.out, 'osv-scanner.json')).toContain('AFFIDAVIT-SMOKE-0001');
    expect(
      sarifFindings(read(s.out, 'gitleaks.sarif')).some(
        (f) => f.ruleId === 'affidavit-fake-fixture-key',
      ),
    ).toBe(true);
  }, 240_000);

  it('hostile repo, after quarantine: no finding is hidden and no canary is written', async () => {
    const s = scenario('hostile');
    const removed = await quarantineToolControlPaths(s.src);
    expect(removed).toEqual(
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
    for (const tool of ['semgrep', 'osv-scanner', 'gitleaks'] as const) {
      const res = await runTool(s.runner, manifest, tool, s.options(tool));
      expect(res.ok, `${tool} exit ${res.exitCode}`).toBe(true);
    }
    expectHostileFindingsSurvive(s.out);
  }, 240_000);

  async function runWithoutGate(s: ReturnType<typeof scenario>, tool: ToolName) {
    const o = s.options(tool);
    const inv = buildInvocation(manifest, tool, o);
    await prepareScratch(o.scratchDir, inv.scratchSubdirs);
    // Deliberately bypasses runTool's snapshot gate to see what the flags alone achieve.
    const res = await s.runner.run(inv.image, inv.args, inv.mounts);
    expect(isOkExit(manifest, tool, res.exitCode)).toBe(true);
  }

  it('hostile repo, flags alone (no quarantine, minus .gitleaksignore): findings survive, no canary', async () => {
    const s = scenario('hostile');
    // gitleaks has no flag that stops it reading a repo .gitleaksignore (next test), so that one
    // file is only ever handled by quarantine. Everything else must be covered by flags.
    rmSync(join(s.src, '.gitleaksignore'));
    for (const tool of ['semgrep', 'osv-scanner', 'gitleaks'] as const)
      await runWithoutGate(s, tool);
    expectHostileFindingsSurvive(s.out);
  }, 240_000);

  it('gitleaks still honors a repo .gitleaksignore despite our flags, which is why runTool demands quarantine', async () => {
    const s = scenario('hostile');
    await runWithoutGate(s, 'gitleaks');
    const leaks = sarifFindings(read(s.out, 'gitleaks.sarif')).map((f) => f.uri);
    expect(leaks.some((u) => u.endsWith('src/config.js'))).toBe(false);
    await expect(runTool(s.runner, manifest, 'gitleaks', s.options('gitleaks'))).rejects.toThrow(
      /quarantine/,
    );
  }, 240_000);
});
