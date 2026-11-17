import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { verifyHead } from './git.js';
import {
  CloneFailedError,
  IngestInputError,
  ingestRepo,
  type IngestDeps,
  type IngestOk,
  type IngestResult,
} from './index.js';
import { ToolFailedError } from '../tools/index.js';
import {
  cleanup,
  EXPRESS_PKG,
  everything,
  fakeGitleaks,
  fakeKey,
  git,
  listFiles,
  makeRepo,
  request,
  tmpDir,
  type Files,
} from './testkit.js';

// git on Windows takes about a second per call, and every ingestion runs several.
vi.setConfig({ testTimeout: 120_000 });

afterAll(cleanup);

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
  return { runner: fakeGitleaks(), workRoot: tmpDir(), allowLocalSource: true, ...over };
}

function ok(r: IngestResult): IngestOk {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

const app = (extra: Files = {}): Files => ({
  'package.json': EXPRESS_PKG,
  'src/app.js': "const express = require('express');\nmodule.exports = express();\n",
  ...extra,
});

describe('ingest: secrets', () => {
  it('a planted key yields a redaction entry and appears in no output', async () => {
    const key = fakeKey();
    const envKey = fakeKey();
    const { dir, shas } = makeRepo([
      app({
        'src/config.js': `// config\nexports.token = "${key}";\nexports.ok = 1;\n`,
        '.env': `API_KEY=${envKey}\n`,
        '.ENV.local': `API_KEY=${envKey}\n`,
        'sub/.env.production': `A=${envKey}\n`,
        'README.md': `Use the key ${key} to log in\n`,
      }),
    ]);
    const d = deps();
    const r = ok(await ingestRepo(d, request({ source: dir, commit: shas[0] as string })));

    // The redaction entry points at the line and has a placeholder, never the value.
    const entry = r.redactions.find((x) => x.file === 'src/config.js');
    expect(entry).toMatchObject({ startLine: 2, endLine: 2, kind: 'affidavit-fake-fixture-key' });
    expect(entry?.placeholder).toMatch(/^\[REDACTED:affidavit-fake-fixture-key:\d+\]$/);

    // Both .env-style files, at any depth and case, were scanned (their key is in the map) and
    // were not copied.
    expect(listFiles(r.workspacePath).filter((f) => /(^|\/)\.env/i.test(f))).toEqual([]);
    expect(r.excluded.map((e) => [e.path, e.reason]).sort()).toEqual([
      ['.ENV.local', 'env-file'],
      ['.env', 'env-file'],
      ['sub/.env.production', 'env-file'],
    ]);
    expect(r.scan.redactedValues).toBe(2);

    // The key is in no file, no filename, and nowhere in the result, however it is printed.
    for (const k of [key, envKey]) {
      expect(everything(r.workspacePath)).not.toContain(k);
      expect(JSON.stringify(r)).not.toContain(k);
      expect(inspect(r, { depth: 10 })).not.toContain(k);
      expect(r.redactor.apply(`x ${k} y`)).not.toContain(k);
    }
    // Line numbers did not move.
    const cfg = readFileSync(join(r.workspacePath, 'src', 'config.js'), 'utf8').split('\n');
    expect(cfg[1]).toMatch(/^exports\.token = "\[REDACTED:/);
    expect(cfg[2]).toBe('exports.ok = 1;');
    // The README held the same key: replaced everywhere, and reported.
    expect(r.redactions.some((x) => x.file === 'README.md' && x.startLine === 1)).toBe(true);
  });

  it('replaces a value everywhere even where gitleaks reported it in one file only', async () => {
    const key = fakeKey();
    const { dir, shas } = makeRepo([
      app({ 'src/a.js': `x = "${key}";\n`, 'src/b.js': `\n\ny = '${key}'\n` }),
    ]);
    const d = deps({ runner: fakeGitleaks({ onlyFiles: (f) => f === 'src/a.js' }) });
    const r = ok(await ingestRepo(d, request({ source: dir, commit: shas[0] as string })));
    expect(everything(r.workspacePath)).not.toContain(key);
    expect(r.redactions.map((x) => `${x.file}:${x.startLine}`)).toEqual([
      'src/a.js:1',
      'src/b.js:3',
    ]);
  });

  it('leaves a clean file byte for byte unchanged', async () => {
    const { dir, shas } = makeRepo([app({ 'src/k.js': 'a\nb\nc\nd\n' })]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    expect(r.redactions).toEqual([]);
    expect(r.scan.redactedValues).toBe(0);
    expect(readFileSync(join(r.workspacePath, 'src', 'k.js'), 'utf8')).toBe('a\nb\nc\nd\n');
  });

  it('handles CRLF files, multibyte text and several keys on one line', async () => {
    const [k1, k2] = [fakeKey(), fakeKey()];
    const { dir, shas } = makeRepo([
      app({
        'src/crlf.js': `a = "${k1}";\r\nb = "${k2}";\r\n`,
        'src/mb.js': `é€é "${k1}"\nüñ "${k2}" "${k1}"\n`,
      }),
    ]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    const all = everything(r.workspacePath);
    expect(all).not.toContain(k1);
    expect(all).not.toContain(k2);
    const crlf = readFileSync(join(r.workspacePath, 'src', 'crlf.js'), 'utf8');
    expect(crlf).toMatch(/^a = "\[REDACTED:.*\]";\r\nb = "\[REDACTED:.*\]";\r\n$/);
    expect(readFileSync(join(r.workspacePath, 'src', 'mb.js'), 'utf8')).toMatch(/^é€é "\[RED/);
  });

  it('puts a secret in a file name through the redactor too', async () => {
    const key = fakeKey();
    const { dir, shas } = makeRepo([app({ [`src/${key}.js`]: `z = "${key}";\n` })]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    expect(everything(r.workspacePath)).not.toContain(key);
    expect(r.redactions.every((x) => !x.file.includes(key))).toBe(true);
  });

  it('a clean full scan is not partial', async () => {
    const { dir, shas } = makeRepo([app()]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    expect(r.scan.partial).toBe(false);
    expect(r.scan.findings).toBe(0);
  });

  it('fails closed and leaves nothing when the scanner fails', async () => {
    const { dir, shas } = makeRepo([app({ 'src/c.js': `k="${fakeKey()}"\n` })]);
    const d = deps({ runner: fakeGitleaks({ fail: new Error('docker is down') }) });
    const req = request({ source: dir, commit: shas[0] as string });
    await expect(ingestRepo(d, req)).rejects.toBeInstanceOf(ToolFailedError);
    expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false);
  });
});

describe('ingest: detection', () => {
  const run = async (files: Files) => {
    const { dir, shas } = makeRepo([files]);
    const d = deps();
    const req = request({ source: dir, commit: shas[0] as string });
    const r = await ingestRepo(d, req);
    return { r, d, req };
  };

  it.each([
    ['express', { express: '4' }],
    ['koa', { koa: '2' }],
    ['fastify', { fastify: '4' }],
  ])('detects %s', async (fw, deps_) => {
    const { r } = await run({
      'package.json': JSON.stringify({ dependencies: deps_ }),
      'index.js': 'x\n',
    });
    const o = ok(r);
    expect(o.detection.frameworks.map((f) => f.framework)).toEqual([fw]);
    expect(o.detection.language).toBe('javascript');
  });

  it('detects Next API routes (pages router and app router) and TypeScript', async () => {
    const pages = ok(
      (
        await run({
          'package.json': JSON.stringify({ dependencies: { next: '14' } }),
          'tsconfig.json': '{}',
          'pages/api/users/[id].ts': 'export default 1\n',
        })
      ).r,
    );
    expect(pages.detection.frameworks).toMatchObject([
      { framework: 'next-api', via: 'route-files', evidence: ['pages/api/users/[id].ts'] },
    ]);
    expect(pages.detection.language).toBe('typescript');
    const appRouter = ok(
      (
        await run({
          'package.json': JSON.stringify({ dependencies: { next: '14' } }),
          'src/app/api/x/route.ts': 'export const GET = 1\n',
        })
      ).r,
    );
    expect(appRouter.detection.frameworks[0]?.evidence).toEqual(['src/app/api/x/route.ts']);
  });

  it('finds frameworks in monorepo packages and ignores node_modules', async () => {
    const o = ok(
      (
        await run({
          'package.json': '{"name":"root"}',
          'packages/api/package.json': JSON.stringify({ dependencies: { fastify: '4' } }),
          'packages/api/src/index.js': 'x\n',
          'node_modules/dep/package.json': JSON.stringify({ dependencies: { express: '4' } }),
        })
      ).r,
    );
    expect(o.detection.frameworks).toMatchObject([
      { framework: 'fastify', packageJson: 'packages/api/package.json' },
    ]);
  });

  it('returns unsupported for a non-Node repo and keeps nothing', async () => {
    const { r, d, req } = await run({
      'app.py': 'print(1)\n',
      'main.py': 'x = 1\n',
      'go.mod': 'x',
    });
    expect(r).toMatchObject({
      status: 'unsupported',
      reason: 'no-package-json',
      observed: { python: 2 },
    });
    expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false);
  });

  it('returns unsupported for Node without a supported framework, or without sources', async () => {
    const plain = (await run({ 'package.json': '{"dependencies":{"lodash":"4"}}', 'a.js': 'x\n' }))
      .r;
    expect(plain).toMatchObject({ status: 'unsupported', reason: 'no-supported-framework' });
    const none = (await run({ 'package.json': EXPRESS_PKG, 'README.md': 'x' })).r;
    expect(none).toMatchObject({ status: 'unsupported', reason: 'no-js-ts-sources' });
    // next without API routes is not enough
    const nextOnly = (
      await run({ 'package.json': '{"dependencies":{"next":"14"}}', 'pages/index.js': 'x\n' })
    ).r;
    expect(nextOnly).toMatchObject({ status: 'unsupported', reason: 'no-supported-framework' });
  });

  it('survives a malformed package.json', async () => {
    const { r } = await run({ 'package.json': '{ not json', 'a.js': 'x\n' });
    expect(r.status).toBe('unsupported');
  });
});

describe('ingest: commit pinning', () => {
  it('checks out the pinned commit, not the latest, and verifies it by hash', async () => {
    const { dir, shas } = makeRepo([
      app({ 'src/version.js': 'exports.v = 1;\n' }),
      app({ 'src/version.js': 'exports.v = 2;\n' }),
    ]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    expect(r.commit).toBe(shas[0]);
    expect(readFileSync(join(r.workspacePath, 'src', 'version.js'), 'utf8')).toBe(
      'exports.v = 1;\n',
    );
    expect(shas[0]).not.toBe(shas[1]);
  });

  it('refuses anything that is not a full lowercase hash', async () => {
    const { dir, shas } = makeRepo([app()]);
    const sha = shas[0] as string;
    for (const bad of [
      sha.slice(0, 12),
      sha.toUpperCase(),
      'main',
      'HEAD',
      `${sha}\n`,
      '--upload-pack=x',
    ]) {
      await expect(
        ingestRepo(deps(), request({ source: dir, commit: bad })),
      ).rejects.toBeInstanceOf(IngestInputError);
    }
  });

  it('a commit that is not in the repository is a CloneFailedError and leaves nothing', async () => {
    const { dir } = makeRepo([app()]);
    const d = deps();
    const req = request({ source: dir, commit: 'a'.repeat(40) });
    await expect(ingestRepo(d, req)).rejects.toBeInstanceOf(CloneFailedError);
    expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false);
  });

  it('verifyHead throws when HEAD is not the pinned hash', async () => {
    const { dir, shas } = makeRepo([app(), app({ 'x.js': '1' })]);
    const opts = { allowLocal: true };
    await verifyHead(dir, dir, shas[1] as string, opts);
    await expect(verifyHead(dir, dir, shas[0] as string, opts)).rejects.toMatchObject({
      name: 'CommitMismatchError',
      expected: shas[0],
      actual: shas[1],
    });
  });

  it('refuses to reuse a case directory', async () => {
    const { dir, shas } = makeRepo([app()]);
    const d = deps();
    const req = request({ source: dir, commit: shas[0] as string });
    ok(await ingestRepo(d, req));
    await expect(ingestRepo(d, req)).rejects.toThrow();
    expect(existsSync(join(d.workRoot, String(req.caseId), 'workspace'))).toBe(true);
  });
});

describe('ingest: source and hostile repos', () => {
  it('accepts only https URLs without credentials unless local sources are allowed', async () => {
    const sha = 'a'.repeat(40);
    const strict = deps({ allowLocalSource: false });
    for (const source of [
      'http://example.com/a.git',
      'git://example.com/a.git',
      'ssh://git@example.com/a.git',
      'https://user:pw@example.com/a.git',
      'https://localhost/a.git',
      'https://169.254.169.254/a.git',
      'https://10.0.0.5/a.git',
      '--upload-pack=touch /tmp/x',
      'ext::sh -c touch% /tmp/x',
      '/some/local/path',
      'file:///some/local/path',
    ]) {
      await expect(
        ingestRepo(strict, request({ source, commit: sha })),
        source,
      ).rejects.toBeInstanceOf(IngestInputError);
    }
    expect(existsSync(strict.workRoot) && listFiles(strict.workRoot)).toEqual([]);
  });

  it('does not run hooks, filters or submodules, and never writes a symlink', async () => {
    const { dir, shas } = makeRepo([
      app({
        '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x.git\n',
        '.gitattributes': '* filter=lfs diff=lfs merge=lfs -text\n*.js filter=evil\n',
      }),
    ]);
    // a symlink entry (mode 120000) pointing outside, added without needing symlink rights
    const target = join(tmpDir(), 'secret-target.txt');
    writeFileSync(target, 'outside the repo');
    const sha = execBlob(dir, target);
    git(dir, 'update-index', '--add', '--cacheinfo', `120000,${sha},src/link`);
    git(dir, 'commit', '--quiet', '-m', 'link');
    const pinned = git(dir, 'rev-parse', 'HEAD');
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: pinned })));
    const link = join(r.workspacePath, 'src', 'link');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, 'utf8')).toBe(target); // the text of the link, not the target file
    expect(shas.length).toBe(1);
  });
});

function execBlob(dir: string, content: string): string {
  const f = join(dir, '..', `blob-${Math.random().toString(16).slice(2)}`);
  writeFileSync(f, content);
  return git(dir, 'hash-object', '-w', f);
}
