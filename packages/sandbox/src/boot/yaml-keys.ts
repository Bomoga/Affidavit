/**
 * A conservative reader for the small YAML subset compose files use, written for the compose
 * precheck (compose.ts) so the sandbox needs no YAML dependency (lead decision 2026-11-20, PR #18).
 *
 * It does not build a tree. It tokenizes the text and reports every mapping key, with whether its
 * value is empty, so the precheck can refuse keys that make Compose read other files before
 * Compose ever sees the file. Anything outside the subset is refused (the target is then
 * `unsupported`), never guessed at:
 *
 * - tags (`!reset`, `!!binary`), explicit keys (`? `), directives (`%`), more than one document,
 *   reserved indicators (`@`, a backquote);
 * - tab indentation, NUL, a byte order mark, a bare carriage return;
 * - a key that is an alias, spans lines, or is a double-quoted scalar with an escape;
 * - duplicate keys in one mapping (block or flow);
 * - unterminated quotes and unbalanced flow brackets.
 *
 * Anchors, aliases and merge keys need no special handling: every key is checked where it is
 * written, so an alias can only repeat a key that was already seen. Block scalars (`|`, `>`) are
 * skipped as text.
 */

export interface YamlKey {
  /** The key as written, with single-quote escapes undone. */
  name: string;
  /** The value is null, `~`, `[]` or `{}`. */
  empty: boolean;
  line: number;
}

export type KeyScan = { ok: true; keys: YamlKey[] } | { ok: false; reason: string };

interface Tok {
  kind: 'plain' | 'quoted' | 'ind' | 'alias' | 'anchor' | 'block';
  text: string;
  line: number;
  col: number;
  /** Line the token ends on (quoted scalars may span lines). */
  endLine: number;
  flow: number;
  escaped?: boolean;
}

class Refusal extends Error {}
const refuse = (why: string): never => {
  throw new Refusal(why);
};

