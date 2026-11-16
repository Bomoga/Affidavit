import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_NAME, ChunkRisk, classifyHead, neutralArchiveName } from './unscannable.js';
import { repoRoot } from './manifest.js';

const bytes = (...parts: (string | number[])[]): Buffer =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

describe('classifyHead', () => {
  // Headers seen in review that gitleaks skips without a finding and without saying so.
  const hidden: [string, Buffer][] = [
    ['MZ', bytes('MZ', [0x90, 0x00, 0x03, 0x00], ' AFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['RTF', bytes('{\\rtf1\\ansi AFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['PostScript', bytes('%!PS-Adobe-3.0\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['ar archive', bytes('!<arch>\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['Chrome extension', bytes('Cr24 AFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['zstd', bytes([0x28, 0xb5, 0x2f, 0xfd], ' AFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['cab', bytes('MSCF', [0, 0, 0, 0], ' AFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['swf', bytes('FWS', [0x09], ' AFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['nes', bytes('NES\x1a AFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    ['pdf', bytes('%PDF-1.4\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF')],
    [
      'unknown binary header',
      bytes([0x01, 0x02, 0x03, 0x04], ' AFFIDAVIT_FAKE_KEY_0123456789ABCDEF'),
    ],
    ['utf-16 le', Buffer.from('AFFIDAVIT_FAKE_KEY_0123456789ABCDEF', 'utf16le')],
    ['invalid utf-8', bytes([0xc3, 0x28], ' key')],
  ];

  for (const [label, head] of hidden) {
    it(`flags ${label} as possibly skipped by gitleaks`, () => {
      expect(classifyHead('app.js', head)).toBeDefined();
    });
  }

  it('treats media as read by gitleaks, and every other known type as skipped', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // gitleaks reads images, audio and video as text: informational, but only when the extension
    // agrees with the signature. Otherwise the header is a way to hide a file.
    expect(classifyHead('logo.png', png)).toBe('binary-media');
    expect(classifyHead('config.js', png)).toBe('binary-header-mismatch');
    expect(classifyHead('app.env', bytes('GIF89a=1\nKEY=value'))).toBe('binary-header-mismatch');
    expect(classifyHead('c.js', bytes('ID3\nconst k = 1'))).toBe('binary-header-mismatch');
    expect(classifyHead('notes.txt', bytes('ID3', [3, 0], 'x'))).toBe('binary-header-mismatch');
    // fonts are skipped by gitleaks (application/font-sfnt, application/font-woff)
    expect(classifyHead('a.woff', bytes('wOFF', [0, 1, 0, 0]))).toBe('skipped-file-type');
    expect(classifyHead('a.ttf', bytes([0, 1, 0, 0, 0]))).toBe('skipped-file-type');
    expect(classifyHead('a.otf', bytes('OTTO', [0]))).toBe('skipped-file-type');
    // application types are skipped, with a matching extension or not
    const zip = bytes('PK\x03\x04', [0, 0]);
    expect(classifyHead('lib.zip', zip)).toBe('skipped-file-type');
    expect(classifyHead('lib.jar', zip)).toBe('skipped-file-type');
    expect(classifyHead('app.exe', bytes('MZ', [0x90, 0x00]))).toBe('skipped-file-type');
    expect(classifyHead('a.sqlite', bytes('SQLite format 3\0'))).toBe('skipped-file-type');
    expect(classifyHead('a.gz', bytes([0x1f, 0x8b, 8]))).toBe('skipped-file-type');
    expect(classifyHead('config.js', zip)).toBe('binary-header-mismatch');
    expect(classifyHead('notes.txt', bytes('%PDF-1.4 secret'))).toBe('binary-header-mismatch');
    expect(classifyHead('x.dat', bytes([1, 2, 3, 4, 5]))).toBe('non-text-content');
  });

  it('recognises an ISO 9660 image by the marker at offset 32769', () => {
    const iso = Buffer.concat([Buffer.alloc(32769), Buffer.from('CD001')]);
    expect(classifyHead('disc.iso', iso)).toBe('skipped-file-type');
    expect(classifyHead('disc.txt', iso)).toBe('binary-header-mismatch');
  });

  it('leaves plain text alone', () => {
    expect(classifyHead('a.js', bytes('const a = 1;\n\tif (x) {}\r\n'))).toBeUndefined();
    expect(classifyHead('a.md', Buffer.from('café ✓ \u{1f600}\n'))).toBeUndefined();
    expect(classifyHead('empty.txt', Buffer.alloc(0))).toBeUndefined();
  });

  it('does not flag text whose last multibyte character is cut off by the sniff window', () => {
    const text = Buffer.concat([Buffer.alloc(102_399, 0x61), Buffer.from('é')]).subarray(
      0,
      102_400,
    );
    expect(text.length).toBe(102_400);
    expect(classifyHead('a.txt', text)).toBeUndefined();
  });
});

describe('ChunkRisk', () => {
  const dense = (bytes: number) => Buffer.from(`${'a'.repeat(79)}\n`.repeat(Math.ceil(bytes / 80)));

  it('flags a file over 100 KB with a 25 KB stretch and no blank line', () => {
    const r = new ChunkRisk();
    r.feed(dense(130_000));
    expect(r.risky).toBe(true);
  });

  it('flags one very long line', () => {
    const r = new ChunkRisk();
    r.feed(Buffer.alloc(130_000, 0x62));
    expect(r.risky).toBe(true);
  });

  it('does not flag blank-line separated text, CRLF blank lines included, or small files', () => {
    const spaced = new ChunkRisk();
    spaced.feed(Buffer.from(`${dense(10_000).toString()}\n`.repeat(14)));
    expect(spaced.risky).toBe(false);
    const crlf = new ChunkRisk();
    const unit = `${'a'.repeat(79)}\r\n`.repeat(100) + '\r\n';
    crlf.feed(Buffer.from(unit.repeat(17)));
    expect(crlf.risky).toBe(false);
    const small = new ChunkRisk();
    small.feed(dense(60_000));
    expect(small.risky).toBe(false);
  });

  it('gives the same answer however the file is split into reads', () => {
    const data = dense(130_000);
    const whole = new ChunkRisk();
    whole.feed(data);
    const parts = new ChunkRisk();
    for (let i = 0; i < data.length; i += 7001) parts.feed(data.subarray(i, i + 7001));
    expect(parts.risky).toBe(whole.risky);
  });
});

describe('archive-like names', () => {
  // Names the pinned gitleaks dropped (or scanned) when given plain text, probed on Linux.
  const dropped = [
    'a.gz',
    'a.GZ',
    'a.Gz',
    'a.gz.txt',
    'a.GZ.TXT',
    'a.zip',
    'a.zip.js',
    'config.zip.env',
    'a.tar',
    'a.tar.gz',
    'a.tar.bz2',
    'a.tar.zst',
    'a.tar.foo',
    'a.tarx',
    'a.bz2',
    'a.xz',
    'a.xz.yaml',
    'a.zst',
    'a.zstd',
    'a.lz4',
    'a.br',
    'a.sz',
    'a.7z',
    'a.rar',
    'a.zipx',
    'a.zz',
    'a.gzip',
    'a.gzx',
    'a.gz2',
    'a.lz',
    'a.LZ',
    'a.mz',
    'a.MZ',
    'dir.gz.name',
    '.gz',
  ];
  const scanned = [
    'a.txt',
    'a.TXT',
    'a.js',
    'a.env',
    'a.tgz',
    'a.TGZ',
    'a.tbz2',
    'a.txz',
    'a.tzst',
    'a.jar',
    'a.war',
    'a.Z',
    'a.lzma',
    'a.cpio',
    'a.lzip',
    'a.rpm',
    'a.deb',
    'a.cab',
    'a.iso',
    'a.bz',
    'a.lz.txt',
    'a.mz.txt',
    'a.lzx',
    'a.mzx',
    'a.mz2',
    'agz.txt',
    'a_gz',
    'a-gz.txt',
    'zip',
    'README',
    'a.xtar',
  ];

  it('matches exactly the names the pinned gitleaks drops', () => {
    for (const n of dropped) expect(ARCHIVE_NAME.test(n), n).toBe(true);
    for (const n of scanned) expect(ARCHIVE_NAME.test(n), n).toBe(false);
  });

  it('flags plain text with such a name, but leaves a real archive to the signature rules', () => {
    const text = bytes('const k = 1;\n');
    for (const n of dropped) expect(classifyHead(n, text), n).toBe('archive-name-mismatch');
    for (const n of scanned) expect(classifyHead(n, text), n).toBeUndefined();
    expect(classifyHead('a.gz', bytes([0x1f, 0x8b, 8]))).toBe('skipped-file-type');
    expect(classifyHead('a.gz.txt', bytes([0x1f, 0x8b, 8]))).toBe('binary-header-mismatch');
  });

  it('neutralises the name so gitleaks no longer drops it, keeping the final extension', () => {
    for (const n of dropped.filter((x) => x !== '.gz')) {
      const neutral = neutralArchiveName(n);
      expect(ARCHIVE_NAME.test(neutral), `${n} -> ${neutral}`).toBe(false);
    }
    expect(neutralArchiveName('config.gz.yaml')).toBe('config._gz.yaml');
    expect(neutralArchiveName('a.tar.gz')).toBe('a._tar._gz');
    expect(neutralArchiveName('notes.lz')).toBe('notes._lz');
    expect(neutralArchiveName('plain.txt')).toBe('plain.txt');
  });

  it('loses no path-scoped gitleaks rule: none of them mentions an archive extension', () => {
    const toml = readFileSync(
      join(repoRoot(), 'docker', 'tools', 'config', 'gitleaks.toml'),
      'utf8',
    );
    const paths = [...toml.matchAll(/^path = '''(.*)'''$/gm)].map((m) => m[1] ?? '');
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths)
      expect(p, p).not.toMatch(
        /gz|zip|tar|bz2|xz|zst|lz4|\bbr\b|\bsz\b|7z|rar|\bzz\b|\blz\b|\bmz\b/i,
      );
  });
});
