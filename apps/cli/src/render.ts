/* eslint-disable no-control-regex -- matching escape and control characters is the point of this file */
import type { TrialEvent } from '@affidavit/contracts';

/**
 * Terminal rendering. Every string that came from a case, a repo, a model or a tool is untrusted:
 * it can carry ANSI escapes that rewrite the screen, set the window title or hide text, control
 * characters, or bidirectional overrides that reorder what the reader sees. `sanitize` is the
 * only way text reaches the terminal from here.
 */

/** Longest single field, and longest whole line, in characters. */
export const MAX_FIELD = 160;
export const MAX_LINE = 240;

// OSC (ESC ] ... BEL or ST), DCS/SOS/PM/APC strings (ESC P, X, ^, _ ... ST), CSI (ESC [ ...), and
// any other two-character escape. Applied before the control strip so a sequence is removed whole.
const OSC = /\u001b\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/gu;
const STRING = /\u001b[PX^_][^\u001b\u009c]*(?:\u001b\\|\u009c)?/gu;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/gu;
const ESC_OTHER = /\u001b[ -~]?/gu;
// C0 (including TAB, CR, LF and ESC), DEL, C1, line and paragraph separators, bidi controls and
// isolates, zero-width characters, byte order mark and other format characters that hide text.
const CONTROL = new RegExp(
  '[' +
    [
      [0x00, 0x1f],
      [0x7f, 0x9f],
      [0xad, 0xad],
      [0x61c, 0x61c],
      [0x180e, 0x180e],
      [0x200b, 0x200f],
      [0x2028, 0x202e],
      [0x2060, 0x206f],
      [0xfeff, 0xfeff],
      [0xfff9, 0xfffb],
      // Hangul and halfwidth fillers render as blanks; tag characters are invisible.
      [0x115f, 0x115f],
      [0x3164, 0x3164],
      [0xffa0, 0xffa0],
      [0xe0000, 0xe007f],
    ]
      .map(([lo, hi]) => String.fromCodePoint(lo!) + '-' + String.fromCodePoint(hi!))
      .join('') +
    ']',
  'gu',
);

const LONE_SURROGATE = new RegExp(
  '[' +
    String.fromCharCode(0xd800) +
    '-' +
    String.fromCharCode(0xdbff) +
    ']' +
    '(?![' +
    String.fromCharCode(0xdc00) +
    '-' +
    String.fromCharCode(0xdfff) +
    '])' +
    '|(?<![' +
    String.fromCharCode(0xd800) +
    '-' +
    String.fromCharCode(0xdbff) +
    '])' +
    '[' +
    String.fromCharCode(0xdc00) +
    '-' +
    String.fromCharCode(0xdfff) +
    ']',
  'g',
);

/** Strips escape sequences and control characters, then caps the length. Never throws. */
export function sanitize(input: unknown, max: number = MAX_FIELD): string {
  let s =
    typeof input === 'string'
      ? input
      : typeof input === 'number' || typeof input === 'boolean'
        ? String(input)
        : '';
  s = s.replace(LONE_SURROGATE, String.fromCharCode(0xfffd));
  s = s.replace(OSC, '').replace(STRING, '').replace(CSI, '').replace(ESC_OTHER, '');
  s = s.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
  // Surrogate-safe cut: Array.from splits on code points, not UTF-16 units.
  const points = Array.from(s);
  if (points.length > max) s = points.slice(0, Math.max(0, max - 3)).join('') + '...';
  return s;
}

function detail(event: TrialEvent): string {
  switch (event.type) {
    case 'stage-entered':
      return event.payload.from ? `from ${sanitize(event.payload.from)}` : '';
    case 'stage-exited':
      return `to ${sanitize(event.payload.to)}`;
    case 'exhibit-submitted':
      return `${sanitize(event.payload.exhibitId)} (${sanitize(event.payload.kind)})`;
    case 'exhibit-result': {
      const r = event.payload.result;
      const rejected = r.rejectedBy ? ` rejected by ${sanitize(r.rejectedBy)}` : '';
      return `${sanitize(r.exhibitId)} admissible=${String(r.admissible)}${rejected}`;
    }
    case 'exhibit-inadmissible':
      return `${sanitize(event.payload.exhibitId)} rejected by ${sanitize(event.payload.rejectedBy)}`;
    case 'objection':
      return `${sanitize(event.payload.exhibitId)}: ${sanitize(event.payload.claim)}`;
    case 'appeal':
      return `round ${event.payload.round}, counterexample ${sanitize(event.payload.counterexampleId)}`;
    case 'ballot-cast': {
      const b = event.payload.ballot;
      return `${sanitize(b.jurorId)} on ${sanitize(b.question)}: ${sanitize(b.vote)}`;
    }
    case 'cost-charged': {
      const c = event.payload.cost;
      return `${sanitize(c.stage)} attempt ${c.attempt}, usd ${c.usd}`;
    }
    case 'budget-exhausted':
    case 'escalated':
      return `${sanitize(event.payload.escalation.reason)}: ${sanitize(event.payload.escalation.detail)}`;
    case 'dismissed':
      return `${sanitize(event.payload.dismissal.reason)}: ${sanitize(event.payload.dismissal.detail)}`;
    case 'verdict-written': {
      const v = event.payload.verdict;
      const sev = v.severity ? ` ${sanitize(v.severity)}` : '';
      return `${sanitize(v.outcome)}${sev}: ${sanitize(v.summary)}`;
    }
  }
}

/** One event on one line: seq, stage, actor, type, detail. */
export function renderEvent(event: TrialEvent): string {
  const head = [
    `#${String(event.seq).padStart(3, '0')}`,
    sanitize(event.stage, 16).padEnd(11),
    sanitize(event.actor, 16).padEnd(12),
    sanitize(event.type, 24).padEnd(18),
  ].join(' ');
  return sanitize(`${head} ${detail(event)}`, MAX_LINE).replace(/\s+$/, '');
}

/** A message for a person: sanitized and capped, never multi-line. */
export function renderMessage(message: string): string {
  return sanitize(message, MAX_LINE);
}
