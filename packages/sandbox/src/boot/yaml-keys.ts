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
 * - anchors (`&`), aliases (`*`) and merge keys (`<<`);
 * - tab indentation, NUL, a byte order mark, a bare carriage return, and the other characters
 *   go-yaml treats as line breaks (NEL, U+2028, U+2029);
 * - a flow collection or a quoted scalar inside one that spans lines;
 * - a key that spans lines or is a double-quoted scalar with an escape;
 * - duplicate keys in one mapping (block or flow);
 * - unterminated quotes and unbalanced flow brackets.
 *
 * This is a security check (the precheck must see every key Compose will), so the scanner only
 * skips text where it knows exactly where the text ends. A block scalar (`|`, `>`, optionally
 * with `+` or `-` and a comment) is read only as the value of a key that starts its line; its
 * content is the following lines indented deeper than that key, and it must have at least one,
 * with no line less indented than the first. Every other block scalar is refused: after `- `,
 * after an anchor, in a flow collection, with an indentation indicator or with text after the
 * header.
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
  kind: 'plain' | 'quoted' | 'ind' | 'block';
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
      if (flowStack.length > 0) refuse('a flow collection spanning lines');
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
    if (c === '|' || c === '>') {
      if (flowStack.length > 0) refuse('a block scalar inside a flow collection');
      // Only `<key>: |` with the key as the first token of its line: the owning node is then that
      // key's mapping, whose column is the key's, so YAML and this scanner agree on where the
      // content ends.
      const colon = toks.at(-1);
      const key = toks.at(-2);
      const before = toks.at(-3);
      if (
        colon?.kind !== 'ind' ||
        colon.text !== ':' ||
        colon.line !== line ||
        (key?.kind !== 'plain' && key?.kind !== 'quoted') ||
        key.line !== line ||
        key.endLine !== line ||
        key.col !== indentOf(lineStart) ||
        (before !== undefined && before.endLine === line)
      ) {
        refuse('a block scalar that is not the value of a key starting its line');
      }
      const keyCol = (key as Tok).col;
      let e = s.indexOf('\n', i);
      if (e < 0) e = s.length;
      if (!/^[|>][+-]?(?: +#.*)?$/.test(s.slice(i, e).trimEnd())) {
        refuse('a block scalar header outside the subset');
      }
      push({ kind: 'block', text: '', line, col });
      i = e;
      let contentIndent = -1;
      while (i < s.length) {
        const next = i + 1;
        const end = s.indexOf('\n', next);
        const text = s.slice(next, end < 0 ? s.length : end).replace(/\r$/, '');
        if (/^ *\t/.test(text)) refuse('tab indentation');
        if (text.trim() !== '') {
          const ind = indentOf(next);
          if (ind <= keyCol) break;
          if (contentIndent < 0) contentIndent = ind;
          else if (ind < contentIndent) {
            refuse('a block scalar whose content dedents below its first line');
          }
        }
        i = end < 0 ? s.length : end;
        line++;
        lineStart = next;
      }
      if (contentIndent < 0) refuse('a block scalar with no content');
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
    if (c === '&') refuse('an anchor');
    if (c === '*') refuse('an alias');
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
      if (flowStack.length > 0 && line !== startLine) refuse('a flow collection spanning lines');
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
    if (/\r(?!\n)/.test(text)) refuse('a bare carriage return');
    if ([0x85, 0x2028, 0x2029].some((cp) => text.includes(String.fromCharCode(cp)))) {
      refuse('a NEL, U+2028 or U+2029 line break');
    }
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
      if (t.kind === 'block') return;
      if (t.endLine !== t.line || colon.line !== t.endLine) refuse('a key that spans lines');
      if (t.escaped === true) refuse('a key with an escape sequence');
      if (t.text === '<<') refuse('a merge key');

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
      // A value written on the key's line (`null`, `~`, `[]`, `{}`) is empty only if what follows
      // starts a new line at or left of the key's column. A deeper next line would continue it
      // (`env_file: null` then `  /etc/shadow` is one plain scalar to YAML), so refuse that.
      if (empty && t.flow === 0 && v !== undefined && v.line === colon.line) {
        const after = toks[idx + (v.kind === 'ind' ? 4 : 3)];
        if (after !== undefined && after.line > v.endLine && after.col > t.col) {
          refuse('an empty value continued on a deeper line');
        }
      }
      keys.push({ name: t.text, empty, line: t.line + 1 });
    });
    // A plain scalar whose text reads `<key>:<value>` (no space) is one scalar to YAML, but a
    // parser that disagreed would see a key. Report its first segment as a key too.
    for (const t of toks) {
      if (t.kind !== 'plain' || !t.text.includes(':')) continue;
      keys.push({
        name: t.text.slice(0, t.text.indexOf(':')).trim(),
        empty: false,
        line: t.line + 1,
      });
    }
    return { ok: true, keys };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    return { ok: false, reason: 'the file could not be read' };
  }
}