const FLOW = ',[]{}';
const isSpace = (c: string | undefined): boolean =>
  c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r';

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  const flowStack: string[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;
  let quoteEnd = -1;
  const push = (t: Omit<Tok, 'flow' | 'endLine'> & { endLine?: number }): void => {
    toks.push({ ...t, endLine: t.endLine ?? t.line, flow: flowStack.length });
  };
  const indentOf = (start: number): number => {
    let k = start;
    while (s[k] === ' ') k++;
    return k - start;
  };

  while (i < s.length) {
    const c = s[i] as string;
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === '\r') {
      if (s[i + 1] !== '\n') refuse('a bare carriage return');
      i++;
      continue;
    }
    if (c === '\t') {
      if (/^[ \t]*$/.test(s.slice(lineStart, i))) refuse('tab indentation');
      i++;
      continue;
    }
    if (c === ' ') {
      i++;
      continue;
    }
    const col = i - lineStart;
    if (c === '#') {
      if (i > lineStart && !isSpace(s[i - 1])) refuse('a comment not preceded by a space');
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (col === 0 && (s.startsWith('---', i) || s.startsWith('...', i)) && isSpace(s[i + 3])) {
      if (toks.length > 0 || s.startsWith('...', i)) refuse('more than one YAML document');
      i += 3;
      continue;
    }
    if (col === 0 && c === '%') refuse('a YAML directive');
    if (c === '!') refuse('a YAML tag');
    if (c === '@' || c === '`') refuse(`a reserved indicator ${c}`);
    if (c === '?' && isSpace(s[i + 1])) refuse('an explicit key');
    if ((c === '|' || c === '>') && flowStack.length === 0) {
      // A block scalar: the rest of this line holds only its header, and its content is every
      // following line that is blank or indented deeper than this line.
      const parent = indentOf(lineStart);
      push({ kind: 'block', text: '', line, col });
      while (i < s.length && s[i] !== '\n') i++;
      while (i < s.length) {
        const next = i + 1;
        const end = s.indexOf('\n', next);
        const text = s.slice(next, end < 0 ? s.length : end);
        if (text.trim() !== '' && indentOf(next) <= parent) break;
        if (/^ *\t/.test(text)) refuse('tab indentation');
        i = end < 0 ? s.length : end;
        line++;
        lineStart = next;
      }
      continue;
    }
    if (c === '[' || c === '{') {
      push({ kind: 'ind', text: c, line, col });
      flowStack.push(c);
      i++;
      continue;
    }
    if (c === ']' || c === '}') {
      const open = flowStack.pop();
      if (open !== (c === ']' ? '[' : '{')) refuse('unbalanced flow brackets');
      push({ kind: 'ind', text: c, line, col });
      i++;
      continue;
    }
    if (c === ',') {
      if (flowStack.length === 0) refuse('a comma outside a flow collection');
      push({ kind: 'ind', text: c, line, col });
      i++;
      continue;
    }
    // After a quoted scalar a colon is always an indicator (a JSON-like key), as in flow style.
    if (c === ':' && (isSpace(s[i + 1]) || flowStack.length > 0 || quoteEnd === i)) {
      push({ kind: 'ind', text: ':', line, col });
      i++;
      continue;
    }
    if (c === '-' && isSpace(s[i + 1])) {
      if (flowStack.length > 0) refuse('a block sequence inside a flow collection');
      push({ kind: 'ind', text: '-', line, col });
      i++;
      continue;
    }
    if (c === '&' || c === '*') {
      let j = i + 1;
      while (j < s.length && !isSpace(s[j]) && !FLOW.includes(s[j] as string)) j++;
      if (j === i + 1) refuse(`an empty ${c === '&' ? 'anchor' : 'alias'}`);
      push({ kind: c === '&' ? 'anchor' : 'alias', text: s.slice(i + 1, j), line, col });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      let escaped = false;
      const startLine = line;
      for (;;) {
        if (j >= s.length) refuse('an unterminated quoted scalar');
        const ch = s[j] as string;
        if (c === "'" && ch === "'") {
          if (s[j + 1] === "'") {
            text += "'";
            j += 2;
            continue;
          }
          break;
        }
        if (c === '"' && ch === '"') break;
        if (c === '"' && ch === '\\') {
          escaped = true;
          if (s[j + 1] === '\n') {
            line++;
            lineStart = j + 2;
          }
          text += s.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (ch === '\n') {
          line++;
          lineStart = j + 1;
        }
        text += ch;
        j++;
      }
      push({ kind: 'quoted', text, line: startLine, col, endLine: line, escaped });
      i = j + 1;
      quoteEnd = i;
      continue;
    }
    // A plain scalar: up to `: `, ` #`, the end of the line, or (in flow) a flow indicator.
    let j = i;
    while (j < s.length) {
      const ch = s[j] as string;
      if (ch === '\n' || ch === '\r') break;
      if (
        ch === ':' &&
        (isSpace(s[j + 1]) || (flowStack.length > 0 && FLOW.includes(s[j + 1] as string)))
      )
        break;
      if (flowStack.length > 0 && FLOW.includes(ch)) break;
      if (ch === '#' && (s[j - 1] === ' ' || s[j - 1] === '\t')) break;
      j++;
    }
    push({ kind: 'plain', text: s.slice(i, j).trimEnd(), line, col });
    i = j;
  }
  if (flowStack.length > 0) refuse('unbalanced flow brackets');
  return toks;
}

const NULLS = new Set(['null', 'Null', 'NULL', '~']);

/** Every mapping key in a compose file, or why the file is outside the subset. Never throws. */
export function scanYamlKeys(text: string): KeyScan {
  try {
    if (text.includes('\0')) refuse('a NUL byte');
    if (text.includes('﻿')) refuse('a byte order mark');
    if (text.includes('�')) refuse('text that is not UTF-8');
    const toks = tokenize(text);
    const keys: YamlKey[] = [];
    const block: { col: number; keys: Set<string> }[] = [];
    const flow: (Set<string> | null)[] = [];
    toks.forEach((t, idx) => {
      if (t.kind === 'ind') {
        if (t.text === '{') flow.push(new Set());
        else if (t.text === '[') flow.push(null);
        else if (t.text === '}' || t.text === ']') flow.pop();
        else if (t.text === '-' && t.flow === 0) {
          while (block.length > 0 && (block.at(-1) as { col: number }).col > t.col) block.pop();
        }
        return;
      }
      const colon = toks[idx + 1];
      if (colon?.kind !== 'ind' || colon.text !== ':') return;
      if (t.kind === 'alias') refuse('an alias used as a key');
      if (t.kind === 'anchor' || t.kind === 'block') return;
      if (t.endLine !== t.line || colon.line !== t.endLine) refuse('a key that spans lines');
      if (t.escaped === true) refuse('a key with an escape sequence');

      if (t.flow > 0) {
        const set = flow.at(-1);
        if (set) {
          if (set.has(t.text)) refuse(`duplicate key ${JSON.stringify(t.text)}`);
          set.add(t.text);
        }
      } else {
        while (block.length > 0 && (block.at(-1) as { col: number }).col > t.col) block.pop();
        const top = block.at(-1);
        if (top !== undefined && top.col === t.col) {
          if (top.keys.has(t.text)) refuse(`duplicate key ${JSON.stringify(t.text)}`);
          top.keys.add(t.text);
        } else block.push({ col: t.col, keys: new Set([t.text]) });
      }

      const v = toks[idx + 2];
      let empty: boolean;
      if (v === undefined) empty = true;
      else if (v.kind === 'ind' && (v.text === '[' || v.text === '{')) {
        const close = toks[idx + 3];
        empty = close?.kind === 'ind' && close.text === (v.text === '[' ? ']' : '}');
      } else if (v.kind === 'plain' && NULLS.has(v.text) && v.line === colon.line) empty = true;
      else if (t.flow > 0) empty = v.kind === 'ind' && (v.text === ',' || v.text === '}');
      else if (v.line > colon.line) {
        empty = v.col < t.col || (v.col === t.col && !(v.kind === 'ind' && v.text === '-'));
      } else empty = false;
      keys.push({ name: t.text, empty, line: t.line + 1 });
    });
    // A plain scalar whose text reads `<key>:<value>` (no space) is one scalar to YAML, but a
    // parser that disagreed would see a key. Report its first segment as a key too.
    for (const t of toks) {
      if (t.kind !== 'plain' || !t.text.includes(':')) continue;
      keys.push({ name: t.text.slice(0, t.text.indexOf(':')), empty: false, line: t.line + 1 });
    }
    return { ok: true, keys };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    return { ok: false, reason: 'the file could not be read' };
  }
}
