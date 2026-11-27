import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ToolInvocation } from './invocations.js';

/**
 * When the windows pass is a proof of full coverage, so a `chunk-split-risk` flag can be lifted.
 *
 * gitleaks cuts a large file into chunks and can miss a secret that straddles a cut. The windows
 * pass (windows.ts) scans the file again in windows under 100,000 bytes that overlap by
 * OVERLAP_BYTES (16,000), so every stretch of up to 16,000 bytes lies wholly inside one window and
 * is read in one piece. That finds every match of every rule, as long as no match can be longer
 * than 16,000 bytes. This module decides that, for one file:
 *
 *  1. The config is the one that was analyzed: the vendored docker/tools/config/gitleaks.toml,
 *     checked by its sha256 (ANALYZED_GITLEAKS_CONFIG_SHA256, line endings normalized). The file
 *     hashed is the one the container mounts, resolved from the invocation's own `--config` and
 *     mounts (mountedConfigFile). Any other config gets no proof.
 *  2. The file's longest line is at most PROOF_CAPS.line bytes and its longest whitespace run at
 *     most PROOF_CAPS.ws bytes, counted in the raw bytes and in every decoded view of a line
 *     (base64, hex, percent, to DECODE_DEPTH; a decoded run also counts the raw whitespace next to
 *     it, but at depth 1 or deeper only 6 characters of it). gitleaks decodes the whole fragment and a newline is whitespace too, so pieces too
 *     small to see one at a time add up. As well as that count, the proof is refused
 *     (decodedWsSuspect) when any decoded base64 or hex segment, in any alignment, depth or
 *     joined group, holds a whitespace run longer than MAX_DECODED_WS_SEGMENT (8 bytes), or the
 *     whole file carries more than MAX_DECODED_WS_BURST_BYTES (64) bytes in decoded whitespace
 *     runs of WS_BURST_MIN (4) or more, or more than MAX_PERCENT_WS (8) whitespace percent
 *     escapes (lone ones included). The file-level budgets do not depend on the shortest segment
 *     gitleaks decodes. Real encoded data is near random and carries almost none (see the
 *     arithmetic at those constants). matchbound.test.ts bounds every rule of the analyzed config under
 *     these caps (maxMatchBytes in matchbound.ts) and checks that each bound is at most
 *     OVERLAP_BYTES. Lines this short also keep every window cut on a line boundary.
 *  3. The rules with no such bound (a `[^"]{3,}` or `[\s\S-]{64,}?` that runs on across lines) all
 *     start with a fixed word, in GATES. matchbound.test.ts checks that each unbounded rule is
 *     listed there and starts with its word. If the word is not in the file, the rule cannot match
 *     the file's text at all.
 *  4. gitleaks also decodes base64, hex and percent-encoded segments (--max-decode-depth, default
 *     5) and runs the rules on the decoded text, so a gate word may only appear after decoding.
 *     measureText therefore also searches every line's decoded forms for the gate words, to the
 *     same depth: each base64 run at all four alignments, each hex run at both, percent escapes in
 *     place, with a few characters of context on each side (a word half raw, half decoded).
 *     Segments that touch (only `=` padding or percent escapes between them), which gitleaks
 *     decodes in the same pass, are also searched joined; a group of more than
 *     MAX_JOINED_SEGMENTS gives no proof. Its
 *     minimum run lengths are shorter than gitleaks' own, which only decodes more. A line too long
 *     to search (over PROOF_CAPS.line, which fails the proof anyway) or a decode budget that runs
 *     out gives no proof.
 *
 * Known gap, the same one every file over 100 KB has whether flagged or not: a match stitched
 * together from decoded text on several lines. A segment is on one line, and windows hold whole
 * lines, so a match inside the decoded text of one line is found; one spanning lines is not
 * covered by this proof.
 *
 * The proof is only applied to file classes that are generated data (WINDOW_PROOF_NAMES and SVG
 * files); hand-written source keeps the stricter rule that any chunk-split-risk fails closed.
 */
export const PROOF_CAPS = { line: 4096, ws: 256 } as const;

export interface Gate {
  /** The fixed text every match of these rules starts with. */
  word: string;
  /** The rule regex is case-insensitive at that word, so the search must be too. */
  caseInsensitive: boolean;
  /** Rule ids it covers, checked by matchbound.test.ts. */
  rules: readonly string[];
  /** The regex prefix that proves it, checked by matchbound.test.ts. */
  prefix: string;
}

