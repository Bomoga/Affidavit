import { extname } from 'node:path';

/**
 * Font files whose structure checks out. gitleaks skips TrueType, OpenType and WOFF files (probed
 * on the pinned image: mime application/font-sfnt and application/font-woff) and has no reliable
 * way to read an EOT file (binary header, NUL bytes), so their bytes are NOT scanned. They are a
 * web asset, not code: ingestion keeps every such file out of the workspace (reason `font-file`)
 * and records it, the same way media files are handled, so the unscanned bytes never leave.
 *
 * "Structure checks out" is deliberately strict, so a blob under a font name is not waved through:
 *  - the extension agrees with the format,
 *  - the header's own size field equals the file size (WOFF, WOFF2, EOT),
 *  - for TrueType, OpenType and WOFF, the table directory is in bounds, every table tag is
 *    printable ASCII, and the tables (plus WOFF metadata and private blocks) cover the whole file
 *    after the directory, with at most 3 bytes of padding between blocks and at the end. Nothing
 *    can be appended after the last table or hidden in a gap,
 *  - for EOT, the header is parsed field by field and must end exactly where the font data
 *    starts, and the font data must end the file (see eotOk).
 * A file that fails any check keeps its old classification (`skipped-file-type` or
 * `non-text-content`), which is a coverage loss, so ingestion still fails closed on it. The caller
 * also refuses a name gitleaks reads as an archive (see classifyFile in unscannable.ts).
 */
export type FontFormat = 'sfnt' | 'woff' | 'woff2' | 'eot';

const EXT_FORMATS: Record<string, readonly FontFormat[]> = {
  ttf: ['sfnt'],
  otf: ['sfnt'],
  woff: ['woff'],
  woff2: ['woff2'],
  eot: ['eot'],
};

/** Bytes of the head a caller passes: the gitleaks sniff window, which holds any directory here. */
export const FONT_HEAD_BYTES = 100_000;

const MAX_TABLES = 1024;
const PAD = 3;

const u16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32 = (b: Uint8Array, at: number): number => u16(b, at) * 0x10000 + u16(b, at + 2);
const le16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const le32 = (b: Uint8Array, at: number): number => le16(b, at) + le16(b, at + 2) * 0x10000;

const printableTag = (b: Uint8Array, at: number): boolean => {
  for (let k = 0; k < 4; k++) {
    const c = b[at + k];
    if (c === undefined || c < 0x20 || c > 0x7e) return false;
  }
  return true;
};

/**
 * True when the blocks, in any order, tile [from, size) with gaps of at most PAD bytes and no
 * overlap. Each block is [offset, offset + length); empty blocks are ignored.
 */
function tiles(blocks: { offset: number; length: number }[], from: number, size: number): boolean {
  const sorted = blocks.filter((x) => x.length > 0).sort((a, b) => a.offset - b.offset);
  let cursor = from;
  for (const x of sorted) {
    if (x.offset < cursor || x.offset - cursor > PAD) return false;
    if (x.offset + x.length > size) return false;
    cursor = x.offset + x.length;
  }
  return size >= cursor && size - cursor <= PAD;
}

function sfntOk(h: Uint8Array, size: number): boolean {
  const version = u32(h, 0);
  // 0x00010000 (TrueType outlines), 'OTTO' (CFF outlines), 'true' (old Apple TrueType)
  if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) return false;
  const n = u16(h, 4);
  if (n < 1 || n > MAX_TABLES) return false;
  const dirEnd = 12 + 16 * n;
  if (dirEnd > size || dirEnd > h.length) return false;
  const blocks: { offset: number; length: number }[] = [];
  for (let t = 0; t < n; t++) {
    const at = 12 + 16 * t;
    if (!printableTag(h, at)) return false;
    blocks.push({ offset: u32(h, at + 8), length: u32(h, at + 12) });
  }
  return tiles(blocks, dirEnd, size);
}

