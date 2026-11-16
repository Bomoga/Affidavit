import { describe, expect, it } from 'vitest';
import { ChunkRisk, classifyHead } from './unscannable.js';

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
    // gitleaks reads images, audio, video and fonts as text: informational whatever the extension
    expect(classifyHead('logo.png', png)).toBe('binary-media');
    expect(classifyHead('config.js', png)).toBe('binary-media');
    expect(classifyHead('a.woff', bytes('wOFF', [0, 1]))).toBe('binary-media');
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
