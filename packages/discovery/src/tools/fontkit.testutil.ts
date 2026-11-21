// Test helpers: small, structurally valid font files. Not part of the tools API. The
// `.testutil.ts` suffix keeps it out of the build (tsconfig.build.json) like the tests, and
// fonts.test.ts checks that no non-test source imports it.

const be16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const be32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const le16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const le32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const pad4 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

export interface FontTable {
  tag: string;
  data: Buffer;
}

const DEFAULT_TABLES: FontTable[] = [
  { tag: 'cmap', data: Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]) },
  { tag: 'head', data: Buffer.alloc(54, 1) },
  { tag: 'name', data: Buffer.from([0, 0, 0, 0, 0, 6]) },
];

/** A TrueType (`0x00010000`) or OpenType (`OTTO`) file: header, directory, padded tables. */
export function sfnt(version: 'ttf' | 'otf' = 'ttf', tables = DEFAULT_TABLES): Buffer {
  const header = Buffer.concat([
    version === 'ttf' ? be32(0x00010000) : Buffer.from('OTTO'),
    be16(tables.length),
    be16(0),
    be16(0),
    be16(0),
  ]);
  let offset = 12 + 16 * tables.length;
  const dir: Buffer[] = [];
  const body: Buffer[] = [];
  for (const t of tables) {
    dir.push(Buffer.concat([Buffer.from(t.tag), be32(0), be32(offset), be32(t.data.length)]));
    const padded = pad4(t.data);
    body.push(padded);
    offset += padded.length;
  }
  return Buffer.concat([header, ...dir, ...body]);
}

/** A WOFF 1 file with uncompressed tables (compLength equals origLength). */
export function woff(tables = DEFAULT_TABLES): Buffer {
  let offset = 44 + 20 * tables.length;
  const dir: Buffer[] = [];
  const body: Buffer[] = [];
  for (const t of tables) {
    dir.push(
      Buffer.concat([
        Buffer.from(t.tag),
        be32(offset),
        be32(t.data.length),
        be32(t.data.length),
        be32(0),
      ]),
    );
    const padded = pad4(t.data);
    body.push(padded);
    offset += padded.length;
  }
  const total = offset;
  const header = Buffer.concat([
    Buffer.from('wOFF'),
    be32(0x00010000),
    be32(total),
    be16(tables.length),
    be16(0),
    be32(0), // totalSfntSize (not checked)
    be16(1),
    be16(0),
    be32(0), // metaOffset
    be32(0),
    be32(0),
    be32(0), // privOffset
    be32(0),
  ]);
  return Buffer.concat([header, ...dir, ...body]);
}

/**
 * A WOFF 2 file: the 48-byte header, then `body` (stands in for the table directory and the
 * compressed stream, which are not parsed), then optional metadata and private blocks.
 */
export function woff2(
  body: Buffer = Buffer.alloc(32, 7),
  meta: Buffer = Buffer.alloc(0),
  priv: Buffer = Buffer.alloc(0),
): Buffer {
  const metaOffset = meta.length === 0 ? 0 : 48 + body.length;
  const privOffset = priv.length === 0 ? 0 : 48 + body.length + meta.length;
  const total = 48 + body.length + meta.length + priv.length;
  const header = Buffer.concat([
    Buffer.from('wOF2'),
    be32(0x00010000), // flavor
    be32(total), // length
    be16(3), // numTables
    be16(0), // reserved
    be32(0), // totalSfntSize (not checked)
    be32(body.length), // totalCompressedSize (not checked)
    be16(1),
    be16(0), // version
    be32(metaOffset),
    be32(meta.length),
    be32(meta.length), // metaOrigLength
    be32(privOffset),
    be32(priv.length),
  ]);
  return Buffer.concat([header, body, meta, priv]);
}

const utf16name = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf16le');
  return Buffer.concat([le16(b.length), b]);
};

/** An EOT 0x00020001 file holding `fontData` (any bytes: real EOT data may be compressed). */
export function eot(fontData: Buffer = sfnt()): Buffer {
  const names = Buffer.concat([
    utf16name('Family'),
    le16(0),
    utf16name('Regular'),
    le16(0),
    utf16name('Version 1'),
    le16(0),
    utf16name('Family Regular'),
    le16(0),
    utf16name(''), // RootString
  ]);
  const fixed = (eotSize: number): Buffer =>
    Buffer.concat([
      le32(eotSize),
      le32(fontData.length),
      le32(0x00020001),
      le32(0), // flags
      Buffer.alloc(10), // PANOSE
      Buffer.from([1, 0]), // charset, italic
      le32(400),
      le16(0), // fsType
      le16(0x504c), // MagicNumber
      Buffer.alloc(16 + 8), // unicode and code page ranges
      le32(0), // checksum adjustment
      Buffer.alloc(16), // reserved
      le16(0), // padding1
    ]);
  const size = 82 + names.length + fontData.length;
  return Buffer.concat([fixed(size), names, fontData]);
}
