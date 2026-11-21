import { describe, expect, it } from 'vitest';
import { eot, sfnt, woff } from './fontkit.js';
import { fontFormatOf } from './fonts.js';

const judge = (name: string, b: Buffer) => fontFormatOf(name, b.subarray(0, 100_000), b.length);
const key = Buffer.from('\nAFFIDAVIT_FAKE_KEY_0123456789ABCDEF\n');

describe('fontFormatOf', () => {
  it('accepts structurally valid TrueType, OpenType, WOFF and EOT files', () => {
    expect(judge('a.ttf', sfnt('ttf'))).toBe('sfnt');
    expect(judge('a.otf', sfnt('otf'))).toBe('sfnt');
    expect(judge('A.TTF', sfnt('ttf'))).toBe('sfnt');
    expect(judge('a.woff', woff())).toBe('woff');
    expect(judge('a.eot', eot())).toBe('eot');
    expect(judge('a.eot', eot(Buffer.from([3, 1, 0x19, 0x38, 0, 0x94, 0x71])))).toBe('eot'); // compressed data
  });

  it('refuses a font whose extension does not agree', () => {
    expect(judge('a.js', sfnt())).toBeUndefined();
    expect(judge('a.woff', sfnt())).toBeUndefined();
    expect(judge('a.ttf', woff())).toBeUndefined();
    expect(judge('a.bin', eot())).toBeUndefined();
  });

  it('refuses bytes appended after the last table (a key behind a real font)', () => {
    expect(judge('a.ttf', Buffer.concat([sfnt(), key]))).toBeUndefined();
    expect(judge('a.otf', Buffer.concat([sfnt('otf'), key]))).toBeUndefined();
    expect(judge('a.woff', Buffer.concat([woff(), key]))).toBeUndefined();
    expect(judge('a.eot', Buffer.concat([eot(), key]))).toBeUndefined();
  });

  it('refuses a header with only the magic bytes (the probe files in tools.docker.test.ts)', () => {
    const zeros = Buffer.alloc(24);
    expect(
      judge('a.woff', Buffer.concat([Buffer.from('wOFF'), Buffer.from([0, 1, 0, 0]), zeros, key])),
    ).toBeUndefined();
    expect(
      judge('a.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.from([0, 1, 0, 0]), zeros, key])),
    ).toBeUndefined();
    expect(
      judge('a.ttf', Buffer.concat([Buffer.from([0, 1, 0, 0, 0]), zeros, key])),
    ).toBeUndefined();
    expect(
      judge('a.otf', Buffer.concat([Buffer.from('OTTO'), Buffer.from([0]), zeros, key])),
    ).toBeUndefined();
  });

  it('refuses a gap between tables and a table past the end', () => {
    const f = sfnt();
    // move the second table's offset 8 bytes on: a gap the tables do not cover
    const gap = Buffer.from(f);
    gap.writeUInt32BE(gap.readUInt32BE(12 + 16 + 8) + 8, 12 + 16 + 8);
    expect(judge('a.ttf', gap)).toBeUndefined();
    const past = Buffer.from(f);
    past.writeUInt32BE(0xffff, 12 + 12);
    expect(judge('a.ttf', past)).toBeUndefined();
  });

  it('refuses a non-printable table tag and a zero table count', () => {
    const bad = Buffer.from(sfnt());
    bad[12] = 0x01;
    expect(judge('a.ttf', bad)).toBeUndefined();
    const none = Buffer.from(sfnt());
    none.writeUInt16BE(0, 4);
    expect(judge('a.ttf', none)).toBeUndefined();
  });

  it('refuses a WOFF or EOT whose size field is not the file size', () => {
    const w = Buffer.from(woff());
    w.writeUInt32BE(w.length + 4, 8);
    expect(judge('a.woff', w)).toBeUndefined();
    const e = Buffer.from(eot());
    e.writeUInt32LE(e.length - 1, 0);
    expect(judge('a.eot', e)).toBeUndefined();
  });

  it('refuses an EOT with a bad magic number, version or nonzero reserved field', () => {
    const magic = Buffer.from(eot());
    magic.writeUInt16LE(0x1234, 34);
    expect(judge('a.eot', magic)).toBeUndefined();
    const version = Buffer.from(eot());
    version.writeUInt32LE(0x00030000, 8);
    expect(judge('a.eot', version)).toBeUndefined();
    const reserved = Buffer.from(eot());
    reserved[70] = 1;
    expect(judge('a.eot', reserved)).toBeUndefined();
  });

  it('refuses an EOT whose header does not end where the font data starts', () => {
    const e = Buffer.from(eot());
    e.writeUInt32LE(e.readUInt32LE(4) - 4, 4); // font data said to be 4 bytes shorter
    expect(judge('a.eot', e)).toBeUndefined();
  });
});
