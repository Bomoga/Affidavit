import { open } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fontFormatOf } from './fonts.js';
import { NonUtf8NameError, listDir } from './walk.js';

/**
 * gitleaks decides from a file's leading bytes (its first chunk, about 100 KB) whether it is text,
 * using a file-type library. Probed on the pinned image with a recognised header followed by a
 * plaintext secret: it skips the "application" types (PDF, PostScript, RTF, zip and every archive
 * format, Windows and Mach-O executables, Java classes, SQLite, Chrome extensions, NES ROMs, Word
 * documents, DICOM, Flash, cab) and READS images, audio and video as text (fonts are skipped too). The exit code is
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

/**
 * Extensions of the signature groups gitleaks reads as text, probed with complete headers and
 * gitleaks debug logging: images, audio, video. Fonts are NOT here: gitleaks skips them
 * (mime application/font-sfnt and application/font-woff).
 */
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
]);

const isMedia = (sig: Sig): boolean => sig.exts.some((e) => MEDIA_EXTS.has(e));

/** gitleaks reads in chunks of defaultBufferSize, 100,000 bytes, and checks the first chunk. */
const SNIFF_BYTES = 100_000;

/**
 * - `binary-media`: an image, audio or video signature on a file whose extension agrees. gitleaks
 *   reads these as text, so a plaintext secret inside is found. Informational only. The text and
 *   chunk checks are NOT run on these files (a real image has NUL bytes, so the text check would
 *   flag every one): a UTF-16 secret or a chunk-cut secret inside a real media file is an accepted
 *   gap. The same signature on a file with another extension (`GIF89a` at the top of `app.env`)
 *   is a `binary-header-mismatch`.
 * - `skipped-file-type`: a file type gitleaks skips (archives, PDF, SQLite, executables and the
 *   other "application" types) whose extension agrees with the signature. Archives it can unpack
 *   are searched, but members it cannot read (UTF-16, another skipped header) are not, and the
 *   host does not unpack them, so the file counts as a coverage loss.
 * - `binary-header-mismatch`: a known signature (skipped type or media) on a file whose extension
 *   does not agree, for example a `.js` or `.txt` file that starts with `%PDF` or `GIF89a`. This
 *   is the hiding technique.
 * - `archive-name-mismatch`: a file whose NAME makes gitleaks treat it as an archive but whose
 *   content carries no known signature at all (plain text called `a.gz`, `config.zip.env`,
 *   `notes.tar.txt`). gitleaks picks the archive format from the name, fails to extract plain
 *   text, and drops the file with exit 0, in every pass. The matching rule was probed on the
 *   pinned image (see ARCHIVE_NAME). The windows pass scans such files under a neutral name.
 * - `non-text-content`: no known signature, but the file is not plain text: control characters at
 *   the start, or NUL bytes or invalid UTF-8 anywhere (UTF-16 text, or text with binary bytes
 *   appended).
 * - `chunk-split-risk`: a text file over 100 KB with a 25 KB stretch that has no blank line. A
 *   blank line is an empty line or one holding only spaces, tabs or a carriage return. gitleaks
 *   reads 100,000-byte chunks and looks up to 25,000 bytes further for a blank line to cut at;
 *   if there is none the cut is at a hard limit, and every possible hard cut lies inside such a
 *   stretch. A secret that straddles the cut is missed. gitleaks also repeats its binary check on
 *   each chunk until it has seen a newline, which the same long no-newline stretch covers.
 * - `multiline-split-risk`: a file over 100,000 bytes holding a private-key block (begin marker
 *   `-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY`, close `KEY( BLOCK)?-----`, both case-insensitive,
 *   as in gitleaks' private-key rule) with a blank-ish line `\n[ \t\r]*\n` inside it. Real cuts
 *   are either at a blank-line boundary or at the hard limit, and the hard limit is covered by
 *   `chunk-split-risk`. So any file that is large enough to be cut and has a blank line inside a
 *   key block is flagged, wherever the cuts really fall. It fails safe: it flags keys that no cut
 *   would split. Probed against the pinned gitleaks: a key with a blank line inside is missed at
 *   some offsets and found at others; a key without one is always found.
 * - `binary-font`: a TrueType, OpenType, WOFF, WOFF2 or EOT file whose extension agrees and whose
 *   structure checks out (fonts.ts). gitleaks does not scan it. A coverage loss for the tools layer;
 *   ingestion keeps such files out of the workspace (reason `font-file`), like media. A font that
 *   fails the structure check keeps its old kind (`skipped-file-type` or `non-text-content`).
 * - `unreadable`: could not be opened by the host user, or a directory that could not be listed. This is judged by the uid discovery runs
 *   as, so it is unreliable if the worker runs as root (root can open mode 000 files that the
 *   unprivileged jail cannot).
 */