export const GATES: readonly Gate[] = [
  {
    word: 'private',
    caseInsensitive: true,
    rules: ['private-key'],
    prefix: '(?i)-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY',
  },
  {
    word: 'curl',
    caseInsensitive: false,
    rules: ['curl-auth-header', 'curl-auth-user'],
    prefix: '\\bcurl\\b',
  },
  { word: 'ZXlK', caseInsensitive: false, rules: ['jwt-base64'], prefix: '\\bZXlK' },
];

/** sha256 of the vendored gitleaks.toml, CRLF turned into LF. Change it only with the analysis. */
export const ANALYZED_GITLEAKS_CONFIG_SHA256 =
  'c5e9c1aeab014b8e1c85d0b1c9979b8399cd9c7c42fade18e329dd7a1e494114';

/** Lockfile names (exact) whose chunk-split-risk the windows pass may prove away. */
export const WINDOW_PROOF_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

/** Generated data the proof applies to: the lockfiles above and SVG files. */
export function inWindowProofClass(fileName: string): boolean {
  return WINDOW_PROOF_NAMES.has(fileName) || extname(fileName).toLowerCase() === '.svg';
}

export function configSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * The host file the gitleaks container loads as its config, read from the invocation itself: the
 * single `--config` argument, resolved through the mount that holds it. This is the file the
 * proof hashes, so the hash and the scan can never look at two different files. Undefined (no
 * proof) when there is no single `--config`, it is under no mount, or its path leaves the mount.
 */
export function mountedConfigFile(
  inv: Pick<ToolInvocation, 'args' | 'mounts'>,
): string | undefined {
  const at = inv.args.flatMap((a, k) => (a === '--config' ? [k] : []));
  if (at.length !== 1) return undefined;
  const target = inv.args[(at[0] as number) + 1];
  if (target === undefined || !target.startsWith('/')) return undefined;
  const parts = target.split('/').slice(1);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return undefined;
  let best: { hostPath: string; depth: number } | undefined;
  for (const m of inv.mounts) {
    const base = m.containerPath
      .split('/')
      .slice(1)
      .filter((p) => p !== '');
    if (base.length >= parts.length || base.some((p, k) => parts[k] !== p)) continue;
    if (best === undefined || base.length > best.depth) {
      best = { hostPath: m.hostPath, depth: base.length };
    }
  }
  if (best === undefined) return undefined;
  return join(best.hostPath, ...parts.slice(best.depth));
}

/** True when `hostFile` (see mountedConfigFile) is the analyzed config. Missing or unreadable means no. */
export async function usesAnalyzedConfig(hostFile: string | undefined): Promise<boolean> {
  if (hostFile === undefined) return false;
  try {
    const text = await readFile(hostFile, 'utf8');
    return configSha256(text) === ANALYZED_GITLEAKS_CONFIG_SHA256;
  } catch {
    return false;
  }
}

export interface TextStats {
  /** Longest line in bytes, newline not counted. */
  maxLine: number;
  /**
   * Longest run of bytes from tab, newline, vertical tab, form feed, carriage return, space, in
   * the raw bytes or in any decoded view of a line (base64, hex, percent, to DECODE_DEPTH).
   */
  maxWs: number;
  /** Gate words found in the file, in its raw bytes or in the decoded text of a line. */
  gates: string[];
  /**
   * True when some line was not searched in decoded form: it was longer than PROOF_CAPS.line, or
   * the decode budget ran out. No proof then.
   */
  decodeIncomplete: boolean;
  /**
   * True when the decoded text of the file carries too much whitespace: a decoded segment holds a
   * run longer than MAX_DECODED_WS_SEGMENT, or decodedWsBytes is over MAX_DECODED_WS_BURST_BYTES,
   * or percentWsBytes is over MAX_PERCENT_WS. No proof then.
   */
  decodedWsSuspect: boolean;
  /** Bytes in whitespace runs of WS_BURST_MIN or more inside decoded views, all lines together. */
  decodedWsBytes: number;
  /** Whitespace escapes (%09, %0a to %0d, %20) found in the text of any view, all lines together. */
  percentWsBytes: number;
}

