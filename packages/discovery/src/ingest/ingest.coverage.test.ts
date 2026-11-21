/**
 * L1-01c: ingestion of a real-shaped repo (NodeGoat: Font Awesome fonts, an 888 KB
 * package-lock.json) without weakening fail-closed. Two file classes are now covered:
 *  - fonts whose structure checks out are left out of the workspace (`font-file`), like media;
 *  - a lockfile or SVG file flagged chunk-split-risk is covered when the windows pass proves it
 *    (tools/windowproof.ts).
 * Everything else that the scan may have missed still returns `incomplete`.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eot, sfnt, woff } from '../tools/fontkit.js';
import { repoRoot } from '../tools/index.js';
import { ingestRepo, type IngestDeps, type IngestIncomplete, type IngestOk } from './index.js';
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

const FONT_FILE = /\.(?:ttf|otf|woff2?|eot)$/i;
// gitleaks skips fonts and cuts big files into 100,000-byte chunks; the fake does both.
const realistic = () =>
  fakeGitleaks({ chunkBytes: 100_000, onlyFiles: (rel) => !FONT_FILE.test(rel) });

const base = (extra: Files): Files => ({
  'package.json': EXPRESS_PKG,
  'src/app.js': "require('express')();\n",
  ...extra,
});

async function run(
  files: Files,
  over: Partial<IngestDeps> = {},
): Promise<{ r: Awaited<ReturnType<typeof ingestRepo>> }> {
  const { dir, shas } = makeRepo([base(files)]);
  const r = await ingestRepo(
    { runner: realistic(), workRoot: tmpDir(), allowLocalSource: true, ...over },
    request({ source: dir, commit: shas[0] as string }),
  );
  return { r };
}

async function ok(files: Files, over: Partial<IngestDeps> = {}): Promise<IngestOk> {
  const { r } = await run(files, over);
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
}

async function incomplete(files: Files, over: Partial<IngestDeps> = {}): Promise<IngestIncomplete> {
  const { r } = await run(files, over);
  expect(r.status).toBe('incomplete');
  if (r.status !== 'incomplete') throw new Error('unreachable');
  return r;
}

const ids = (r: IngestIncomplete): string[] => r.coverage.notifications.map((n) => n.id ?? '');
/** Random bytes behind a start no file signature in the tools table has. */
const binary = (n: number): Buffer => Buffer.concat([Buffer.from([0x00, 0xff]), randomBytes(n)]);

/**
 * An npm-style lockfile of about `total` bytes: short lines, no blank line (so it is flagged
 * chunk-split-risk), hex values only. Each key is put alone on a line so that its value starts
 * 10 bytes before the given offset and so straddles it.
 */
function lockfile(key: string, keysAt: number[], total = 220_000, extraLine = ''): string {
  let s = '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": {\n';
  let i = 0;
  const filler = (): string =>
    `    "node_modules/p${String(i++).padStart(6, '0')}": "${randomBytes(30).toString('hex')}",\n`;
  const keyLead = '    "k": "';
  for (const t of [...keysAt].sort((a, b) => a - b)) {
    const start = t - 10 - keyLead.length; // where the key's line must start
    while (s.length + 200 < start) s += filler();
    const pad = start - s.length - '    "pad": "",\n'.length;
    s += `    "pad": "${'0'.repeat(pad)}",\n`;
    expect(s.length).toBe(start);
    s += `${keyLead}${key}",\n`;
  }
  while (s.length < total) s += filler();
  return `${s}${extraLine}    "end": "0"\n  }\n}\n`;
}

