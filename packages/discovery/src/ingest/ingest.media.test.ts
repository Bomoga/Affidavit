import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ingestRepo, type IngestDeps, type IngestOk } from './index.js';
import {
  cleanup,
  EXPRESS_PKG,
  everything,
  fakeGitleaks,
  fakeKey,
  listFiles,
  makeRepo,
  request,
  tmpDir,
  type Files,
} from './testkit.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from('GIF89a');

async function ok(files: Files, over: Partial<IngestDeps> = {}): Promise<IngestOk> {
  const { dir, shas } = makeRepo([
    { 'package.json': EXPRESS_PKG, 'src/app.js': "require('express')();\n", ...files },
  ]);
  const r = await ingestRepo(
    { runner: fakeGitleaks(), workRoot: tmpDir(), allowLocalSource: true, ...over },
    request({ source: dir, commit: shas[0] as string }),
  );
  expect(r.status).toBe('ok');
  return r as IngestOk;
}

describe('media files are left out of the workspace (fail closed)', () => {
  it('a gif and a png with NUL bytes and a key: ok, excluded as media-file, no leak', async () => {
    const key = fakeKey();
    const r = await ok({
      'public/anim.gif': Buffer.concat([GIF, Buffer.from([0, 0, 0]), Buffer.from(`k=${key}\n`)]),
      'public/img/logo.png': Buffer.concat([PNG, Buffer.from([0, 0]), Buffer.from(`k=${key}\n`)]),
    });
    expect(r.excluded).toEqual([
      { path: 'public/anim.gif', reason: 'media-file' },
      { path: 'public/img/logo.png', reason: 'media-file' },
    ]);
    expect(listFiles(r.workspacePath)).not.toContain('public/anim.gif');
    expect(listFiles(r.workspacePath)).not.toContain('public/img/logo.png');
    expect(everything(r.workspacePath)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.scan.partial).toBe(false);
    expect([...r.scan.binaryMediaFiles].sort()).toEqual([
      '/src/public/anim.gif',
      '/src/public/img/logo.png',
    ]);
  });

  it('a media file the scanner has no finding in (UTF-16 key) is still left out', async () => {
    const key = fakeKey();
    const r = await ok({
      'public/logo.png': Buffer.concat([PNG, Buffer.from(`k=${key}\n`, 'utf16le')]),
    });
    expect(r.excluded).toEqual([{ path: 'public/logo.png', reason: 'media-file' }]);
    expect(listFiles(r.workspacePath)).not.toContain('public/logo.png');
    const out = Buffer.from(everything(r.workspacePath), 'latin1');
    expect(out.includes(Buffer.from(key, 'utf16le'))).toBe(false);
    expect(out.includes(Buffer.from(key))).toBe(false);
  });

  it('other media types and an upper-case extension are left out; text files are kept', async () => {
    const r = await ok({
      'a/PHOTO.PNG': Buffer.concat([PNG, Buffer.from([0, 1, 2])]),
      'a/clip.mp4': Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftypmp42'),
        Buffer.from([0]),
      ]),
      'a/song.mp3': Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0])]),
      'a/readme.png.txt': 'plain text notes\n',
    });
    expect(r.excluded.map((e) => [e.path, e.reason])).toEqual([
      ['a/clip.mp4', 'media-file'],
      ['a/PHOTO.PNG', 'media-file'],
      ['a/song.mp3', 'media-file'],
    ]);
    expect(existsSync(join(r.workspacePath, 'a', 'readme.png.txt'))).toBe(true);
    expect(existsSync(join(r.workspacePath, 'src', 'app.js'))).toBe(true);
  });

  it('a repo with no media keeps status ok and excludes nothing', async () => {
    const r = await ok({});
    expect(r.excluded).toEqual([]);
  });
});