/**
 * The longest whitespace run one decoded segment may hold before the file gets no proof. gitleaks
 * replaces every decoded segment of a line in one pass, and a newline is whitespace too, so
 * whitespace-only segments that sit side by side (split by raw spaces or newlines, or by padding)
 * read as one long run that no per-segment count sees. Rather than model that exactly, the proof
 * refuses any file with such a segment. Lockfile integrity hashes, SVG data and other real
 * encoded data decode to near-random bytes, where 6 of 256 byte values are whitespace, so a run of
 * 9 has odds near (6/256)^9, about 3e-15, per position: a whitespace-only run this long is not
 * benign. The shortest segment gitleaks decodes (16 base64 characters, 12 bytes) can be all
 * whitespace, so a threshold under 12 sees every such segment. This is in addition to the
 * PROOF_CAPS.ws count, which stays.
 */
export const MAX_DECODED_WS_SEGMENT = 8;

/**
 * File-level budgets. The per-segment limit above sees one segment at a time, but gitleaks decodes
 * the whole fragment and a newline is whitespace, so many small whitespace pieces on many lines
 * (a lone %20 per line, short hex segments split by raw spaces) read as one long run. These
 * budgets count the pieces across the file instead, so they hold whatever the shortest segment
 * gitleaks decodes (the hex minimum is not relied on).
 *
 * Bursts: decoded bytes inside whitespace runs of at least WS_BURST_MIN (4) are summed over the
 * whole file, every decoded view counted. A run of 4 has odds (6/256)^4, about 3e-7, per decoded
 * byte in near-random data, so a lockfile with N decoded bytes carries about 4 * 3e-7 * N burst
 * bytes: about 1 for 1 MB. Budget 64 leaves wide room for real files. A chain of more than 256
 * whitespace bytes made of distinct pieces of at least 4 bytes each (assumed: gitleaks decodes
 * nothing shorter than 8 hex or 16 base64 characters, 4 and 12 bytes; its real hex minimum was not
 * verified) spends more than 64 when each piece is counted once. KNOWN GAP: it is not counted once
 * per occurrence. The `seen` set in searchDecoded dedupes a decoded text per line at depth 1 or
 * deeper, so about 17 copies of one nested segment on a line count once, and the raw neighbours of a
 * nested segment are only 6 characters wide. A review built files that this rule still proves while
 * a simulated gitleaks decode shows a whitespace run over OVERLAP_BYTES (a four-line pnpm-lock.yaml
 * of about 16 KB, and a ten-line hex one of about 37 KB). Pieces of 1 to 3 bytes cannot be decoded
 * as segments (assumed), and a lone percent escape is bounded by the next budget.
 *
 * Percent: whitespace escapes are summed over the whole file, lone ones included. Real lockfile and
 * SVG text escapes `/`, `@`, `=` and similar and almost never a space or newline, so 8 per file is
 * a tiny budget; a file with more is not given a proof (an SVG with an inlined data URI, say, which
 * is only less provable, never wrong).
 */
export const WS_BURST_MIN = 4;
export const MAX_DECODED_WS_BURST_BYTES = 64;
export const MAX_PERCENT_WS = 8;

export interface MeasureOptions {
  /** Most decoded bytes produced for one file before the search gives up (no proof). */
  decodeBudgetBytes?: number;
  /** Wall-clock milliseconds for the decoded search of one file; past it, no proof. */
  maxMillis?: number;
}

const DEFAULT_MAX_MILLIS = 2_000;

const READ_BYTES = 64 * 1024;
/** gitleaks' default --max-decode-depth, which the invocation does not change. */
export const DECODE_DEPTH = 5;
const DEFAULT_DECODE_BUDGET = 64 * 1024 * 1024;
const isWs = (b: number): boolean => b === 0x20 || (b >= 0x09 && b <= 0x0d);
const LONGEST_GATE = Math.max(...GATES.map((g) => g.word.length));
/** Text kept on each side of a decoded segment, so a word half raw and half decoded is found. */
const CONTEXT = LONGEST_GATE - 1;
// Shorter minimums than gitleaks' own (more segments decoded is only more conservative). A run of
// the base64 alphabets (standard and URL-safe) or of hex digits; Node decodes both alphabets.
const B64_RUN = /[A-Za-z0-9+/_-]{6,}/g;
const HEX_RUN = /[0-9A-Fa-f]{8,}/g;
const PCT = /%[0-9A-Fa-f]{2}/g;

