import { open } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { listDir } from './walk.js';

/**
 * gitleaks decides from a file's leading bytes whether it is text, using a file-type library, and
 * silently skips what that library recognises as a non-text type (PDF, ELF, MZ, RTF, PostScript,
 * ar archives, Chrome extensions, zstd, cab, swf, nes ROMs, images, fonts and many more). An
 * archive it cannot unpack is dropped with only a stderr line. The exit code stays 0. A hostile
 * repo can hide a secret behind such a header, and UTF-16 text is skipped the same way.
 *
 * Discovery cannot import that library, and an allowlist of headers always lags it. So the check
 * is deliberately wide and fails safe (it over-flags):
 *  1. a broad table of known file-type signatures, which also catches ASCII headers such as
 *     `{\rtf1`, `%!PS`, `!<arch>` and `Cr24` that look like text, and
 *  2. any file whose leading bytes are not plain text: NUL bytes, invalid UTF-8, or control
 *     characters, which covers unknown binary formats and UTF-16.
 * Residual gap: an unlisted file type whose header is entirely plain text that the library still
 * recognises would be missed (documented in the README).
 */
type Sig = { at?: number; bytes: readonly number[]; exts: readonly string[] };

const s = (text: string): number[] => [...Buffer.from(text, 'latin1')];

const SIGS: readonly Sig[] = [
  { bytes: s('%PDF'), exts: ['pdf'] },
  { bytes: s('%!'), exts: ['ps', 'eps', 'ai'] },
  { bytes: s('{\\rtf'), exts: ['rtf'] },
  {
    bytes: s('PK\x03\x04'),
    exts: [
      'zip',
      'jar',
      'war',
      'docx',
      'xlsx',
      'pptx',
      'odt',
      'ods',
      'odp',
      'apk',
      'epub',
      'whl',
      'nupkg',
      'xpi',
      'vsix',
    ],
  },
  { bytes: s('PK\x05\x06'), exts: ['zip'] },
  { bytes: [0x1f, 0x8b], exts: ['gz', 'tgz'] },
  { bytes: [0x1f, 0x9d], exts: ['z'] },
  { bytes: [0x1f, 0xa0], exts: ['z'] },
  { bytes: s('BZh'), exts: ['bz2', 'tbz2'] },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], exts: ['xz', 'txz'] },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], exts: ['7z'] },
  { bytes: s('Rar!'), exts: ['rar'] },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], exts: ['zst'] },
  { bytes: [0x04, 0x22, 0x4d, 0x18], exts: ['lz4'] },
  { bytes: s('LZIP'), exts: ['lz'] },
  { at: 257, bytes: s('ustar'), exts: ['tar'] },
  { bytes: s('!<arch>'), exts: ['a', 'deb', 'lib', 'ar'] },
  { bytes: [0xed, 0xab, 0xee, 0xdb], exts: ['rpm'] },
  { bytes: s('MSCF'), exts: ['cab'] },
  { bytes: s('ISc('), exts: ['cab'] },
  { bytes: s('MZ'), exts: ['exe', 'dll', 'sys', 'ocx', 'scr', 'efi'] },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], exts: ['so', 'o', 'elf', 'bin', 'out', 'ko'] },
  { bytes: [0x00, 0x61, 0x73, 0x6d], exts: ['wasm'] },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], exts: ['class', 'dylib'] },
  { bytes: [0xfe, 0xed, 0xfa, 0xce], exts: ['dylib', 'o'] },
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], exts: ['dylib', 'o'] },
  { bytes: [0xce, 0xfa, 0xed, 0xfe], exts: ['dylib', 'o'] },
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], exts: ['dylib', 'o'] },
  { bytes: s('SQLite format 3\0'), exts: ['db', 'sqlite', 'sqlite3'] },
  { bytes: s('FWS'), exts: ['swf'] },
  { bytes: s('CWS'), exts: ['swf'] },
  { bytes: s('ZWS'), exts: ['swf'] },
  { bytes: s('Cr24'), exts: ['crx'] },
  { bytes: s('NES\x1a'), exts: ['nes'] },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], exts: ['doc', 'xls', 'ppt', 'msi'] },
  { at: 128, bytes: s('DICM'), exts: ['dcm'] },
  // images
  { bytes: [0x89, 0x50, 0x4e, 0x47], exts: ['png'] },
  { bytes: [0xff, 0xd8, 0xff], exts: ['jpg', 'jpeg'] },
  { bytes: s('GIF8'), exts: ['gif'] },
  { bytes: [0x49, 0x49, 0x2a, 0x00], exts: ['tif', 'tiff'] },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], exts: ['tif', 'tiff'] },
  { bytes: s('8BPS'), exts: ['psd'] },
  { bytes: [0x00, 0x00, 0x01, 0x00], exts: ['ico'] },
  { at: 4, bytes: s('ftyp'), exts: ['mp4', 'm4a', 'm4v', 'mov', 'heic', 'heif', 'avif', '3gp'] },
  { bytes: s('AC10'), exts: ['dwg'] },
  { bytes: s('RIFF'), exts: ['webp', 'wav', 'avi'] },
  // audio, video
  { bytes: s('ID3'), exts: ['mp3'] },
  { bytes: s('OggS'), exts: ['ogg', 'oga', 'ogv', 'opus'] },
  { bytes: s('fLaC'), exts: ['flac'] },
  { bytes: s('MThd'), exts: ['mid', 'midi'] },
  { bytes: s('#!AMR'), exts: ['amr'] },
  { bytes: s('MAC '), exts: ['ape'] },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], exts: ['mkv', 'webm'] },
  { bytes: s('FLV\x01'), exts: ['flv'] },
  { bytes: [0x30, 0x26, 0xb2, 0x75], exts: ['wmv', 'wma', 'asf'] },
  { bytes: [0x00, 0x00, 0x01, 0xba], exts: ['mpg', 'mpeg'] },
  { bytes: [0x00, 0x00, 0x01, 0xb3], exts: ['mpg', 'mpeg'] },
  // fonts
  { bytes: s('wOFF'), exts: ['woff'] },
  { bytes: s('wOF2'), exts: ['woff2'] },
  { bytes: s('OTTO'), exts: ['otf'] },
  { bytes: [0x00, 0x01, 0x00, 0x00], exts: ['ttf'] },
];

