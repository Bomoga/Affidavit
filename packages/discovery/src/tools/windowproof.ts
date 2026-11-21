import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { repoRoot } from './manifest.js';

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
 *     checked by its sha256 (ANALYZED_GITLEAKS_CONFIG_SHA256, line endings normalized). Any other
 *     config gets no proof.
 *  2. The file's longest line is at most PROOF_CAPS.line bytes and its longest whitespace run at
 *     most PROOF_CAPS.ws bytes. matchbound.test.ts bounds every rule of the analyzed config under
 *     these caps (maxMatchBytes in matchbound.ts) and checks that each bound is at most
 *     OVERLAP_BYTES. Lines this short also keep every window cut on a line boundary.
 *  3. The rules with no such bound (a `[^"]{3,}` or `[\s\S-]{64,}?` that runs on across lines) all
 *     start with a fixed word, in GATES. matchbound.test.ts checks that each unbounded rule is
 *     listed there and starts with its word. If the word is not in the file, the rule cannot match
 *     the file's text at all.
 *
 * Known gap, the same one every file over 100 KB has whether flagged or not: gitleaks also decodes
 * base64, hex and percent-encoded segments (--max-decode-depth, default 5) and runs the rules on
 * the decoded text. A segment is on one line, and windows hold whole lines, so a match inside the
 * decoded text of one line is found. A match stitched together from decoded text on several lines
 * is not covered by this proof.
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

/** True when the gitleaks config a run uses is the analyzed one. Unreadable means no. */
export async function usesAnalyzedConfig(
  configDir: string | undefined,
  configFile: string | undefined,
): Promise<boolean> {
  const dir = configDir ?? join(repoRoot(), 'docker', 'tools', 'config');
  try {
    const text = await readFile(join(dir, configFile ?? 'gitleaks.toml'), 'utf8');
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
  /** Gate words found in the file. */
  gates: string[];
}

const READ_BYTES = 64 * 1024;
const isWs = (b: number): boolean => b === 0x20 || (b >= 0x09 && b <= 0x0d);

/** Streams a file once and measures what the proof needs. Bounded memory. */
export async function measureText(path: string): Promise<TextStats> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(READ_BYTES);
    let line = 0;
    let maxLine = 0;
    let ws = 0;
    let maxWs = 0;
    const longest = Math.max(...GATES.map((g) => g.word.length));
    let carry = '';
    const found = new Set<string>();
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_BYTES, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      for (const b of chunk) {
        if (b === 0x0a) line = 0;
        else if (++line > maxLine) maxLine = line;
        if (isWs(b)) {
          if (++ws > maxWs) maxWs = ws;
        } else ws = 0;
      }
      // latin1 keeps one character per byte, so a word split across reads is found via the carry
      const text = carry + chunk.toString('latin1');
      for (const g of GATES) {
        if (found.has(g.word)) continue;
        const hay = g.caseInsensitive ? text.toLowerCase() : text;
        if (hay.includes(g.caseInsensitive ? g.word.toLowerCase() : g.word)) found.add(g.word);
      }
      carry = text.slice(-(longest - 1));
    }
    return { maxLine, maxWs, gates: [...found].sort() };
  } finally {
    await fh.close();
  }
}

/** True when no rule of the analyzed config can have a match longer than the window overlap. */
export function statsProveCoverage(s: TextStats): boolean {
  return s.maxLine <= PROOF_CAPS.line && s.maxWs <= PROOF_CAPS.ws && s.gates.length === 0;
}