function gatesIn(text: string, found: Set<string>): void {
  let lower: string | undefined;
  for (const g of GATES) {
    if (found.has(g.word)) continue;
    if (g.caseInsensitive) {
      lower ??= text.toLowerCase();
      if (lower.includes(g.word.toLowerCase())) found.add(g.word);
    } else if (text.includes(g.word)) found.add(g.word);
  }
}

/** Most base64 or hex runs in one joined group (see `decodings`); more gives no proof. */
export const MAX_JOINED_SEGMENTS = 8;
const pctDecode = (s: string): string =>
  s.replace(PCT, (h) => String.fromCharCode(parseInt(h.slice(1), 16)));
const b64Decode = (s: string): string => Buffer.from(s, 'base64').toString('latin1');
const hexDecode = (s: string): string =>
  Buffer.from(s.slice(0, s.length & ~1), 'hex').toString('latin1');
/** Tokens that can touch in one gitleaks pass: alphabet runs (any length), `=` padding, `%XX`. */
const TOKEN = /[A-Za-z0-9+/_-]+|=+|%[0-9A-Fa-f]{2}/g;
const IS_HEX = /^[0-9A-Fa-f]+$/;
/** gitleaks' shortest base64 segment; shorter runs stay raw in its pass. */
const GITLEAKS_MIN_B64 = 16;
type JoinMode = 'b64' | 'hex' | 'gitleaks-min' | 'drop-pct';

/** One joined reading of a group of touching tokens. */
function joinGroup(group: readonly RegExpExecArray[], mode: JoinMode): string {
  let out = '';
  for (const m of group) {
    const t = m[0];
    if (t.startsWith('=')) continue;
    if (t.startsWith('%')) {
      if (mode !== 'drop-pct') out += pctDecode(t);
      continue;
    }
    if (t.length < 6 || (mode === 'gitleaks-min' && t.length < GITLEAKS_MIN_B64)) out += t;
    else if (mode === 'hex' && IS_HEX.test(t)) out += hexDecode(t);
    else out += b64Decode(t);
  }
  return out;
}

/**
 * Every decoding gitleaks could make of a segment of `text`, each with CONTEXT characters of the
 * text around it. Base64 runs are decoded at all four alignments (gitleaks' segment may start
 * anywhere in a longer run) and hex runs at both; percent escapes are decoded in place.
 *
 * gitleaks replaces every segment of a line in one pass, whatever its encoding, so tokens that
 * touch (alphabet runs of any length, `=` padding and `%XX` escapes with nothing between them)
 * also decode to one text. Each such group is searched joined, in order, several ways: every run
 * of 6 or more as base64; hex runs as hex and the rest as base64; runs shorter than gitleaks'
 * 16-character minimum left raw; percent escapes decoded or dropped; and the whole group as one
 * base64 run with padding and escapes stripped. Shorter runs stay raw in every reading. The join
 * is searched again to DECODE_DEPTH like any decoding. Tokens that do not touch need no join: the
 * text between them is raw and holds no letter of the alphabet, so no gate word and no new
 * segment can cross it. A group of more than MAX_JOINED_SEGMENTS runs returns undefined (no
 * proof), which also bounds the work.
 */
interface WsSink {
  /** One decoded segment: its longest run with raw neighbours, on its own, and its burst bytes. */
  segment(withNeighbours: number, own: number, burstBytes: number): void;
  /** Whitespace escapes found in the text being decoded. */
  percent(count: number): void;
}

const PCT_WS = /%(?:09|0[a-d]|20)/gi;
/** Bytes inside whitespace runs of WS_BURST_MIN or more. */
function wsBurstBytes(decoded: string): number {
  let total = 0;
  let run = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (isWsChar(decoded.charAt(i))) run++;
    else {
      if (run >= WS_BURST_MIN) total += run;
      run = 0;
    }
  }
  return run >= WS_BURST_MIN ? total + run : total;
}

