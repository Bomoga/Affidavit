/**
 * Recorder for the golden inputs in fixtures/corpus/normalize/recorded. Skipped unless both
 * AFFIDAVIT_DOCKER_TESTS=1 and AFFIDAVIT_RECORD_DIR (an empty directory to write into) are set:
 *   AFFIDAVIT_DOCKER_TESTS=1 AFFIDAVIT_RECORD_DIR=/tmp/rec pnpm --filter @affidavit/discovery exec vitest run record.docker
 * It runs the pinned Semgrep and OSV-Scanner images through the L1-02 wrappers (runTool), offline,
 * against fixtures/corpus/normalize/repo, with our own rules and a synthetic offline OSV database.
 * CodeQL is never run.
 */
import { execFile } from 'node:child_process';
import {
  cpSync,
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
import { describe, expect, it } from 'vitest';
import { loadToolManifest, quarantineSnapshot, repoRoot, runTool } from '../tools/index.js';

const recordDir = process.env['AFFIDAVIT_RECORD_DIR'];
const enabled = process.env['AFFIDAVIT_DOCKER_TESTS'] === '1' && recordDir !== undefined;
const base = join(repoRoot(), 'fixtures', 'corpus', 'normalize');

// Same jail flags as the L1-02 docker tests (see tools.docker.test.ts).
const JAIL = [
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

function dropFixtureSuffix(dir: string): void {
  for (const entry of readdirSync(dir)) {
    let p = join(dir, entry);
    const name = entry.replace(/\.fixture$/, '');
    if (name !== entry) {
      renameSync(p, join(dir, name));
      p = join(dir, name);
    }
    if (statSync(p).isDirectory()) dropFixtureSuffix(p);
  }
}

const runner: ToolRunnerPort = {
  run(image, args, mounts) {
    return new Promise((resolve) => {
      const dockerArgs = [
        'run',
        ...JAIL,
        ...mounts.flatMap((m) => [
          '-v',
          `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`,
        ]),
        image,
        ...args,
      ];
      execFile('docker', dockerArgs, (error) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ exitCode, outputPath: tmpdir() });
      });
    });
  },
};

describe.skipIf(!enabled)('record normalizer inputs', () => {
  it('records Semgrep SARIF and OSV-Scanner JSON from the pinned images', async () => {
    const work = mkdtempSync(join(tmpdir(), 'affidavit-record-'));
    try {
      const src = join(work, 'src');
      cpSync(join(base, 'repo'), src, { recursive: true });
      dropFixtureSuffix(src);
      const advisories = ['AFFIDAVIT-NORM-0001', 'AFFIDAVIT-NORM-0002'];
      const entries = advisories.map((id) => ({
        id,
        data: readFileSync(join(base, 'osv-advisories', `${id}.json.fixture`)),
      }));
      // storedZip writes a one-entry archive, so each advisory is recorded in its own run.
      const manifest = loadToolManifest();
      const snap = await quarantineSnapshot(src);
      const out = recordDir as string;
      const semgrep = await runTool(runner, manifest, 'semgrep', {
        snapshot: snap,
        outputDir: join(work, 'out-semgrep'),
        scratchDir: join(work, 'scratch-semgrep'),
        rulesDir: join(base, 'rules', 'semgrep'),
      });
      expect(semgrep.empty).toBe(false);
      cpSync(join(work, 'out-semgrep', semgrep.outputFile), join(out, 'semgrep.sarif'));

      for (const e of entries) {
        const dbDir = join(work, `osv-db-${e.id}`);
        mkdirSync(join(dbDir, 'npm'), { recursive: true });
        writeFileSync(join(dbDir, 'npm', 'all.zip'), storedZip(`${e.id}.json`, e.data));
        const osv = await runTool(runner, manifest, 'osv-scanner', {
          snapshot: snap,
          outputDir: join(work, `out-osv-${e.id}`),
          scratchDir: join(work, `scratch-osv-${e.id}`),
          osvDatabaseDir: dbDir,
        });
        expect(osv.empty).toBe(false);
        cpSync(join(work, `out-osv-${e.id}`, osv.outputFile), join(out, `osv-${e.id}.json`));
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 600_000);
});
