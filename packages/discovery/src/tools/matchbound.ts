/**
 * An upper bound, in bytes, on the length of any match of a gitleaks (Go RE2) rule regex in a file
 * whose lines and whitespace runs are capped. Used to prove that the windows pass covers a large
 * text file completely: windows overlap by OVERLAP_BYTES, so every stretch of that many bytes lies
 * wholly inside one window, and a rule whose matches cannot be longer is found in some window.
 *
 * The argument, per piece of a regex:
 *  - a piece that cannot match a newline lies on one line, so it is at most `line` bytes long, and
 *    so is any run of such pieces next to each other;
 *  - a piece that matches only whitespace (`\s+`, `[\r\n]{1,2}`, `[ \t]*`) is at most `ws` bytes
 *    long, and so is a run of such pieces;
 *  - a piece that can match a newline and repeats without a bound (`[^"]{3,}`, `(?s:.)*`,
 *    `[\s\S]+`) has no bound at all;
 *  - otherwise lengths add up (sequences), take the larger (alternatives) or multiply (bounded
 *    repeats). A character counts as its UTF-8 length. Under the `i` flag, a k or K (and any
 *    class or `\w` holding one) counts as 3 bytes and an s or S as 2, since Go folds them to
 *    U+212A and U+017F; a non-ASCII character counts as 4.
 *
 * Anything this parser does not understand throws, so a config change that brings in new syntax
 * fails the test that runs it instead of being bounded wrongly.
 */
export interface MatchCaps {
  /** Longest line in the file, in bytes, newline not counted. */
  line: number;
  /** Longest run of whitespace bytes (space, tab, newline, carriage return, form feed, vertical tab). */
  ws: number;
}

interface Bound {
  /** Can match a newline. */
  nl: boolean;
  /** Matches only whitespace (or nothing). */
  ws: boolean;
  /** Longest match in bytes. Infinity when unbounded. */
  max: number;
}

export class MatchBoundSyntaxError extends Error {
  constructor(pattern: string, at: number, why: string) {
    super(`cannot bound regex at ${at} (${why}): ${pattern.slice(0, 120)}`);
    this.name = 'MatchBoundSyntaxError';
  }
}

const ZERO: Bound = { nl: false, ws: true, max: 0 };
const WS_CODES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

const utf8Bytes = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
const covers = (lo: number, hi: number, ...cps: number[]): boolean =>
  cps.some((cp) => lo <= cp && cp <= hi);

/**
 * Longest UTF-8 encoding of a character in [lo, hi] or of anything it folds to. Under the `i`
 * flag Go (RE2) folds k and K to U+212A KELVIN SIGN (3 bytes) and s and S to U+017F LATIN SMALL
 * LETTER LONG S (2 bytes); these are the only ASCII letters with a non-ASCII fold. A non-ASCII
 * character under the flag counts as 4 bytes, an upper bound for any fold.
 */
function rangeBytes(lo: number, hi: number, fold: boolean): number {
  let max = utf8Bytes(hi);
  if (!fold) return max;
  if (hi >= 0x80) return 4;
  if (covers(lo, hi, 0x4b, 0x6b)) max = Math.max(max, 3);
  if (covers(lo, hi, 0x53, 0x73)) max = Math.max(max, 2);
  return max;
}

function charBound(cp: number, fold = false): Bound {
  return { nl: cp === 0x0a, ws: WS_CODES.has(cp), max: rangeBytes(cp, cp, fold) };
}

