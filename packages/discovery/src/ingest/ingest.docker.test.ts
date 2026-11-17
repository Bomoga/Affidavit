/**
 * Ingestion against the real pinned gitleaks image. Skipped unless AFFIDAVIT_DOCKER_TESTS=1, like
 * the tool image tests. Run with:
 *   AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery exec vitest run ingest.docker
 * PowerShell: $env:AFFIDAVIT_DOCKER_TESTS = '1'; pnpm --filter @affidavit/discovery exec vitest run ingest.docker
 *
 * Keys are made at run time and are obviously fake. The repo and its .env files exist only in
 * temp directories this test creates.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../tools/index.js';
import { ingestRepo, type IngestOk } from './index.js';
import {
  cleanup,
  EXPRESS_PKG,
  everything,
  fakeKey,
  listFiles,
  makeRepo,
  request,
  tmpDir,
} from './testkit.js';

const enabled = process.env['AFFIDAVIT_DOCKER_TESTS'] === '1';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

// The jail flags of buildDockerRunArgs in packages/testing/src/infra.ts (discovery cannot import
// that package; tools.docker.test.ts pins the same list against its source).
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

const runner: ToolRunnerPort = {
  run(image, args, mounts) {
    const argv = [
      'run',
      ...JAIL,
      ...mounts.flatMap((m) => [
        '-v',
        `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`,
      ]),
      image,
      ...args,
    ];
    return new Promise((resolve) => {
      execFile('docker', argv, (error) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ exitCode: code, outputPath: tmpdir() });
      });
    });
  },
};

afterAll(cleanup);

/** A one-entry stored (uncompressed) zip. */
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

/** A one-entry ustar archive. */
function tarOf(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc(((512 - (data.length % 512)) % 512) + 1024);
  return Buffer.concat([h, data, pad]);
}

