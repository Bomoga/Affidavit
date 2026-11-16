import { describe, expect, it } from 'vitest';
import { classifyHead } from './unscannable.js';

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

  it('tells a real asset from a header that does not match the file name', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(classifyHead('logo.png', png)).toBe('binary-asset');
    expect(classifyHead('config.js', png)).toBe('binary-header-mismatch');
    expect(classifyHead('notes.txt', bytes('%PDF-1.4 secret'))).toBe('binary-header-mismatch');
    expect(classifyHead('x.dat', bytes([1, 2, 3, 4, 5]))).toBe('non-text-header');
  });

  it('leaves plain text alone', () => {
    expect(classifyHead('a.js', bytes('const a = 1;\n\tif (x) {}\r\n'))).toBeUndefined();
    expect(classifyHead('a.md', Buffer.from('café ✓ \u{1f600}\n'))).toBeUndefined();
    expect(classifyHead('empty.txt', Buffer.alloc(0))).toBeUndefined();
  });

  it('does not flag text whose last multibyte character is cut off by the sniff window', () => {
    const text = Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from('é')]).subarray(0, 8192);
    expect(text.length).toBe(8192);
    expect(classifyHead('a.txt', text)).toBeUndefined();
  });
});