/** Escapes that stand for a set of characters, outside or inside a class. */
const CLASS_ESCAPES: Record<string, Bound> = {
  s: { nl: true, ws: true, max: 1 },
  S: { nl: false, ws: false, max: 4 },
  d: { nl: false, ws: false, max: 1 },
  D: { nl: true, ws: false, max: 4 },
  w: { nl: false, ws: false, max: 1 },
  W: { nl: true, ws: false, max: 4 },
};
/** A class escape under the `i` flag: `\w` holds k and s, so it also matches U+212A and U+017F. */
function classEscape(c: string, fold: boolean): Bound {
  const b = CLASS_ESCAPES[c] as Bound;
  return fold && c === 'w' ? { ...b, max: 3 } : b;
}
/** POSIX classes holding k (folded to U+212A, 3 bytes, under the `i` flag). */
const POSIX_WITH_K = new Set([
  'alnum',
  'alpha',
  'lower',
  'upper',
  'word',
  'graph',
  'print',
  'ascii',
]);
const CONTROL_ESCAPES: Record<string, number> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  f: 0x0c,
  v: 0x0b,
  a: 0x07,
};
const POSIX: Record<string, { nl: boolean; ws: boolean }> = {
  alnum: { nl: false, ws: false },
  alpha: { nl: false, ws: false },
  digit: { nl: false, ws: false },
  lower: { nl: false, ws: false },
  upper: { nl: false, ws: false },
  word: { nl: false, ws: false },
  xdigit: { nl: false, ws: false },
  punct: { nl: false, ws: false },
  graph: { nl: false, ws: false },
  print: { nl: false, ws: false },
  blank: { nl: false, ws: true },
  space: { nl: true, ws: true },
  cntrl: { nl: true, ws: false },
  ascii: { nl: true, ws: false },
};

function combineRepeat(c: Bound, min: number, max: number, caps: MatchCaps): Bound {
  void min;
  if (c.max === 0) return ZERO;
  const total = max === Number.POSITIVE_INFINITY ? max : max * c.max;
  if (!c.nl) {
    return { nl: false, ws: c.ws, max: Math.min(total, caps.line, c.ws ? caps.ws : caps.line) };
  }
  if (c.ws) return { nl: true, ws: true, max: Math.min(total, caps.ws) };
  return { nl: true, ws: false, max: total };
}

function combineSeq(parts: Bound[], caps: MatchCaps): Bound {
  // 1. runs of whitespace-only pieces are one whitespace run
  const merged: Bound[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (p.ws && last?.ws) {
      merged[merged.length - 1] = {
        nl: last.nl || p.nl,
        ws: true,
        max: Math.min(last.max + p.max, caps.ws),
      };
    } else merged.push(p);
  }
  // 2. runs of pieces that cannot match a newline lie on one line
  let total = 0;
  let run = 0;
  for (const p of merged) {
    if (!p.nl) run += p.max;
    else {
      total += Math.min(run, caps.line) + p.max;
      run = 0;
    }
  }
  total += Math.min(run, caps.line);
  const nl = parts.some((p) => p.nl);
  const ws = parts.every((p) => p.ws);
  let max = total;
  if (!nl) max = Math.min(max, caps.line);
  if (ws) max = Math.min(max, caps.ws);
  return { nl, ws, max };
}

function combineAlt(alts: Bound[]): Bound {
  return {
    nl: alts.some((a) => a.nl),
    ws: alts.every((a) => a.ws),
    max: Math.max(0, ...alts.map((a) => a.max)),
  };
}