describe.skipIf(!enabled)('ingest with the real gitleaks image', () => {
  let configDir: string;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), 'affidavit-ingest-cfg-'));
    writeFileSync(
      join(configDir, 'gitleaks.toml'),
      readFileSync(join(repoRoot(), 'docker', 'tools', 'config', 'gitleaks.toml'), 'utf8') +
        readFileSync(
          join(
            repoRoot(),
            'fixtures',
            'corpus',
            'tool-smoke',
            'rules',
            'gitleaks',
            'affidavit-fixture.toml',
          ),
          'utf8',
        ),
    );
  });

  it('redacts a planted key from every file, leaves .env out, and reports coverage gaps', async () => {
    const key = fakeKey();
    const envKey = fakeKey();
    const pemBody = randomBytes(300)
      .toString('base64')
      .replace(/(.{64})/g, '$1\n');
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----\n`;
    const bigLf = `${'// padding line\n'.repeat(12_000)}const late = "${key}";\n${'// tail\n'.repeat(500)}`;
    const files = {
      'package.json': EXPRESS_PKG,
      'src/app.js': "require('express')();\n",
      'src/config.js': `exports.token = "${key}";\n`,
      'src/crlf.js': `a = 1;\r\nb = "${key}";\r\n`,
      'src/multibyte.js': `// é€é ü\nconst k = "${key}"; // ñ\n`,
      'src/big.js': bigLf,
      'keys/server.pem': pem,
      '.env': `API_KEY=${envKey}\nOTHER=${key}\n`,
      'sub/.Env.local': `API_KEY=${envKey}\n`,
      'data/archive.txt.gz': gzipSync(`const k = "${key}";\n`),
      'data/utf16.txt': Buffer.from(`token=${key}\n`, 'utf16le'),
    };
    const { dir, shas } = makeRepo([files]);
    const workRoot = tmpDir();
    const r = (await ingestRepo(
      { runner, workRoot, allowLocalSource: true, tools: { configDir } },
      request({ source: dir, commit: shas[0] as string }),
    )) as IngestOk;

    expect(r.status).toBe('ok');
    // nothing carries the key or the private key, in content, names or the result
    const everythingOut = everything(r.workspacePath);
    for (const secret of [key, envKey, pemBody.split('\n')[1] as string]) {
      expect(everythingOut).not.toContain(secret);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
    expect(everything(workRoot)).not.toContain(key);

    // the redaction entries are where the keys were
    const at = (file: string) => r.redactions.filter((x) => x.file === file);
    expect(at('src/config.js')).toMatchObject([
      { startLine: 1, kind: 'affidavit-fake-fixture-key' },
    ]);
    expect(at('src/crlf.js')).toMatchObject([{ startLine: 2 }]);
    expect(at('src/multibyte.js')).toMatchObject([{ startLine: 2 }]);
    expect(at('src/big.js')).toMatchObject([{ startLine: 12_001 }]);
    expect(at('keys/server.pem')).toMatchObject([{ kind: 'private-key', startLine: 1 }]);
    expect(readFileSync(join(r.workspacePath, 'keys', 'server.pem'), 'utf8')).toMatch(
      /^\[REDACTED:private-key:\d+\]\n+$/,
    );
    // line numbers did not move in the big file
    const big = readFileSync(join(r.workspacePath, 'src', 'big.js'), 'utf8').split('\n');
    expect(big[12_000]).toMatch(/^const late = "\[REDACTED:/);
    expect(big.length).toBe(bigLf.split('\n').length);

    // .env files and files that cannot be rewritten stayed behind
    expect(listFiles(r.workspacePath).filter((f) => /\.env/i.test(f))).toEqual([]);
    expect(r.excluded.map((e) => [e.path, e.reason]).sort()).toEqual([
      ['.env', 'env-file'],
      ['data/archive.txt.gz', 'secret-in-non-text-file'],
      ['data/utf16.txt', 'secret-in-other-encoding'],
      ['sub/.Env.local', 'env-file'],
    ]);

    // gitleaks cannot read the UTF-16 file, so the run is partial and says so
    expect(r.scan.partial).toBe(true);
    expect(r.scan.notifications.some((n) => n.message.includes('data/utf16.txt'))).toBe(true);
    expect(r.scan.windowedFiles).toContain('/src/src/big.js');
  });

  it('a secret inside a zip or tar member keeps the archive out and does not fail the ingestion', async () => {
    const key = fakeKey();
    const text = Buffer.from(`const k = "${key}";\n`);
    const { dir, shas } = makeRepo([
      {
        'package.json': EXPRESS_PKG,
        'src/app.js': "require('express')();\n",
        'data/a.zip': storedZip('inner.js', text),
        'data/b.tar': tarOf('inner.js', text),
      },
    ]);
    const workRoot = tmpDir();
    const r = (await ingestRepo(
      { runner, workRoot, allowLocalSource: true, tools: { configDir } },
      request({ source: dir, commit: shas[0] as string }),
    )) as IngestOk;
    expect(r.status).toBe('ok');
    expect(r.excluded.map((e) => [e.path, e.reason]).sort()).toEqual([
      ['data/a.zip', 'secret-in-non-text-file'],
      ['data/b.tar', 'secret-in-non-text-file'],
    ]);
    expect(everything(r.workspacePath)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain('inner.js'); // member names stay out of the result
  });

  it('a repo with no secrets ingests clean and not partial', async () => {
    const { dir, shas } = makeRepo([
      { 'package.json': EXPRESS_PKG, 'src/app.js': 'require("express")();\n' },
    ]);
    const r = (await ingestRepo(
      { runner, workRoot: tmpDir(), allowLocalSource: true, tools: { configDir } },
      request({ source: dir, commit: shas[0] as string }),
    )) as IngestOk;
    expect(r.status).toBe('ok');
    expect(r.redactions).toEqual([]);
    expect(r.scan).toMatchObject({ partial: false, findings: 0, redactedValues: 0 });
  });
});
