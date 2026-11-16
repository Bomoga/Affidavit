/**
 * Docker smoke tests. Skipped unless AFFIDAVIT_DOCKER_TESTS=1, so plain `pnpm test` (and CI, which
 * has no tool images) never runs them. Run with:
 *   AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker
 * PowerShell: $env:AFFIDAVIT_DOCKER_TESTS = '1'; pnpm --filter @affidavit/discovery test:docker
 *
 * Each tool runs from its pinned digest with --network none against fixtures/corpus/tool-smoke and
 * writes SARIF into the mounted output dir. The docker flags mirror LocalDockerToolRunner in
 * @affidavit/testing (no network, read-only root, no capabilities).
 */
import { execFile } from 'node:child_process';
import { crc32 } from 'node:zlib';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildInvocation,
  isOkExit,
  loadToolManifest,
  repoRoot,
  type ToolInvocation,
  type ToolName,
  type ToolRunOptions,
} from './index.js';

const enabled = process.env['AFFIDAVIT_DOCKER_TESTS'] === '1';
const manifest = loadToolManifest();
const smoke = join(repoRoot(), 'fixtures', 'corpus', 'tool-smoke');

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

function dockerRun(inv: ToolInvocation): Promise<{ code: number; stderr: string }> {
  const args = [
    'run',
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
    ...inv.mounts.flatMap((m) => [
      '-v',
      `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`,
    ]),
    inv.image,
    ...inv.args,
  ];
  return new Promise((resolve) => {
    execFile('docker', args, { maxBuffer: 16 * 1024 * 1024 }, (error, _out, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stderr });
    });
  });
}

describe.skipIf(!enabled)('tool images, offline smoke run', () => {
  let work: string;
  let opts: ToolRunOptions;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'affidavit-tools-'));
    const osvDb = join(work, 'osv-db');
    mkdirSync(join(osvDb, 'npm'), { recursive: true });
    const advisory = readFileSync(
      join(smoke, 'osv-advisories', 'AFFIDAVIT-SMOKE-0001.json.fixture'),
    );
    writeFileSync(join(osvDb, 'npm', 'all.zip'), storedZip('AFFIDAVIT-SMOKE-0001.json', advisory));
    // Data files carry a .fixture suffix so repo-wide fixture walkers do not treat them as contracts.
    const src = join(work, 'src');
    cpSync(join(smoke, 'repo'), src, { recursive: true });
    for (const f of ['package.json', 'package-lock.json'])
      renameSync(join(src, f + '.fixture'), join(src, f));
    mkdirSync(join(work, 'out'));
    opts = {
      sourceDir: src,
      outputDir: join(work, 'out'),
      scratchDir: join(work, 'scratch'),
      osvDatabaseDir: osvDb,
    };
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  async function run(name: ToolName, extra: Partial<ToolRunOptions>) {
    const inv = buildInvocation(manifest, name, { ...opts, ...extra });
    for (const sub of inv.scratchSubdirs)
      mkdirSync(join(opts.scratchDir, sub), { recursive: true });
    const res = await dockerRun(inv);
    expect(isOkExit(manifest, name, res.code), `exit ${res.code}: ${res.stderr}`).toBe(true);
    const raw = readFileSync(join(opts.outputDir, inv.outputFile), 'utf8');
    const sarif = JSON.parse(raw) as { runs: { results?: { ruleId?: string }[] }[] };
    return { raw, results: sarif.runs.flatMap((r) => r.results ?? []) };
  }

  it('semgrep finds the planted eval using only our rule file', async () => {
    const { results } = await run('semgrep', { rulesDir: join(smoke, 'rules', 'semgrep') });
    expect(results.some((r) => r.ruleId?.endsWith('affidavit.smoke.no-eval'))).toBe(true);
  }, 180_000);

  it('osv-scanner matches the vendored advisory without network', async () => {
    const { raw, results } = await run('osv-scanner', {});
    expect(results.length).toBeGreaterThan(0);
    expect(raw).toContain('AFFIDAVIT-SMOKE-0001');
  }, 180_000);

  it('gitleaks finds the fake key and redacts it in the report', async () => {
    const { raw, results } = await run('gitleaks', {
      rulesDir: join(smoke, 'rules', 'gitleaks'),
      gitleaksConfigFile: 'affidavit-fixture.toml',
    });
    expect(results.some((r) => r.ruleId === 'affidavit-fake-fixture-key')).toBe(true);
    expect(raw).not.toContain('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF');
  }, 180_000);
});
