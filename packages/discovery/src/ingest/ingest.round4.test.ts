import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assertGitSupportsPin, MIN_PATCH_BY_LINE } from './git.js';
import { GitTooOldError, ingestRepo, type IngestDeps, type IngestOk } from './index.js';
import { cleanup, EXPRESS_PKG, fakeGitleaks, plumbingRepo, request, tmpDir } from './testkit.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

const deps = (): IngestDeps => ({
  runner: fakeGitleaks(),
  workRoot: tmpDir(),
  allowLocalSource: true,
});

describe('git floor, round 4', () => {
  // Change detector: it pins the table to the first fixed release per line below, so editing the
  // table fails here and forces a review. It does not prove the table is right.
  // First fixed release per line for CVE-2024-32002, -32004, -32020, -32021 and -32465.
  const FIXED: Record<number, number> = { 39: 4, 40: 2, 41: 1, 42: 2, 43: 4, 44: 1, 45: 1 };

  it('the table is exactly the fixed releases', () => {
    expect(MIN_PATCH_BY_LINE).toEqual(FIXED);
  });

  it('refuses every release of lines 2.37 and 2.38, however high the patch', () => {
    for (const minor of [37, 38]) {
      for (let patch = 0; patch <= 40; patch++) {
        expect(() => assertGitSupportsPin(`git version 2.${minor}.${patch}`)).toThrow(
          GitTooOldError,
        );
      }
    }
  });

  it('refuses every release below the fixed one on each table line, and admits it and later', () => {
    for (const [minor, fixed] of Object.entries(FIXED)) {
      for (let patch = 0; patch < fixed; patch++) {
        expect(() => assertGitSupportsPin(`git version 2.${minor}.${patch}`)).toThrow(
          GitTooOldError,
        );
      }
      for (const patch of [fixed, fixed + 1, fixed + 10]) {
        expect(() => assertGitSupportsPin(`git version 2.${minor}.${patch}`)).not.toThrow();
      }
    }
  });

  it('refuses a version without a patch number on a line that needs one, and old majors', () => {
    expect(() => assertGitSupportsPin('git version 2.39')).toThrow(GitTooOldError);
    expect(() => assertGitSupportsPin('git version 1.99.99')).toThrow(GitTooOldError);
    expect(() => assertGitSupportsPin('git version 2.46')).not.toThrow();
  });
});

describe('signal listeners, round 4', () => {
  const counts = (): number[] => [
    process.listenerCount('SIGINT'),
    process.listenerCount('SIGTERM'),
  ];

  it('an ingest leaves the SIGINT and SIGTERM listener counts unchanged, on success', async () => {
    const { dir, shas } = plumbingRepo([
      { 'package.json': EXPRESS_PKG, 'src/app.js': "require('express')();\n" },
    ]);
    const before = counts();
    const r = await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string }));
    expect(r.status).toBe('ok');
    expect(counts()).toEqual(before);
  });

  it('and on the failure path (a commit the source does not have)', async () => {
    const { dir } = plumbingRepo([{ 'package.json': EXPRESS_PKG }]);
    const before = counts();
    await expect(
      ingestRepo(deps(), request({ source: dir, commit: 'a'.repeat(40) })),
    ).rejects.toBeInstanceOf(Error);
    expect(counts()).toEqual(before);
  });
});

describe('in-repo .gitattributes, round 4', () => {
  // No clean/smudge case on purpose: the ingest runs git with a hermetic config (no system or
  // global file, private HOME, fixed -c list), so no filter driver can be defined for it and a
  // `filter=` attribute is inert whether or not the attributes are neutralised. A test of it
  // could not fail. Dropping the neutral attributes file fails this test (checked by hand).
  it('eol, text=auto and working-tree-encoding leave the disk bytes equal to the blobs', async () => {
    const files = {
      '.gitattributes': [
        '* text=auto eol=crlf',
        '*.u16 working-tree-encoding=UTF-16 text',
        '*.lf eol=lf text',
        '*.bin -text',
        '',
      ].join('\n'),
      'package.json': EXPRESS_PKG,
      'src/app.js': "require('express')();\n",
      'data/lf.txt': 'one\ntwo\n\nthree\n',
      'data/crlf.txt': 'one\r\ntwo\r\n\r\nthree\r\n',
      'data/mixed.txt': 'a\r\nb\nc\r\n\nd\n',
      'data/x.u16': 'plain ascii\n\nsecond\n',
      'data/y.f': 'lower case\n\nmore\n',
      'data/z.lf': 'x\r\ny\r\n\r\n',
      'data/w.bin': 'q\r\nr\n',
    };
    const { dir, shas } = plumbingRepo([files]);
    const r = (await ingestRepo(
      deps(),
      request({ source: dir, commit: shas[0] as string }),
    )) as IngestOk;
    expect(r.status).toBe('ok');
    for (const [name, text] of Object.entries(files)) {
      if (name === '.gitattributes') continue;
      const onDisk = readFileSync(join(r.workspacePath, ...name.split('/')));
      expect(onDisk.equals(Buffer.from(text, 'utf8')), name).toBe(true);
    }
  });
});
