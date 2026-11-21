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
 *     most PROOF_CAPS.ws bytes. matchbound.test.ts bounds every rule of the analyzed config under
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
  /** Longest run of bytes from tab, newline, vertical tab, form feed, carriage return, space. */
  maxWs: number;
  /** Gate words found in the file, in its raw bytes or in the decoded text of a line. */
  gates: string[];
  /**
   * True when some line was not searched in decoded form: it was longer than PROOF_CAPS.line, or
   * the decode budget ran out. No proof then.
   */
  decodeIncomplete: boolean;
}

export interface MeasureOptions {
  /** Most decoded bytes produced for one file before the search gives up (no proof). */
  decodeBudgetBytes?: number;
}

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

/** Most segments in one joined group (see `decodings`); more gives no proof. */
export const MAX_JOINED_SEGMENTS = 8;
/** Text between two segments that gitleaks can consume or decode in the same pass. */
const JOIN_GAP = /^(?:=|%[0-9A-Fa-f]{2})*$/;
const pctDecode = (s: string): string =>
  s.replace(PCT, (h) => String.fromCharCode(parseInt(h.slice(1), 16)));
const b64Decode = (s: string): string => Buffer.from(s, 'base64').toString('latin1');

/**
 * Every decoding gitleaks could make of a segment of `text`, each with CONTEXT characters of the
 * text around it. Base64 runs are decoded at all four alignments (gitleaks' segment may start
 * anywhere in a longer run) and hex runs at both; percent escapes are decoded in place.
 *
 * gitleaks replaces every segment of a line in one pass, so segments that touch (only `=` padding
 * or percent escapes between them) also decode to one text. Such a group is searched joined three
 * ways: each segment decoded from its start with the gap between decoded too, the decoded
 * segments with nothing between them, and the whole group as one base64 run with the padding
 * stripped. Separate segments need no join: the text between them is raw and holds no letter of
 * the alphabet, so no gate word and no new segment can cross it. A group of more than
 * MAX_JOINED_SEGMENTS segments returns undefined (no proof), which also bounds the work.
 */
function decodings(text: string): string[] | undefined {
  const out = new Set<string>();
  const around = (start: number, end: number, decoded: string): void => {
    out.add(
      text.slice(Math.max(0, start - CONTEXT), start) + decoded + text.slice(end, end + CONTEXT),
    );
  };
  const runs = [...text.matchAll(B64_RUN)];
  for (let i = 0; i < runs.length;) {
    let j = i;
    while (j + 1 < runs.length) {
      const cur = runs[j] as RegExpExecArray;
      const next = runs[j + 1] as RegExpExecArray;
      if (!JOIN_GAP.test(text.slice(cur.index + cur[0].length, next.index))) break;
      j++;
    }
    if (j > i) {
      if (j - i + 1 > MAX_JOINED_SEGMENTS) return undefined;
      const group = runs.slice(i, j + 1);
      const first = group[0] as RegExpExecArray;
      const lastRun = group[group.length - 1] as RegExpExecArray;
      const start = first.index;
      const end = lastRun.index + lastRun[0].length;
      let withGaps = '';
      let bare = '';
      group.forEach((m, k) => {
        const d = b64Decode(m[0]);
        bare += d;
        withGaps += d;
        const next = group[k + 1];
        if (next) withGaps += pctDecode(text.slice(m.index + m[0].length, next.index));
      });
      around(start, end, withGaps);
      around(start, end, bare);
      const whole = text.slice(start, end);
      around(start, end, b64Decode(whole.replace(/=|%[0-9A-Fa-f]{2}/g, '')));
      around(start, end, b64Decode(pctDecode(whole).replace(/=/g, '')));
    }
    i = j + 1;
  }
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
  if (pct !== text) out.add(pct);
  return [...out];
}

/** Searches the decoded forms of one line, recursively to DECODE_DEPTH. False when out of budget. */
function searchDecoded(
  text: string,
  depth: number,
  found: Set<string>,
  budget: { left: number },
): boolean {
  if (depth === 0 || found.size === GATES.length) return true;
  const all = decodings(text);
  if (all === undefined) return false;
  for (const d of all) {
    budget.left -= d.length;
    if (budget.left < 0) return false;
    gatesIn(d, found);
    if (!searchDecoded(d, depth - 1, found, budget)) return false;
  }
  return true;
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
    const budget = { left: opts.decodeBudgetBytes ?? DEFAULT_DECODE_BUDGET };
    let decodeIncomplete = false;
    // the current line, kept up to PROOF_CAPS.line bytes for the decoded search
    const lineBuf = Buffer.alloc(PROOF_CAPS.line);
    let lineLen = 0;
    let lineTooLong = false;
    const endLine = (): void => {
      if (lineTooLong) decodeIncomplete = true;
      else if (!decodeIncomplete && lineLen > 0) {
        const text = lineBuf.toString('latin1', 0, lineLen);
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
    return { maxLine, maxWs, gates: [...found].sort(), decodeIncomplete };
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
    !s.decodeIncomplete
  );
}
