import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readGitleaksFindings } from './findings.js';
import {
  ingestRepo,
  RepoTooLargeError,
  type IngestDeps,
  type IngestIncomplete,
  type IngestOk,
} from './index.js';
import {
  cleanup,
  EXPRESS_PKG,
  fakeGitleaks,
  fakeKey,
  makeRepo,
  plumbingRepo,
  request,
  tmpDir,
  type Files,
} from './testkit.js';
import { isEnvName } from './workspace.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({
  runner: fakeGitleaks(),
  workRoot: tmpDir(),
  allowLocalSource: true,
  ...over,
});
const base = (extra: Files): Files => ({
  'package.json': EXPRESS_PKG,
  'src/app.js': "require('express')();\n",
  ...extra,
});

async function incomplete(
  files: Files,
  over: Partial<IngestDeps> = {},
): Promise<{ r: IngestIncomplete; d: IngestDeps; caseId: string }> {
  const { dir, shas } = makeRepo([base(files)]);
  const d = deps(over);
  const req = request({ source: dir, commit: shas[0] as string });
  const r = await ingestRepo(d, req);
  expect(r.status).toBe('incomplete');
  if (r.status !== 'incomplete') throw new Error('unreachable');
  expect(r).toMatchObject({ reason: 'partial-secret-scan', commit: shas[0] });
  expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false); // nothing is kept
  return { r, d, caseId: String(req.caseId) };
}

const ids = (r: IngestIncomplete): string[] => r.coverage.notifications.map((n) => n.id ?? '');

