import { open } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { listDir } from './walk.js';

/**
 * gitleaks decides from a file's leading bytes (its first chunk, about 100 KB) whether it is text,
 * using a file-type library. Probed on the pinned image with a recognised header followed by a
 * plaintext secret: it skips the "application" types (PDF, PostScript, RTF, zip and every archive
 * format, Windows and Mach-O executables, Java classes, SQLite, Chrome extensions, NES ROMs, Word
 * documents, DICOM, Flash, cab) and READS images, audio, video and fonts as text. The exit code is
 * 0 either way. Archives it can unpack are searched (--max-archive-depth), but a member stored as
 * UTF-16 or behind another skipped header is skipped again.
 *
 * Discovery cannot import that library, and a header allowlist always lags it, so the check is
 * deliberately wide and fails safe (it over-flags):
 *  1. a broad table of known file-type signatures, including ASCII headers such as `{\rtf1`,
 *     `%!PS`, `!<arch>` and `Cr24` that look like text. A signature in a media group (image,
 *     audio, video, font) is informational. Every other signature is a coverage loss. The library
 *     checks lengths and structure beyond the magic bytes, so a type that was read in the probe
 *     with only its magic may still be skipped when the header is complete; types outside the
 *     media groups are therefore all treated as skipped,
 *  2. any file that is not plain text: NUL bytes or invalid UTF-8 anywhere, or control characters
 *     at the start, which covers unknown binary formats and UTF-16.
 * Residual gap: an unlisted file type whose header is entirely plain text that the library still
 * recognises would be missed (documented in the README).
 */
export type Sig = { at?: number; bytes: readonly number[]; exts: readonly string[] };

const s = (text: string): number[] => [...Buffer.from(text, 'latin1')];

export const SIGS: readonly Sig[] = [
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
  { at: 32769, bytes: s('CD001'), exts: ['iso'] },
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

/** Extensions of the signature groups gitleaks reads as text (probed): images, media, fonts. */
const MEDIA_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'tif',
  'tiff',
  'psd',
  'ico',
  'dwg',
  'webp',
  'wav',
  'avi',
  'mp4',
  'm4a',
  'm4v',
  'mov',
  'heic',
  'heif',
  'avif',
  '3gp',
  'mp3',
  'ogg',
  'oga',
  'ogv',
  'opus',
  'flac',
  'mid',
  'midi',
  'amr',
  'ape',
  'mkv',
  'webm',
  'flv',
  'wmv',
  'wma',
  'asf',
  'mpg',
  'mpeg',
  'woff',
  'woff2',
  'otf',
  'ttf',
]);

const isMedia = (sig: Sig): boolean => sig.exts.some((e) => MEDIA_EXTS.has(e));

/** gitleaks looks at the first chunk (about 100 KB) to decide text or binary. */
const SNIFF_BYTES = 102_400;

/**
 * - `binary-media`: an image, audio, video or font signature. gitleaks reads these as text, so a
 *   plaintext secret inside is found. Informational only; not a coverage loss.
 * - `skipped-file-type`: a file type gitleaks skips (archives, PDF, SQLite, executables and the
 *   other "application" types) whose extension agrees with the signature. Archives it can unpack
 *   are searched, but members it cannot read (UTF-16, another skipped header) are not, and the
 *   host does not unpack them, so the file counts as a coverage loss.
 * - `binary-header-mismatch`: the same skipped signature on a file whose extension does not agree,
 *   for example a `.js` or `.txt` file that starts with `%PDF`. This is the hiding technique.
 * - `non-text-content`: no known signature, but the file is not plain text: control characters at
 *   the start, or NUL bytes or invalid UTF-8 anywhere (UTF-16 text, or text with binary bytes
 *   appended).
 * - `chunk-split-risk`: a text file over 100 KB with a 25 KB stretch that has no blank line.
 *   gitleaks reads about 100 KB chunks, extends a chunk up to 25 KB looking for a blank line, and
 *   otherwise cuts at a fixed offset (about 125,000 bytes), so a secret that straddles the cut is
 *   missed. Conservative: the real cut points are not computed.
 * - `unreadable`: could not be opened by the host user. This is judged by the uid discovery runs
 *   as, so it is unreliable if the worker runs as root (root can open mode 000 files that the
 *   unprivileged jail cannot).
 */