export type UnscannableKind =
  | 'binary-media'
  | 'binary-font'
  | 'skipped-file-type'
  | 'binary-header-mismatch'
  | 'archive-name-mismatch'
  | 'non-text-content'
  | 'chunk-split-risk'
  | 'multiline-split-risk'
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
export function hasOddControl(head: Uint8Array): boolean {
  for (const b of head) {
    if (b < 0x20 && ![0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(b)) return true;
  }
  return false;
}

/**
 * File names that make gitleaks 8.30.1 try to extract the file as an archive. Derived by probing
 * the pinned image on a Linux filesystem with plain text under 500 names (every extension in a
 * broad list, in lower, upper and capitalised case, with and without a trailing extension or
 * suffix); this rule predicts all of them. It matches on the file's own name, not on directory
 * names, in any case, and it is a PREFIX match: `.gz` also matches `.gzx` and `.gzip`.
 *   - `.gz .zip .tar .bz2 .xz .zst .lz4 .br .sz .7z .rar .zz` anywhere in the name, followed by
 *     anything (so `a.zip.js`, `a.tar.foo`, `a.zipx`, `a.zstd` all match);
 *   - `.lz` and `.mz` only as the last extension.
 * Not matched: `.tgz .tbz2 .txz .tzst .jar .war .Z .lzma .cpio .lzip .rpm .deb .cab .iso .bz`
 * and `.txt`, `.js`, `.env` and the like.
 */
export const ARCHIVE_NAME = /\.(?:gz|zip|tar|bz2|xz|zst|lz4|br|sz|7z|rar|s2|zz)|\.(?:lz|mz)$/i;

/**
 * Renames the archive tokens in a file name so gitleaks no longer treats it as an archive, while
 * keeping its final extension (so path rules such as `\.ya?ml$` still apply): `a.gz.yaml` becomes
 * `a._gz.yaml`. Used for windows of such files.
 */
export function neutralArchiveName(name: string): string {
  return name
    .replace(/\.(?=(?:gz|zip|tar|bz2|xz|zst|lz4|br|sz|7z|rar|s2|zz))/gi, '._')
    .replace(/\.(?=(?:lz|mz)$)/i, '._');
}

/** Extensions of the signatures in SIGS that are real archive or compression formats. */
const ARCHIVE_SIG_EXTS = [
  'zip',
  'gz',
  'tgz',
  'bz2',
  'tbz2',
  'xz',
  'txz',
  '7z',
  'rar',
  'zst',
  'lz4',
  'lz',
  'tar',
  'ar',
  'z',
];

/** What kind of signature a head carries: none, media, a real archive format, or something else. */
export function signatureClass(head: Uint8Array): 'none' | 'media' | 'archive' | 'other' {
  const sig = SIGS.find((x) => matches(head, x));
  if (sig === undefined) return 'none';
  if (isMedia(sig)) return 'media';
  return ARCHIVE_SIG_EXTS.some((e) => sig.exts.includes(e)) ? 'archive' : 'other';
}

/**
 * Classifies a file from its extension and its first bytes (the sniff window), or returns
 * undefined if the window looks like plain text. NUL bytes and invalid UTF-8 later in the file are
 * found by the streaming scan in findGitleaksUnscannable.
 */
export function classifyHead(fileName: string, head: Uint8Array): UnscannableKind | undefined {
  const ext = extname(fileName).slice(1).toLowerCase();
  const sig = SIGS.find((x) => matches(head, x));
  // A name gitleaks reads as an archive. Unless the content really is an archive, gitleaks tries
  // to extract it and drops it. That holds for plain text and equally for an image or media file
  // (`logo.brand.png`, `anim.zip.gif`, `a.tar.mp3`), so the name is checked before the media
  // branch below.
  if (
    ARCHIVE_NAME.test(fileName) &&
    (sig === undefined || !ARCHIVE_SIG_EXTS.some((e) => sig.exts.includes(e)))
  ) {
    return 'archive-name-mismatch';
  }
  if (sig) {
    if (!sig.exts.includes(ext)) return 'binary-header-mismatch';
    return isMedia(sig) ? 'binary-media' : 'skipped-file-type';
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
const CHUNK_SIZE = 100_000;

/**
 * Streaming detector for a long stretch of text with no blank line. A blank line is an empty line
 * or one holding only spaces, tabs or carriage returns. Works on newline positions (indexOf).
 */
export class ChunkRisk {
  private run = 0; // bytes since the last blank line, not counting the current partial line
  private segLen = 0; // bytes of the current line so far
  private segWs = true; // the current line so far holds only spaces, tabs and carriage returns
  private total = 0;
  private longest = 0;

  feed(buf: Uint8Array): void {
    this.total += buf.length;
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      const end = nl < 0 ? buf.length : nl;
      if (end > pos) {
        this.segLen += end - pos;
        for (let i = pos; this.segWs && i < end; i++) {
          const b = buf[i];
          if (b !== 0x20 && b !== 0x09 && b !== 0x0d) this.segWs = false;
        }
      }
      if (nl < 0) break;
      const blank = this.segWs;
      // A blank line restarts the stretch AT that line, not after it: gitleaks only cuts early at
      // a blank line whose newlines both come after the 100,000-byte point, so a whitespace-only
      // line that straddles it does not help. Starting the new run with the line's own bytes
      // keeps the stretch conservative.
      if (blank) this.run = this.segLen + 1;
      else this.run += this.segLen + 1;
      this.segLen = 0;
      this.segWs = true;
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

const PK_BEGIN = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/gi;
const PK_END = /KEY(?: BLOCK)?-----/gi;
/** Longest begin marker is 11 + 100 + 17 characters; keep a margin so no marker is cut in two. */
const PK_CARRY = 160;
const PK_MIN_BODY = 64;
const HAS_NON_WS = /[^ \t\r]/;

/**
 * Streaming detector for a private-key block with a blank-ish line inside it. O(1) state: whether
 * a block is open, where its begin marker ended, whether a blank line was seen in it, and the tail
 * of the previous buffer so a marker split across two reads is still found.
 */
export class PrivateKeyScan {
  private abs = 0; // absolute offset of the end of the data fed so far
  private carry = ''; // last PK_CARRY characters of the previous buffer
  private open = false;
  private beginEnd = 0; // absolute end of the open block's FIRST begin marker
  private lastBegin = 0; // absolute end of the most recent begin marker seen
  private blank = false; // a blank-ish line was seen inside the open block
  private flagged = false;
  private total = 0;
  // line state, carried across buffers: does the current line so far hold only whitespace, and did
  // it start right after a newline (a blank line needs a newline on both sides)?
  private lineWs = true;
  private afterNewline = false;

  feed(buf: Uint8Array): void {
    const text = Buffer.from(buf.buffer, buf.byteOffset, buf.length).toString('latin1');
    const joined = this.carry + text;
    const base = this.abs - this.carry.length;
    this.total += buf.length;

    // 1. markers, only those that end in the new text (earlier ones were handled last time)
    const events: { at: number; kind: 'begin' | 'end' | 'blank'; end: number }[] = [];
    for (const m of joined.matchAll(PK_BEGIN)) {
      const end = m.index + m[0].length;
      if (end > this.carry.length)
        events.push({ at: base + m.index, kind: 'begin', end: base + end });
    }
    for (const m of joined.matchAll(PK_END)) {
      const end = m.index + m[0].length;
      if (end > this.carry.length)
        events.push({ at: base + m.index, kind: 'end', end: base + end });
    }

    // 2. blank-ish lines, from a per-line state machine over the new text only
    let pos = 0;
    while (pos <= text.length) {
      const nl = text.indexOf('\n', pos);
      const end = nl < 0 ? text.length : nl;
      if (this.lineWs && end > pos && HAS_NON_WS.test(text.slice(pos, end))) this.lineWs = false;
      if (nl < 0) break;
      if (this.afterNewline && this.lineWs) {
        events.push({ at: this.abs + nl, kind: 'blank', end: this.abs + nl });
      }
      this.afterNewline = true;
      this.lineWs = true;
      pos = nl + 1;
    }

    events.sort((x, y) => x.at - y.at);
    for (const e of events) {
      if (e.kind === 'begin') {
        this.lastBegin = e.end;
        if (!this.open) {
          this.open = true;
          this.beginEnd = e.end;
          this.blank = false;
        } else {
          // A second begin marker (a decoy comment, a stray marker, or a header written twice) must
          // not end the block early, and must not reset its blank flag: gitleaks reads on past it.
          // The 64-character minimum before a close is measured from the FIRST header end, as in
          // gitleaks' regex, so a later header's own \`KEY-----\` can still close the block (header A
          // with no END, a blank line, header B: gitleaks can match A up to B's header).
        }
      } else if (e.kind === 'blank') {
        if (this.open) this.blank = true;
      } else if (this.open && e.at >= this.beginEnd + PK_MIN_BODY) {
        // gitleaks needs at least 64 characters between the header and the close marker, so a
        // close marker sooner than that (an \`xKEY-----\` line right after the header) is not one.
        if (this.blank) this.flagged = true;
        this.open = false;
        // A close that is the header of a later begin marker (its own KEY-----) ends the first
        // block but starts the next one, so a real key after a decoy is still tracked.
        if (e.at < this.lastBegin) {
          this.open = true;
          this.beginEnd = this.lastBegin;
          this.blank = false;
        }
      }
    }

    this.abs += buf.length;
    this.carry = joined.slice(Math.max(0, joined.length - PK_CARRY));
  }

  /** True for a file over 100,000 bytes with a blank-ish line inside a private-key block. */
  get risky(): boolean {
    return this.total > CHUNK_SIZE && this.flagged;
  }
}

const READ_BYTES = 64 * 1024;

/** Feeds the rest of a media file to the private-key scan. Bounded memory, the worker's buffer. */
async function mediaKeyRisk(
  fh: Awaited<ReturnType<typeof open>>,
  buf: Buffer,
  from: number,
  keys: PrivateKeyScan,
): Promise<boolean> {
  let pos = from;
  for (;;) {
    const { bytesRead } = await fh.read(buf, 0, READ_BYTES, pos);
    if (bytesRead === 0) break;
    keys.feed(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return keys.risky;
}

/**
 * Streams the file once (bounded memory, using the worker's own buffer). Returns every kind that
 * applies (usually none). `buf` must be at least SNIFF_BYTES long.
 */
async function inspectFile(full: string, name: string, buf: Buffer): Promise<UnscannableKind[]> {
  let fh;
  try {
    fh = await open(full, 'r');
  } catch {
    return ['unreadable'];
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const risk = new ChunkRisk();
    const keys = new PrivateKeyScan();
    let pos = 0;
    let first = true;
    for (;;) {
      const want = first ? SNIFF_BYTES : READ_BYTES;
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      if (first) {
        // A font whose structure checks out (never under a name gitleaks reads as an archive).
        if (!ARCHIVE_NAME.test(name) && fontFormatOf(name, chunk, (await fh.stat()).size)) {
          return ['binary-font'];
        }
        const head = classifyHead(name, chunk);
        // A known signature or a non-text start decides it; no need to read the rest.
        if (head === 'binary-media') {
          // Real media has NUL bytes and long runs without blank lines, so the text and chunk
          // checks do not apply, but a private key inside it is still checked.
          keys.feed(chunk);
          return (await mediaKeyRisk(fh, buf, pos + chunk.length, keys))
            ? ['binary-media', 'multiline-split-risk']
            : ['binary-media'];
        }
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
      keys.feed(chunk);
    }
    try {
      decoder.decode();
    } catch {
      return ['non-text-content'];
    }
    const kinds: UnscannableKind[] = [];
    if (risk.risky) kinds.push('chunk-split-risk');
    if (keys.risky) kinds.push('multiline-split-risk');
    return kinds;
  } finally {
    await fh.close();
  }
}

export interface FindOptions {
  /** Return true to skip a file or directory (path relative to the walked dir, posix separators). */
  skip?: (relPath: string, isDirectory: boolean) => boolean;
  /** Files inspected at once, at least 1. Memory stays bounded: one 100 KB buffer per worker. */
  concurrency?: number;
}

/**
 * Files gitleaks may skip or may read incompletely: non-text files (whole-file check, not just the
 * start), types gitleaks skips, and long text files where a secret could straddle a chunk cut.
 * Never follows symlinks. A directory that cannot be listed is reported as `unreadable`.
 */
export async function findGitleaksUnscannable(
  dir: string,
  options: FindOptions = {},
): Promise<Unscannable[]> {
  const found: Unscannable[] = [];
  const files: { full: string; rel: string; name: string }[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await listDir(d);
    } catch (e) {
      if (e instanceof NonUtf8NameError) throw e;
      const rel = relative(dir, d).split(sep).join('/');
      if (rel !== '') {
        found.push({ path: rel, kind: 'unreadable' });
        return;
      }
      throw e; // the snapshot root itself must be readable
    }
    for (const e of entries) {
      const full = join(d, e.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (options.skip?.(rel, e.isDirectory)) continue;
      if (e.isDirectory) await walk(full);
      else if (e.isFile) files.push({ full, rel, name: e.name });
    }
  };
  await walk(dir);

  let next = 0;
  let failed: unknown;
  let hasFailed = false;
  const worker = async (): Promise<void> => {
    const buf = Buffer.alloc(SNIFF_BYTES); // one buffer per worker, reused for every file
    while (!hasFailed) {
      const i = next++;
      const f = files[i];
      if (!f) return;
      try {
        for (const kind of await inspectFile(f.full, f.name, buf)) {
          found.push({ path: f.rel, kind });
        }
      } catch (e) {
        if (!hasFailed) {
          hasFailed = true;
          failed = e;
        }
        return;
      }
    }
  };
  const asked = options.concurrency;
  const workers =
    typeof asked === 'number' && Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : 8;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (hasFailed) throw failed;
  return found.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}