describe('a lockfile flagged chunk-split-risk is covered by the windows pass', () => {
  it('a fake key across the 100 KB chunk cut and one near a window end are both caught', async () => {
    const key = fakeKey();
    // 100,000: the snapshot pass cuts through it (the fake misses it); 90,000: near the end of
    // the first window. Only the windows pass can find the first one.
    const lock = lockfile(key, [90_000, 100_000]);
    expect(lock.indexOf(key, 99_000)).toBe(99_990);
    const r = await ok({ 'package-lock.json': lock });
    expect(r.scan.partial).toBe(false);
    expect(r.scan.windowProvenFiles).toEqual(['/src/package-lock.json']);
    expect(r.scan.windowedFiles).toContain('/src/package-lock.json');
    expect(r.scan.notifications).toEqual([]);
    const lines = r.redactions
      .filter((x) => x.file === 'package-lock.json')
      .map((x) => x.startLine);
    expect(lines.length).toBe(2);
    expect(everything(r.workspacePath)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain(key);
    // the lockfile itself stays in the workspace, redacted
    expect(readFileSync(join(r.workspacePath, 'package-lock.json'), 'utf8')).toContain('"end"');
  });

  it('the snapshot pass alone would have missed the key past the cut (the fake is honest)', async () => {
    const key = fakeKey();
    const lock = lockfile(key, [100_000]);
    // Same file under a name outside the lockfile class: no proof, so it fails closed.
    const r = await incomplete({ 'data/packages.json': lock });
    expect(ids(r)).toEqual(['chunk-split-risk']);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('a gate word in the lockfile (private) keeps it fail-closed', async () => {
    const r = await incomplete({
      'package-lock.json': lockfile(fakeKey(), [], 220_000, '    "private": true,\n'),
    });
    expect(ids(r)).toEqual(['chunk-split-risk']);
  });

  it.each(['curl', 'ZXlK'])('the gate word %s keeps it fail-closed', async (word) => {
    const r = await incomplete({
      'package-lock.json': lockfile(fakeKey(), [], 220_000, `    "x": "${word}",\n`),
    });
    expect(ids(r)).toEqual(['chunk-split-risk']);
  });

  it('a line over 4096 bytes keeps it fail-closed', async () => {
    const r = await incomplete({
      'package-lock.json': lockfile(fakeKey(), [], 220_000, `    "x": "${'a'.repeat(5000)}",\n`),
    });
    expect(ids(r)).toEqual(['chunk-split-risk']);
  });

  it('a long whitespace run keeps it fail-closed', async () => {
    const r = await incomplete({
      'package-lock.json': lockfile(fakeKey(), [], 220_000, `    "x":${' '.repeat(300)}"y",\n`),
    });
    expect(ids(r)).toEqual(['chunk-split-risk']);
  });

  it('a window budget that runs out keeps it fail-closed', async () => {
    const r = await incomplete(
      { 'package-lock.json': lockfile(fakeKey(), [100_000]) },
      { tools: { maxWindowBytes: 100_000 } },
    );
    expect(ids(r).sort()).toEqual(['chunk-split-risk', 'windows-budget-exceeded']);
  });

  it('a gitleaks config other than the analyzed one gets no proof', async () => {
    const dir = tmpDir();
    cpSync(join(repoRoot(), 'docker', 'tools', 'config'), dir, { recursive: true });
    const file = join(dir, 'gitleaks.toml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n# changed\n`);
    const r = await incomplete(
      { 'package-lock.json': lockfile(fakeKey(), [100_000]) },
      { tools: { configDir: dir } },
    );
    expect(ids(r)).toEqual(['chunk-split-risk']);
  });

  it('an SVG file is in the class too (Font Awesome ships one)', async () => {
    const glyph = (n: number) =>
      `<glyph unicode="&#x${n.toString(16)};" d="M${randomBytes(40).toString('hex')}z" />\n`;
    let svg = '<?xml version="1.0" standalone="no"?>\n<svg xmlns="http://www.w3.org/2000/svg">\n';
    for (let n = 0; svg.length < 210_000; n++) svg += glyph(n);
    svg += '</svg>\n';
    const r = await ok({ 'public/fonts/icons.svg': svg });
    expect(r.scan.windowProvenFiles).toEqual(['/src/public/fonts/icons.svg']);
    expect(listFiles(r.workspacePath)).toContain('public/fonts/icons.svg');
  });
});

describe('fonts are left out of the workspace and do not trip the partial flag', () => {
  it('TrueType, OpenType, WOFF and EOT files: ok, excluded as font-file, recorded', async () => {
    const key = fakeKey();
    const named = [
      { tag: 'cmap', data: Buffer.alloc(12, 1) },
      { tag: 'name', data: Buffer.from(`k=${key}\n`) }, // a key the scanner never sees
    ];
    const r = await ok({
      'public/fonts/a.ttf': sfnt('ttf', named),
      'public/fonts/a.otf': sfnt('otf'),
      'public/fonts/a.woff': woff(named),
      'public/fonts/a.eot': eot(Buffer.from(randomBytes(64))), // compressed-looking font data
    });
    expect(r.scan.partial).toBe(false);
    expect(r.excluded.filter((e) => e.reason === 'font-file').map((e) => e.path)).toEqual([
      'public/fonts/a.eot',
      'public/fonts/a.otf',
      'public/fonts/a.ttf',
      'public/fonts/a.woff',
    ]);
    expect([...r.scan.binaryFontFiles].sort()).toEqual([
      '/src/public/fonts/a.eot',
      '/src/public/fonts/a.otf',
      '/src/public/fonts/a.ttf',
      '/src/public/fonts/a.woff',
    ]);
    expect(r.scan.notifications.map((n) => n.id)).toEqual([
      'binary-font',
      'binary-font',
      'binary-font',
      'binary-font',
    ]);
    for (const f of listFiles(r.workspacePath)) expect(f).not.toMatch(FONT_FILE);
    expect(everything(r.workspacePath)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('a font file with bytes appended after its tables is not a font: fails closed', async () => {
    const r = await incomplete({
      'public/fonts/a.ttf': Buffer.concat([sfnt(), Buffer.from(`\nk=${fakeKey()}\n`)]),
    });
    expect(ids(r)).toEqual(['skipped-file-type']);
  });

  it('only a font magic and a key (no structure) fails closed', async () => {
    const r = await incomplete({
      'public/fonts/a.woff': Buffer.concat([
        Buffer.from('wOFF'),
        Buffer.alloc(28),
        Buffer.from(`k=${fakeKey()}\n`),
      ]),
    });
    expect(ids(r)).toEqual(['skipped-file-type']);
  });

  it('a font under a name gitleaks reads as an archive fails closed', async () => {
    const r = await incomplete({ 'public/fonts/a.zip.ttf': sfnt() });
    expect(ids(r)).toContain('archive-name-mismatch');
  });
});

describe('anything else the scan cannot read still fails closed', () => {
  it('an unknown big binary (random bytes) returns incomplete', async () => {
    const r = await incomplete({ 'assets/blob.bin': binary(300_000) });
    expect(ids(r)).toEqual(['non-text-content']);
    expect(r.coverage.notifications[0]?.message).toContain('/src/assets/blob.bin');
  });

  it('a binary named like a font but not one returns incomplete', async () => {
    const r = await incomplete({ 'assets/x.eot': binary(50_000) });
    expect(ids(r)).toEqual(['non-text-content']);
  });

  it('fonts do not hide another gap: a font plus a UTF-16 file is incomplete', async () => {
    const r = await incomplete({
      'public/fonts/a.ttf': sfnt(),
      'data/utf16.txt': Buffer.from('token=abc\n', 'utf16le'),
    });
    expect(ids(r).sort()).toEqual(['binary-font', 'non-text-content']);
  });
});