const SNIFF_BYTES = 8192;

/**
 * - `binary-asset`: a well-formed binary type whose extension agrees (a real image, archive, font).
 *   Informational: nothing a text scanner could find is lost.
 * - `binary-header-mismatch`: a binary type signature on a file whose extension does not agree, for
 *   example a `.js` or `.txt` file that starts with `%PDF`. This is the hiding technique.
 * - `non-text-header`: no known signature, but the file is not plain text: its leading bytes carry
 *   control characters, or NUL bytes or invalid UTF-8 appear anywhere in it (UTF-16 text, or text
 *   with binary bytes appended).
 * - `chunk-split-risk`: a text file over 100 KB with a 25 KB stretch that has no blank line.
 *   gitleaks reads about 100 KB chunks, extends a chunk up to 25 KB looking for a blank line, and
 *   otherwise cuts at a fixed offset (about 125,000 bytes), so a secret that straddles the cut is
 *   missed. Conservative: the real cut points are not computed.
 * - `unreadable`: could not be opened (for example mode 000), so the jailed tool cannot read it.
 */
export type UnscannableKind =
  'binary-asset' | 'binary-header-mismatch' | 'non-text-header' | 'chunk-split-risk' | 'unreadable';

export interface Unscannable {
  /** Relative path, posix separators. */
  path: string;
  kind: UnscannableKind;
}

function matches(head: Uint8Array, sig: Sig): boolean {
  const at = sig.at ?? 0;
  return sig.bytes.every((b, i) => head[at + i] === b);
}

