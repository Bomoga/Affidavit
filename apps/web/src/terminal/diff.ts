import type { DiffLine } from './types.js';

/** Most lines the parser returns. The diff is untrusted, so the view never grows without bound. */
export const MAX_DIFF_LINES = 2000;
/** Longest line kept, in characters. Longer lines are cut, never wrapped into new lines. */
export const MAX_DIFF_LINE_LENGTH = 500;
// Input past this many characters is never read: enough for every line at full length.
const MAX_INPUT_CHARS = MAX_DIFF_LINES * (MAX_DIFF_LINE_LENGTH + 2);

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

function clip(line: string): string {
  return line.length > MAX_DIFF_LINE_LENGTH ? line.slice(0, MAX_DIFF_LINE_LENGTH) : line;
}

function toInt(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Reads a unified diff into lines with old and new line numbers. Tolerant: it never throws, keeps
 * lines it does not understand as context without numbers, and caps the line count and length.
 * Each line's `text` is the recorded line as written, marker included, cut to the length cap.
 * `added` and `removed` count the lines returned, so they match what the view shows.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  if (typeof diff !== 'string' || diff.length === 0) return { lines, added, removed };

  const raw = diff.slice(0, MAX_INPUT_CHARS).split(/\r\n|\n|\r/);
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();

  let oldNo = 0;
  let newNo = 0;
  // Lines left in the current hunk, from its header. Zero on both means no hunk is open.
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of raw) {
    if (lines.length >= MAX_DIFF_LINES) break;
    const inHunk = oldLeft > 0 || newLeft > 0;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = toInt(hunk[1], 0);
      oldLeft = toInt(hunk[2], 1);
      newNo = toInt(hunk[3], 0);
      newLeft = toInt(hunk[4], 1);
      lines.push({ kind: 'hunk', text: clip(line) });
      continue;
    }
    if (inHunk) {
      const mark = line.charAt(0);
      if (mark === '+' && newLeft > 0) {
        lines.push({ kind: 'add', newNo, text: clip(line.slice(1)) });
        newNo += 1;
        newLeft -= 1;
        added += 1;
        continue;
      }
      if (mark === '-' && oldLeft > 0) {
        lines.push({ kind: 'del', oldNo, text: clip(line.slice(1)) });
        oldNo += 1;
        oldLeft -= 1;
        removed += 1;
        continue;
      }
      if ((mark === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        lines.push({ kind: 'ctx', oldNo, newNo, text: clip(line.slice(1)) });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (mark === '\\') {
        // "\ No newline at end of file": belongs to the hunk, has no line number.
        lines.push({ kind: 'ctx', text: clip(line) });
        continue;
      }
      // A line that does not fit the hunk's counts closes it; read it as a header line below.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      lines.push({ kind: 'file', text: clip(line) });
      continue;
    }
    // Anything else outside a hunk (index lines, mode lines, garbage) is kept without numbers.
    lines.push({ kind: 'ctx', text: clip(line) });
  }
  return { lines, added, removed };
}
