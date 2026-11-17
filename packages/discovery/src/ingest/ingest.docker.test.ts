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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    const bigLf = `${'// padding line\n\n'.repeat(12_000)}const late = "${key}";\n${'// tail\n'.repeat(500)}`;
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
    expect(at('src/big.js')).toMatchObject([{ startLine: 24_001 }]);
    expect(at('keys/server.pem')).toMatchObject([{ kind: 'private-key', startLine: 1 }]);
    expect(readFileSync(join(r.workspacePath, 'keys', 'server.pem'), 'utf8')).toMatch(
      /^\[REDACTED:private-key:\d+\]\n+$/,
    );
    // line numbers did not move in the big file
    const big = readFileSync(join(r.workspacePath, 'src', 'big.js'), 'utf8').split('\n');
    expect(big[24_000]).toMatch(/REDACTED/);
    expect(big.length).toBe(bigLf.split('\n').length);

    // .env files and files that cannot be rewritten stayed behind
    expect(listFiles(r.workspacePath).filter((f) => /\.env/i.test(f))).toEqual([]);
    expect(r.excluded.map((e) => [e.path, e.reason]).sort()).toEqual([
      ['.env', 'env-file'],
      ['sub/.Env.local', 'env-file'],
    ]);

    // the scan covered everything, so the result is ok and not partial
    expect(r.scan.partial).toBe(false);
    expect(r.scan.windowedFiles).toContain('/src/src/big.js');
  });

  /** Runs the real image over a repo and expects the fail-closed result. */
  async function incompleteFor(files: Record<string, string | Buffer>, secrets: string[]) {
    const { dir, shas } = makeRepo([{ 'package.json': EXPRESS_PKG, ...files }]);
    const workRoot = tmpDir();
    const req = request({ source: dir, commit: shas[0] as string });
    const r = await ingestRepo(
      { runner, workRoot, allowLocalSource: true, tools: { configDir } },
      req,
    );
    expect(r.status).toBe('incomplete');
    if (r.status !== 'incomplete') throw new Error('unreachable');
    for (const secret of secrets) expect(JSON.stringify(r)).not.toContain(secret);
    expect(existsSync(join(workRoot, String(req.caseId)))).toBe(false); // nothing is kept
    return r;
  }

  it('a secret inside a zip or tar member fails closed, with the archives named', async () => {
    const key = fakeKey();
    const text = Buffer.from(`const k = "${key}";\n`);
    const r = await incompleteFor(
      {
        'src/app.js': "require('express')();\n",
        'data/a.zip': storedZip('inner.js', text),
        'data/b.tar': tarOf('inner.js', text),
      },
      [key, 'inner.js'],
    );
    const text2 = r.coverage.notifications.map((n) => n.message).join('\n');
    expect(text2).toContain('data/a.zip');
    expect(text2).toContain('data/b.tar');
  });

  it('UTF-16 text, archives and a PDF fail closed, each with its own kind', async () => {
    const key = fakeKey();
    const r = await incompleteFor(
      {
        'src/app.js': "require('express')();\n",
        'data/utf16.txt': Buffer.from(`token=${key}\n`, 'utf16le'),
        'data/archive.txt.gz': gzipSync(`const k = "${key}";\n`),
        'docs/x.dat': Buffer.from('%PDF-1.4\nnothing here\n'),
      },
      [key],
    );
    const ids = new Set(r.coverage.notifications.map((n) => n.id));
    expect(ids.has('non-text-content')).toBe(true);
    expect(ids.has('binary-header-mismatch')).toBe(true);
  });

  it('a window budget that runs out fails closed', async () => {
    const key = fakeKey();
    const big = `${'// padding line\n'.repeat(12_000)}const late = "${key}";\n${'// tail\n'.repeat(500)}`;
    const { dir, shas } = makeRepo([
      { 'package.json': EXPRESS_PKG, 'src/app.js': "require('express')();\n", 'src/big.js': big },
    ]);
    const r = await ingestRepo(
      {
        runner,
        workRoot: tmpDir(),
        allowLocalSource: true,
        tools: { configDir, maxWindowBytes: 100_000 },
      },
      request({ source: dir, commit: shas[0] as string }),
    );
    expect(r.status).toBe('incomplete');
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('a 24 KB private key block in a windowed file is redacted by whole line, never shipped', async () => {
    // 18,001 bytes: the base64 body is not a multiple of 64 characters, so the block does not end
    // in a blank line (18,000 would, and then multiline-split-risk fires). The padding has a blank
    // line every few bytes, so no chunk-split-risk either. The snapshot pass finds the key (its
    // columns past 100 KB cannot be trusted), the map keeps whole lines.
    const body = randomBytes(18_001)
      .toString('base64')
      .replace(/(.{64})/g, '$1\n');
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    const file = `${'// pad\n\n'.repeat(10_000)}${pem}${'// pad\n\n'.repeat(15_000)}`;
    const marker = body.split('\n')[100] as string;
    const { dir, shas } = makeRepo([
      { 'package.json': EXPRESS_PKG, 'src/app.js': "require('express')();\n", 'src/big.js': file },
    ]);
    const r = await ingestRepo(
      { runner, workRoot: tmpDir(), allowLocalSource: true, tools: { configDir } },
      request({ source: dir, commit: shas[0] as string }),
    );
    expect(r.status).toBe('ok');
    const ok = r as IngestOk;
    expect(ok.scan.partial).toBe(false);
    expect(ok.scan.lineFallbacks).toBeGreaterThan(0);
    expect(everything(ok.workspacePath)).not.toContain(marker);
    expect(JSON.stringify(ok)).not.toContain(marker);
  });

  it('a PNG with a UTF-16LE key and a 205 KB PNG with a key across the 125,000-byte cut are left out', async () => {
    const utf16Key = fakeKey();
    const cutKey = fakeKey();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Filler without a newline byte, so gitleaks has no blank line to cut at and cuts hard.
    const big = Buffer.alloc(205_000, 0x07);
    png.copy(big, 0);
    big.write(`k="${cutKey}"`, 124_990, 'latin1');
    const { dir, shas } = makeRepo([
      {
        'package.json': EXPRESS_PKG,
        'src/app.js': "require('express')();\n",
        'public/logo.png': Buffer.concat([png, Buffer.from(`k="${utf16Key}"\n`, 'utf16le')]),
        'public/big/logo.png': big,
      },
    ]);
    const workRoot = tmpDir();
    const r = await ingestRepo(
      { runner, workRoot, allowLocalSource: true, tools: { configDir } },
      request({ source: dir, commit: shas[0] as string }),
    );
    expect(r.status).toBe('ok');
    const ok = r as IngestOk;
    expect(ok.excluded.map((e) => [e.path, e.reason])).toEqual([
      ['public/big/logo.png', 'media-file'],
      ['public/logo.png', 'media-file'],
    ]);
    const out = Buffer.from(everything(ok.workspacePath), 'latin1');
    for (const k of [utf16Key, cutKey]) {
      expect(out.includes(Buffer.from(k))).toBe(false);
      expect(out.includes(Buffer.from(k, 'utf16le'))).toBe(false);
      expect(JSON.stringify(ok)).not.toContain(k);
    }
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