function woffOk(h: Uint8Array, size: number): boolean {
  if (h.length < 44 || u32(h, 0) !== 0x774f4646 || u32(h, 8) !== size || u16(h, 14) !== 0) {
    return false;
  }
  const n = u16(h, 12);
  if (n < 1 || n > MAX_TABLES) return false;
  const dirEnd = 44 + 20 * n;
  if (dirEnd > size || dirEnd > h.length) return false;
  const blocks: { offset: number; length: number }[] = [];
  for (let t = 0; t < n; t++) {
    const at = 44 + 20 * t;
    if (!printableTag(h, at)) return false;
    const compLength = u32(h, at + 8);
    if (compLength > u32(h, at + 12)) return false; // compressed is never longer than original
    blocks.push({ offset: u32(h, at + 4), length: compLength });
  }
  blocks.push({ offset: u32(h, 24), length: u32(h, 28) }); // metadata
  blocks.push({ offset: u32(h, 36), length: u32(h, 40) }); // private data
  return tiles(blocks, dirEnd, size);
}

function woff2Ok(h: Uint8Array, size: number): boolean {
  if (h.length < 48 || u32(h, 0) !== 0x774f4632 || u32(h, 8) !== size || u16(h, 14) !== 0) {
    return false;
  }
  const n = u16(h, 12);
  if (n < 1 || n > MAX_TABLES) return false;
  const inBounds = (offset: number, length: number): boolean =>
    length === 0 || (offset >= 48 && offset + length <= size);
  return inBounds(u32(h, 28), u32(h, 32)) && inBounds(u32(h, 40), u32(h, 44));
}

/**
 * The EOT header (Microsoft's Embedded OpenType format, versions 0x00010000, 0x00020001 and
 * 0x00020002) is parsed field by field: the fixed part, then each length-prefixed name (with its
 * zero padding word), the root string, and for 0x00020002 the signature and EUDC blocks. The
 * header must end exactly where the font data (FontDataSize bytes) starts, and the font data must
 * end the file (EOTSize). The font data itself may be compressed (MicroType Express), so it is
 * not parsed.
 */
function eotOk(h: Uint8Array, size: number): boolean {
  if (h.length < 82 || le32(h, 0) !== size) return false;
  const version = le32(h, 8);
  if (version !== 0x00010000 && version !== 0x00020001 && version !== 0x00020002) return false;
  if (le16(h, 34) !== 0x504c) return false; // MagicNumber
  for (let at = 64; at < 82; at += 2) if (le16(h, at) !== 0) return false; // Reserved1-4, Padding1
  let at = 82;
  const block = (lenBytes: 2 | 4): boolean => {
    if (at + lenBytes > h.length) return false;
    const n = lenBytes === 2 ? le16(h, at) : le32(h, at);
    at += lenBytes + n;
    return at <= size;
  };
  const zeroPad = (): boolean => {
    if (at + 2 > h.length || le16(h, at) !== 0) return false;
    at += 2;
    return true;
  };
  // FamilyName, StyleName, VersionName, FullName, each after the first behind a zero pad
  if (!block(2)) return false;
  for (let k = 0; k < 3; k++) if (!zeroPad() || !block(2)) return false;
  if (version !== 0x00010000) {
    if (!zeroPad() || !block(2)) return false; // RootString
  }
  if (version === 0x00020002) {
    at += 8; // RootStringCheckSum, EUDCCodePage
    if (!zeroPad() || !block(2)) return false; // Signature
    at += 4; // EUDCFlags
    if (!block(4)) return false; // EUDCFontData
  }
  const fontData = le32(h, 4);
  return fontData > 0 && at + fontData === size;
}

const CHECKS: Record<FontFormat, (h: Uint8Array, size: number) => boolean> = {
  sfnt: sfntOk,
  woff: woffOk,
  woff2: woff2Ok,
  eot: eotOk,
};

/**
 * The font format of a file, judged from its name, its first bytes (`head`: the first
 * FONT_HEAD_BYTES, or the whole file if shorter) and its size, or undefined if it is not a font
 * whose structure checks out.
 */
export function fontFormatOf(
  fileName: string,
  head: Uint8Array,
  size: number,
): FontFormat | undefined {
  const formats = EXT_FORMATS[extname(fileName).slice(1).toLowerCase()];
  if (formats === undefined) return undefined;
  return formats.find((f) => CHECKS[f](head, size));
}