/** Longest possible match, in bytes, of a Go RE2 pattern under `caps`. Infinity when unbounded. */
export function maxMatchBytes(pattern: string, caps: MatchCaps): number {
  let i = 0;
  const fail = (why: string): never => {
    throw new MatchBoundSyntaxError(pattern, i, why);
  };
  const peek = (): string | undefined => pattern[i];

  const readCodePoint = (): number => {
    const cp = pattern.codePointAt(i);
    if (cp === undefined) return fail('unexpected end');
    i += cp > 0xffff ? 2 : 1;
    return cp;
  };

  const readHex = (): number => {
    // after `\x`
    if (peek() === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) fail('unclosed \\x{');
      const hex = pattern.slice(i + 1, end);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) fail('bad \\x{}');
      i = end + 1;
      return parseInt(hex, 16);
    }
    const hex = pattern.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('bad \\x');
    i += 2;
    return parseInt(hex, 16);
  };

  const skipUnicodeClass = (): void => {
    // after `\p` or `\P`
    if (peek() === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) fail('unclosed \\p{');
      i = end + 1;
    } else if (peek() !== undefined && /[A-Za-z]/.test(peek() as string)) i++;
    else fail('bad \\p');
  };

  /** One escape outside a class; `i` is just after the backslash. */
  const escapeAtom = (fold: boolean): Bound | 'Q' => {
    const c = peek();
    if (c === undefined) return fail('trailing backslash');
    i++;
    if (c in CLASS_ESCAPES) return classEscape(c, fold);
    if (c in CONTROL_ESCAPES) return charBound(CONTROL_ESCAPES[c] as number);
    if ('bBAz'.includes(c)) return ZERO;
    if (c === 'x') return charBound(readHex(), fold);
    if (c === 'p' || c === 'P') {
      skipUnicodeClass();
      return { nl: true, ws: false, max: 4 };
    }
    if (c === 'Q') return 'Q';
    if (/[0-9A-Za-z]/.test(c)) return fail(`unsupported escape \\${c}`);
    return charBound(c.codePointAt(0) as number, fold);
  };

  const classAtom = (fold: boolean): Bound => {
    // after `[`
    let negated = false;
    if (peek() === '^') {
      negated = true;
      i++;
    }
    let hasNl = false;
    let allWs = true;
    let maxBytes = 1;
    let first = true;
    const addCp = (cp: number): void => {
      const b = charBound(cp, fold);
      hasNl ||= b.nl;
      allWs &&= b.ws;
      maxBytes = Math.max(maxBytes, b.max);
    };
    for (;;) {
      const c = peek();
      if (c === undefined) fail('unclosed class');
      if (c === ']' && !first) {
        i++;
        break;
      }
      first = false;
      if (c === '[' && pattern[i + 1] === ':') {
        const end = pattern.indexOf(':]', i + 2);
        if (end < 0) fail('unclosed posix class');
        let name = pattern.slice(i + 2, end);
        if (name.startsWith('^')) {
          name = name.slice(1);
          hasNl = true; // a negated posix class can match a newline
          allWs = false;
          maxBytes = 4;
        }
        const p = POSIX[name];
        if (p === undefined) fail(`unknown posix class ${name}`);
        if (fold && POSIX_WITH_K.has(name)) maxBytes = Math.max(maxBytes, 3);
        hasNl ||= (p as { nl: boolean }).nl;
        allWs &&= (p as { ws: boolean }).ws;
        i = end + 2;
        continue;
      }
      let lo: number;
      if (c === '\\') {
        i++;
        const e = peek();
        if (e === undefined) fail('trailing backslash');
        i++;
        if (e !== undefined && e in CLASS_ESCAPES) {
          const b = classEscape(e, fold);
          hasNl ||= b.nl;
          allWs &&= b.ws;
          maxBytes = Math.max(maxBytes, b.max);
          continue;
        }
        if (e === 'p' || e === 'P') {
          skipUnicodeClass();
          hasNl = true;
          allWs = false;
          maxBytes = 4;
          continue;
        }
        if (e !== undefined && e in CONTROL_ESCAPES) lo = CONTROL_ESCAPES[e] as number;
        else if (e === 'x') lo = readHex();
        else if (e !== undefined && /[0-9A-Za-z]/.test(e)) return fail(`unsupported escape \\${e}`);
        else lo = (e as string).codePointAt(0) as number;
      } else lo = readCodePoint();
      // a range lo-hi, unless the `-` is the last character before `]`
      if (peek() === '-' && pattern[i + 1] !== ']' && pattern[i + 1] !== undefined) {
        i++;
        let hi: number;
        if (peek() === '\\') {
          i++;
          const e = peek();
          i++;
          if (e !== undefined && e in CONTROL_ESCAPES) hi = CONTROL_ESCAPES[e] as number;
          else if (e === 'x') hi = readHex();
          else if (e === undefined || /[0-9A-Za-z]/.test(e)) return fail('bad range end');
          else hi = e.codePointAt(0) as number;
        } else hi = readCodePoint();
        if (hi < lo) fail('reversed range');
        hasNl ||= lo <= 0x0a && hi >= 0x0a;
        allWs &&= lo === hi && WS_CODES.has(lo);
        maxBytes = Math.max(maxBytes, rangeBytes(lo, hi, fold));
      } else addCp(lo);
    }
    if (negated) return { nl: !hasNl, ws: false, max: 4 };
    return { nl: hasNl, ws: allWs, max: maxBytes };
  };

  /** Reads a quantifier after an atom, if any. */
  const quantifier = (): { min: number; max: number } | undefined => {
    const c = peek();
    let q: { min: number; max: number } | undefined;
    if (c === '*') q = { min: 0, max: Number.POSITIVE_INFINITY };
    else if (c === '+') q = { min: 1, max: Number.POSITIVE_INFINITY };
    else if (c === '?') q = { min: 0, max: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) return undefined; // a literal `{`
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3]);
      if (hi < lo) fail('bad repeat');
      i += m[0].length - 1;
      q = { min: lo, max: hi };
    }
    if (q === undefined) return undefined;
    i++;
    if (peek() === '?') i++; // lazy: same lengths
    return q;
  };

  interface Flags {
    s: boolean;
    /** Case-insensitive: letters also match their Unicode folds (see rangeBytes). */
    i: boolean;
  }

  const parseFlags = (spec: string, flags: Flags): void => {
    let on = true;
    for (const f of spec) {
      if (f === '-') on = false;
      else if (f === 's') flags.s = on;
      else if (f === 'i') flags.i = on;
      else if (!'mU'.includes(f)) fail(`unknown flag ${f}`);
    }
  };

  const alternation = (flags: Flags): Bound => {
    const alts: Bound[] = [];
    let parts: Bound[] = [];
    for (;;) {
      const c = peek();
      if (c === undefined || c === ')') break;
      if (c === '|') {
        i++;
        alts.push(combineSeq(parts, caps));
        parts = [];
        continue;
      }
      let atom: Bound;
      if (c === '(') {
        i++;
        const inner: Flags = { ...flags };
        if (peek() === '?') {
          i++;
          const m = /^(?:P?<[A-Za-z_][A-Za-z0-9_]*>|:|([imsU-]*)(:|\)))/.exec(pattern.slice(i));
          if (!m) return fail('unknown group');
          i += m[0].length;
          if (m[2] === ')') {
            // (?flags): applies to the rest of this group
            parseFlags(m[1] ?? '', flags);
            continue;
          }
          if (m[2] === ':') parseFlags(m[1] ?? '', inner);
        }
        atom = alternation(inner);
        if (peek() !== ')') fail('unclosed group');
        i++;
      } else if (c === '[') {
        i++;
        atom = classAtom(flags.i);
      } else if (c === '.') {
        i++;
        atom = { nl: flags.s, ws: false, max: 4 };
      } else if (c === '^' || c === '$') {
        i++;
        atom = ZERO;
      } else if (c === '\\') {
        i++;
        const e = escapeAtom(flags.i);
        if (e === 'Q') {
          const end = pattern.indexOf('\\E', i);
          const lit = pattern.slice(i, end < 0 ? pattern.length : end);
          i = end < 0 ? pattern.length : end + 2;
          for (const ch of lit) parts.push(charBound(ch.codePointAt(0) as number, flags.i));
          continue;
        }
        atom = e;
      } else if (c === '*' || c === '+' || c === '?') {
        return fail('quantifier without atom');
      } else {
        atom = charBound(readCodePoint(), flags.i);
      }
      const q = quantifier();
      parts.push(q === undefined ? atom : combineRepeat(atom, q.min, q.max, caps));
    }
    alts.push(combineSeq(parts, caps));
    return combineAlt(alts);
  };

  const root = alternation({ s: false, i: false });
  if (i !== pattern.length) fail('unbalanced )');
  return root.max;
}