/** Control characters other than tab, newline, vertical tab, form feed, carriage return, escape. */
function hasOddControl(head: Uint8Array): boolean {
  for (const b of head) {
    if (b < 0x20 && ![0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(b)) return true;
  }
  return false;
}

/**
 * Classifies a file from its extension and its first bytes (the sniff window), or returns
 * undefined if the window looks like plain text. NUL bytes and invalid UTF-8 later in the file are
 * found by the streaming scan in findGitleaksUnscannable.
 */
export function classifyHead(fileName: string, head: Uint8Array): UnscannableKind | undefined {
  const ext = extname(fileName).slice(1).toLowerCase();
  const sig = SIGS.find((x) => matches(head, x));
  if (sig) return sig.exts.includes(ext) ? 'binary-asset' : 'binary-header-mismatch';
  if (head.includes(0x00) || hasOddControl(head)) return 'non-text-header';
  // Valid UTF-8, allowing a multibyte character cut off at the end of the sniff window.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let trim = 0; trim <= (head.length >= SNIFF_BYTES ? 3 : 0); trim++) {
    try {
      decoder.decode(head.subarray(0, head.length - trim));
      return undefined;
    } catch {
      // try again with fewer trailing bytes
    }
  }
  return 'non-text-header';
}

export const CHUNK_RISK_MIN_FILE = 100_000;
export const CHUNK_RISK_RUN = 25_000;

/** Streaming detector for a long stretch of text with no blank line. */
export class ChunkRisk {
  private run = 0;
  private lineLen = 0;
  private total = 0;
  private longest = 0;
  feed(buf: Uint8Array): void {
    for (const b of buf) {
      this.total++;
      if (b === 0x0a) {
        if (this.lineLen === 0) this.run = 0;
        else {
          this.run++;
          this.lineLen = 0;
        }
      } else {
        this.run++;
        if (b !== 0x0d) this.lineLen++;
      }
      if (this.run > this.longest) this.longest = this.run;
    }
  }
  /** True for a file over 100 KB that has a 25 KB stretch without a blank line. */
  get risky(): boolean {
    return this.total > CHUNK_RISK_MIN_FILE && this.longest >= CHUNK_RISK_RUN;
  }
}

const READ_BYTES = 64 * 1024;

/** Streams the whole file once. Returns every kind that applies (usually none). */
async function inspectFile(full: string, name: string): Promise<UnscannableKind[]> {
  let fh;
  try {
    fh = await open(full, 'r');
  } catch {
    // Unreadable to us (for example mode 000) means unreadable to the jailed tool as well.
    return ['unreadable'];
  }
  try {
    const buf = Buffer.alloc(READ_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const risk = new ChunkRisk();
    let pos = 0;
    let broken = false;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_BYTES, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      if (pos === 0) {
        const head = classifyHead(name, chunk.subarray(0, Math.min(bytesRead, SNIFF_BYTES)));
        // A binary signature or non-text head already decides it; no need to read the rest.
        if (head) return [head];
      }
      pos += bytesRead;
      if (!broken) {
        if (chunk.includes(0x00)) broken = true;
        else {
          try {
            decoder.decode(chunk, { stream: true });
          } catch {
            broken = true;
          }
        }
      }
      risk.feed(chunk);
    }
    if (!broken) {
      try {
        decoder.decode();
      } catch {
        broken = true;
      }
    }
    const kinds: UnscannableKind[] = [];
    if (broken) kinds.push('non-text-header');
    if (risk.risky) kinds.push('chunk-split-risk');
    return kinds;
  } finally {
    await fh.close();
  }
}

/**
 * Files gitleaks may skip or may read incompletely: non-text files (whole-file check, not just the
 * start), and long text files where a secret could straddle a chunk cut. Never follows symlinks.
 */
export async function findGitleaksUnscannable(dir: string): Promise<Unscannable[]> {
  const found: Unscannable[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await listDir(d)) {
      const full = join(d, e.name);
      if (e.isDirectory) {
        await walk(full);
      } else if (e.isFile) {
        const rel = relative(dir, full).split(sep).join('/');
        for (const kind of await inspectFile(full, e.name)) found.push({ path: rel, kind });
      }
    }
  };
  await walk(dir);
  return found.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}