describe('fail closed: every coverage loss returns incomplete, never ok', () => {
  const noBlank = (n: number) => '// padding line\n'.repeat(n);

  it('a window byte budget that runs out (windows-budget-exceeded)', async () => {
    const key = fakeKey();
    const big = `${noBlank(12_000)}const late = "${key}";\n${'// tail\n'.repeat(500)}`;
    const { r } = await incomplete({ 'src/big.js': big }, { tools: { maxWindowBytes: 100_000 } });
    expect(ids(r)).toContain('windows-budget-exceeded');
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('a long stretch with no blank line (chunk-split-risk), the repro of a key past 100 KB', async () => {
    const key = fakeKey();
    const big = `${noBlank(12_000)}const late = "${key}";\n${noBlank(500)}`;
    const { r } = await incomplete({ 'src/big.js': big });
    expect(ids(r)).toContain('chunk-split-risk');
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('UTF-16 or other undecodable content (non-text-content)', async () => {
    const { r } = await incomplete({
      'data/utf16.txt': Buffer.from('token=abc\n', 'utf16le'),
    });
    expect(ids(r)).toContain('non-text-content');
    expect(r.coverage.notifications.some((n) => n.message.includes('data/utf16.txt'))).toBe(true);
  });

  it('a binary signature that does not match the name (binary-header-mismatch)', async () => {
    const { r } = await incomplete({ 'docs/x.dat': Buffer.from('%PDF-1.4\nnothing here\n') });
    expect(ids(r)).toContain('binary-header-mismatch');
  });

  it('a file type gitleaks skips (skipped-file-type)', async () => {
    const { r } = await incomplete({ 'docs/x.pdf': Buffer.from('%PDF-1.4\nnothing here\n') });
    expect(ids(r)).toContain('skipped-file-type');
  });

  it('a name gitleaks reads as an archive (archive-name-mismatch)', async () => {
    const { r } = await incomplete({ 'src/config.zip.js': 'x = 1;\n' });
    expect(ids(r)).toContain('archive-name-mismatch');
  });

  it('a private key block with a blank line in a large file (multiline-split-risk)', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      'A'.repeat(64) +
      '\n\n' +
      'B'.repeat(64) +
      '\n-----END RSA PRIVATE KEY-----\n';
    const big = `${'// pad\n\n'.repeat(8000)}${pem}${'// pad\n\n'.repeat(8000)}`;
    const { r } = await incomplete({ 'src/big.js': big });
    expect(ids(r)).toContain('multiline-split-risk');
  });

  it('coverage paths go through the redactor', async () => {
    const key = fakeKey();
    const { r } = await incomplete({
      'src/app.js': `k = "${key}";\n`,
      [`data/${key}.dat`]: Buffer.from('%PDF-1.4\nx\n'),
    });
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.coverage.notifications.some((n) => n.message.includes('REDACTED'))).toBe(true);
  });
});

describe('snapshot findings are never dropped in favour of the windows pass', () => {
  it('keeps a snapshot finding for a file that also has a windows report', async () => {
    const dir = tmpDir();
    const sarif = (uri: string, line: number) =>
      JSON.stringify({
        runs: [
          {
            results: [
              {
                ruleId: 'private-key',
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri },
                      region: { startLine: line, startColumn: 1, endLine: line + 2, endColumn: 9 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    writeFileSync(join(dir, 'snapshot.sarif'), sarif('/src/src/big.js', 10_001));
    writeFileSync(join(dir, 'windows.sarif'), sarif('/src/src/big.js', 5));
    const { findings } = await readGitleaksFindings([
      { file: join(dir, 'snapshot.sarif'), origin: 'snapshot' },
      { file: join(dir, 'windows.sarif'), origin: 'windows' },
    ]);
    expect(findings.map((f) => [f.origin, f.region.startLine])).toEqual([
      ['windows', 5],
      ['snapshot', 10_001],
    ]);
  });
});

describe('a SARIF report of the wrong shape', () => {
  it.each([
    ['a JSON null', 'null'],
    ['runs that is a string', '{"runs":"oops"}'],
    ['results that is an object', '{"runs":[{"results":{}}]}'],
    ['locations that is a string', '{"runs":[{"results":[{"ruleId":"x","locations":"y"}]}]}'],
  ])('fails closed on %s instead of reading it as no findings', async (_name, text) => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'bad.sarif'), text);
    await expect(
      readGitleaksFindings([{ file: join(dir, 'bad.sarif'), origin: 'snapshot' }]),
    ).rejects.toThrow(/SARIF/);
  });
});

describe('checkout ignores repo-controlled attributes', () => {
  it('eol, working-tree-encoding and ident do not change the bytes on disk', async () => {
    const text = 'line one\n\nline two\n\n'.repeat(11_000); // 220,000 bytes, blank lines so the scan is complete
    const { dir, shas } = plumbingRepo([
      base({
        '.gitattributes':
          '* text eol=crlf\n*.txt working-tree-encoding=UTF-32LE\n*.ident ident\n*.js filter=nothing\n',
        'data/a.txt': text,
        'data/b.ident': '$Id$\nplain\n',
      }),
    ]);
    const r = (await ingestRepo(
      deps(),
      request({ source: dir, commit: shas[0] as string }),
    )) as IngestOk;
    expect(r.status).toBe('ok');
    expect(readFileSync(join(r.workspacePath, 'data', 'a.txt'), 'utf8')).toBe(text);
    expect(readFileSync(join(r.workspacePath, 'data', 'a.txt')).length).toBe(text.length);
    expect(readFileSync(join(r.workspacePath, 'data', 'b.ident'), 'utf8')).toBe('$Id$\nplain\n');
    expect(readFileSync(join(r.workspacePath, 'src', 'app.js'), 'utf8')).toBe(
      "require('express')();\n",
    );
  });
});

describe('tree phase byte cap', () => {
  it('a commit with many tiny files passes the fetch check and fails at the tree', async () => {
    const files: Files = {};
    for (let i = 0; i < 200; i++) files[`f/${i}.js`] = `x${i}\n`;
    const { dir, shas } = makeRepo([base(files)]);
    const err = await ingestRepo(
      deps({ maxRepoBytes: 300_000 }),
      request({ source: dir, commit: shas[0] as string }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTooLargeError);
    expect(err).toMatchObject({ phase: 'tree', what: 'bytes' });
  });
});

describe('.env names, round 4', () => {
  it.each(['.flaskenv', 'prod.env~', 'prod.env copy', 'a.env.local', '.FLASKENV'])(
    'excludes %j',
    (n) => expect(isEnvName(n)).toBe(true),
  );
  it.each(['.environment', 'environment.js', 'dotenv.js', 'flaskenv.py'])('keeps %j', (n) =>
    expect(isEnvName(n)).toBe(false),
  );
});

describe('signals', () => {
  it('importing the git module adds no signal listeners', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    vi.resetModules();
    const git = await import('./git.js');
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    git.trackChild(child); // the first tracked child installs the exit hook
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    expect(typeof git.killAllGit).toBe('function'); // the worker calls this on shutdown
    git.killAllGit();
  });
});