function decodings(text: string, sink: WsSink): string[] | undefined {
  sink.percent((text.match(PCT_WS) ?? []).length);
  const out = new Set<string>();
  const around = (start: number, end: number, decoded: string): void => {
    sink.segment(
      wsRunWithNeighbours(decoded, rawWsBefore(text, start), rawWsAfter(text, end)),
      wsRunWithNeighbours(decoded, 0, 0),
      wsBurstBytes(decoded),
    );
    out.add(
      text.slice(Math.max(0, start - CONTEXT), start) + decoded + text.slice(end, end + CONTEXT),
    );
  };
  const tokens = [...text.matchAll(TOKEN)];
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j + 1 < tokens.length) {
      const cur = tokens[j] as RegExpExecArray;
      if ((tokens[j + 1] as RegExpExecArray).index !== cur.index + cur[0].length) break;
      j++;
    }
    if (j > i) {
      const group = tokens.slice(i, j + 1);
      const runs = group.filter((m) => m[0].length >= 6 && !/^[=%]/.test(m[0])).length;
      const pcts = group.filter((m) => m[0].startsWith('%')).length;
      if (runs > MAX_JOINED_SEGMENTS) return undefined;
      if (runs + pcts >= 1) {
        const first = group[0] as RegExpExecArray;
        const lastTok = group[group.length - 1] as RegExpExecArray;
        const start = first.index;
        const end = lastTok.index + lastTok[0].length;
        for (const mode of ['b64', 'hex', 'gitleaks-min', 'drop-pct'] as const) {
          around(start, end, joinGroup(group, mode));
        }
        const whole = text.slice(start, end);
        around(start, end, b64Decode(whole.replace(/=|%[0-9A-Fa-f]{2}/g, '')));
        around(start, end, b64Decode(pctDecode(whole).replace(/=/g, '')));
      }
    }
    i = j + 1;
  }
  const runs = [...text.matchAll(B64_RUN)];
  for (const m of runs) {
    for (let off = 0; off < 4 && m[0].length - off >= 6; off++) {
      const start = m.index + off;
      around(
        start,
        m.index + m[0].length,
        Buffer.from(m[0].slice(off), 'base64').toString('latin1'),
      );
    }
  }
  for (const m of text.matchAll(HEX_RUN)) {
    for (let off = 0; off < 2; off++) {
      const seg = m[0].slice(off, off + ((m[0].length - off) & ~1));
      around(m.index + off, m.index + m[0].length, Buffer.from(seg, 'hex').toString('latin1'));
    }
  }
  const pct = pctDecode(text);
  if (pct !== text) {
    // the whole line with every escape decoded: only the 256 cap applies (raw spaces are in it)
    sink.segment(wsRunWithNeighbours(pct, 0, 0), 0, 0);
    out.add(pct);
  }
  return [...out];
}

const isWsChar = (c: string): boolean => isWs(c.charCodeAt(0));
/** Whitespace characters directly before `end` in `text`. */
function rawWsBefore(text: string, end: number): number {
  let n = 0;
  while (n < end && isWsChar(text.charAt(end - 1 - n))) n++;
  return n;
}
/** Whitespace characters from `start` on in `text`. */
function rawWsAfter(text: string, start: number): number {
  let n = 0;
  while (start + n < text.length && isWsChar(text.charAt(start + n))) n++;
  return n;
}
/**
 * Longest whitespace run of a decoded segment as gitleaks reads its line: a run touching either
 * end of the segment continues into the raw whitespace next to it (`before`, `after`).
 */
function wsRunWithNeighbours(decoded: string, before: number, after: number): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < decoded.length; i++) {
    run = isWsChar(decoded.charAt(i)) ? run + 1 : 0;
    const total = run + (run === i + 1 ? before : 0) + (i === decoded.length - 1 ? after : 0);
    if (total > best) best = total;
  }
  return best;
}