export type UnscannableKind =
  | 'binary-media'
  | 'skipped-file-type'
  | 'binary-header-mismatch'
  | 'non-text-content'
  | 'chunk-split-risk'
  | 'unreadable';

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
  if (sig) {
    if (isMedia(sig)) return 'binary-media';
    return sig.exts.includes(ext) ? 'skipped-file-type' : 'binary-header-mismatch';
  }
  if (head.includes(0x00) || hasOddControl(head)) return 'non-text-content';
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
  return 'non-text-content';
}

export const CHUNK_RISK_MIN_FILE = 100_000;
export const CHUNK_RISK_RUN = 25_000;

/**
 * Streaming detector for a long stretch of text with no blank line. A blank line is an empty line
 * or one holding only a carriage return. Works on newline positions (indexOf), not byte by byte.
 */
export class ChunkRisk {
  private run = 0; // bytes since the last blank line, not counting the current partial line
  private segLen = 0; // bytes of the current line so far
  private segFirst = -1;
  private total = 0;
  private longest = 0;

  feed(buf: Uint8Array): void {
    this.total += buf.length;
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      const end = nl < 0 ? buf.length : nl;
      if (end > pos) {
        if (this.segLen === 0) this.segFirst = buf[pos] ?? -1;
        this.segLen += end - pos;
      }
      if (nl < 0) break;
      const blank = this.segLen === 0 || (this.segLen === 1 && this.segFirst === 0x0d);
      if (blank) this.run = 0;
      else this.run += this.segLen + 1;
      this.segLen = 0;
      this.segFirst = -1;
      if (this.run > this.longest) this.longest = this.run;
      pos = nl + 1;
    }
    // the unfinished line also counts toward the stretch
    if (this.run + this.segLen > this.longest) this.longest = this.run + this.segLen;
  }

  /** True for a file over 100 KB that has a 25 KB stretch without a blank line. */
  get risky(): boolean {
    return this.total > CHUNK_RISK_MIN_FILE && this.longest >= CHUNK_RISK_RUN;
  }
}

const READ_BYTES = 64 * 1024;

/** Streams the file once (bounded memory). Returns every kind that applies (usually none). */
async function inspectFile(full: string, name: string): Promise<UnscannableKind[]> {
  let fh;
  try {
    fh = await open(full, 'r');
  } catch {
    return ['unreadable'];
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const risk = new ChunkRisk();
    let pos = 0;
    let first = true;
    for (;;) {
      const buf = Buffer.alloc(first ? SNIFF_BYTES : READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      if (first) {
        const head = classifyHead(name, chunk);
        // A known signature or a non-text start decides it; no need to read the rest.
        if (head) return [head];
        first = false;
      }
      pos += bytesRead;
      // Decided as soon as a NUL or invalid UTF-8 appears: the file is non-text, stop reading.
      if (chunk.includes(0x00)) return ['non-text-content'];
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        return ['non-text-content'];
      }
      risk.feed(chunk);
    }
    try {
      decoder.decode();
    } catch {
      return ['non-text-content'];
    }
    return risk.risky ? ['chunk-split-risk'] : [];
  } finally {
    await fh.close();
  }
}

export interface FindOptions {
  /** Return true to skip a file or directory (path relative to the walked dir, posix separators). */
  skip?: (relPath: string, isDirectory: boolean) => boolean;
  /** Files inspected at once. Memory stays bounded: each holds at most one 100 KB buffer. */
  concurrency?: number;
}

/**
 * Files gitleaks may skip or may read incompletely: non-text files (whole-file check, not just the
 * start), types gitleaks skips, and long text files where a secret could straddle a chunk cut.
 * Never follows symlinks.
 */
export async function findGitleaksUnscannable(
  dir: string,
  options: FindOptions = {},
): Promise<Unscannable[]> {
  const files: { full: string; rel: string; name: string }[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await listDir(d)) {
      const full = join(d, e.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (options.skip?.(rel, e.isDirectory)) continue;
      if (e.isDirectory) await walk(full);
      else if (e.isFile) files.push({ full, rel, name: e.name });
    }
  };
  await walk(dir);

  const found: Unscannable[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < files.length; i = next++) {
      const f = files[i];
      if (!f) continue;
      for (const kind of await inspectFile(f.full, f.name)) found.push({ path: f.rel, kind });
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 8 }, () => worker()));
  return found.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}