/** Searches the decoded forms of one line, recursively to DECODE_DEPTH. False when out of budget. */
function searchDecoded(text: string, depth: number, found: Set<string>, budget: Budget): boolean {
  if (depth === 0 || found.size === GATES.length) return true;
  if (Date.now() >= budget.deadline) return false;
  const all = decodings(text, {
    segment(run, own, burst) {
      if (run > budget.maxWs) budget.maxWs = run;
      if (own > MAX_DECODED_WS_SEGMENT) budget.wsSuspect = true;
      budget.burstBytes += burst;
    },
    percent(count) {
      budget.percentWs += count;
    },
  });
  if (all === undefined) return false;
  for (const d of all) {
    // A text already searched to at least this depth adds nothing (the same text recurs often:
    // every alignment and join of a short segment decodes to the same few strings).
    const key = `${depth}\u0000${d}`;
    if (budget.seen.has(key)) continue;
    budget.left -= d.length;
    if (budget.left < 0) return false;
    budget.seen.add(key);
    gatesIn(d, found);
    if (!searchDecoded(d, depth - 1, found, budget)) return false;
  }
  return true;
}

interface Budget {
  /** Decoded bytes left for this file. */
  left: number;
  /** Date.now() after which the search gives up (no proof). */
  deadline: number;
  /** Texts already searched, with the depth left, for this line. */
  seen: Set<string>;
  /** Longest whitespace run in any decoded view of any line (see wsRunWithNeighbours). */
  maxWs: number;
  /** Some decoded segment holds a whitespace run over MAX_DECODED_WS_SEGMENT. */
  wsSuspect: boolean;
  /** Bytes in whitespace bursts of decoded views, all lines. */
  burstBytes: number;
  /** Whitespace escapes seen, all lines. */
  percentWs: number;
}

/** Streams a file once and measures what the proof needs. Bounded memory. */
export async function measureText(path: string, opts: MeasureOptions = {}): Promise<TextStats> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(READ_BYTES);
    let line = 0;
    let maxLine = 0;
    let ws = 0;
    let maxWs = 0;
    let carry = '';
    const found = new Set<string>();
    const budget: Budget = {
      left: opts.decodeBudgetBytes ?? DEFAULT_DECODE_BUDGET,
      deadline: Date.now() + (opts.maxMillis ?? DEFAULT_MAX_MILLIS),
      seen: new Set(),
      maxWs: 0,
      wsSuspect: false,
      burstBytes: 0,
      percentWs: 0,
    };
    let decodeIncomplete = false;
    // the current line, kept up to PROOF_CAPS.line bytes for the decoded search
    const lineBuf = Buffer.alloc(PROOF_CAPS.line);
    let lineLen = 0;
    let lineTooLong = false;
    const endLine = (): void => {
      if (lineTooLong) decodeIncomplete = true;
      else if (!decodeIncomplete && lineLen > 0) {
        const text = lineBuf.toString('latin1', 0, lineLen);
        budget.seen.clear();
        if (!searchDecoded(text, DECODE_DEPTH, found, budget)) decodeIncomplete = true;
      }
      lineLen = 0;
      lineTooLong = false;
    };
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_BYTES, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      for (const b of chunk) {
        if (b === 0x0a) {
          line = 0;
          endLine();
        } else {
          if (++line > maxLine) maxLine = line;
          if (lineLen < lineBuf.length) lineBuf[lineLen++] = b;
          else lineTooLong = true;
        }
        if (isWs(b)) {
          if (++ws > maxWs) maxWs = ws;
        } else ws = 0;
      }
      // latin1 keeps one character per byte, so a word split across reads is found via the carry
      const text = carry + chunk.toString('latin1');
      gatesIn(text, found);
      carry = text.slice(-(LONGEST_GATE - 1));
    }
    endLine();
    // the decoded views count too: gitleaks runs its rules on them (PROOF_CAPS.ws applies to both)
    return {
      maxLine,
      maxWs: Math.max(maxWs, budget.maxWs),
      gates: [...found].sort(),
      decodeIncomplete,
      decodedWsSuspect:
        budget.wsSuspect ||
        budget.burstBytes > MAX_DECODED_WS_BURST_BYTES ||
        budget.percentWs > MAX_PERCENT_WS,
      decodedWsBytes: budget.burstBytes,
      percentWsBytes: budget.percentWs,
    };
  } finally {
    await fh.close();
  }
}

/** True when no rule of the analyzed config can have a match longer than the window overlap. */
export function statsProveCoverage(s: TextStats): boolean {
  return (
    s.maxLine <= PROOF_CAPS.line &&
    s.maxWs <= PROOF_CAPS.ws &&
    s.gates.length === 0 &&
    !s.decodeIncomplete &&
    !s.decodedWsSuspect
  );
}
