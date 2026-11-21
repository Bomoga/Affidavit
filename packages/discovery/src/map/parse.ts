/**
 * Tree-sitter front end. Source text is untrusted data: it is parsed, never executed. The syntax
 * tree is copied into plain objects (comments dropped) under a depth and node cap, then the wasm
 * tree is freed, so the rest of the map never holds wasm memory and never sees comment text.
 */
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';
import type { IncompleteReason } from './types.js';

export interface AstNode {
  /** Tree-sitter node type. */
  t: string;
  /** 1-based start and end line. */
  r: number;
  er: number;
  /** 0-based start column. */
  col: number;
  /** Text, for named leaves only (identifiers, string fragments, numbers), capped. */
  x?: string;
  /** Operator token, for nodes that have an `operator` field (binary, for-in, assignment). */
  op?: string;
  /** `method_definition` with a `get` or `set` keyword. */
  acc?: boolean;
  /** Named children in source order. Comments are not kept. */
  c: AstNode[];
  /** Named children by field name. */
  f: Record<string, AstNode | undefined>;
}

export type Grammar = 'javascript' | 'typescript' | 'tsx';

export interface ParseResult {
  root: AstNode;
  /** Reasons the tree is not a faithful copy of the source. */
  incomplete: IncompleteReason[];
  /** Syntax nodes kept. */
  nodes: number;
}

const LEAF_TEXT_CAP = 512;

/** Node types whose own text the map reads. Everything else is structure only. */
const LEAF_TYPES = new Set([
  'identifier',
  'property_identifier',
  'private_property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'statement_identifier',
  'string_fragment',
  'escape_sequence',
  'number',
  'regex_pattern',
  'this',
  'true',
  'false',
  'null',
  'undefined',
]);

let ready: Promise<Record<Grammar, Language>> | undefined;
const parsers = new Map<Grammar, Parser>();

function loadAll(): Promise<Record<Grammar, Language>> {
  ready ??= (async () => {
    await Parser.init();
    // The wasm grammars ship inside the installed grammar packages; nothing is fetched.
    const require = createRequire(import.meta.url);
    const [javascript, typescript, tsx] = await Promise.all([
      Language.load(require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm')),
      Language.load(require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')),
      Language.load(require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm')),
    ]);
    return { javascript, typescript, tsx };
  })();
  return ready;
}

/** Loads the parser and grammars once. Rejects if the installed wasm files cannot be loaded. */
export async function initParser(): Promise<void> {
  await loadAll();
}

export function grammarFor(path: string): Grammar | undefined {
  const m = /\.([a-z]+)$/i.exec(path);
  switch (m?.[1]?.toLowerCase()) {
    case 'js':
    case 'cjs':
    case 'mjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    default:
      return undefined;
  }
}

async function parserFor(grammar: Grammar): Promise<Parser> {
  const langs = await loadAll();
  let p = parsers.get(grammar);
  if (!p) {
    p = new Parser();
    p.setLanguage(langs[grammar]);
    parsers.set(grammar, p);
  }
  return p;
}

export interface ParseLimits {
  maxAstDepth: number;
  maxNodes: number;
  maxParseMillis: number;
}

/**
 * Parses and copies. Returns `'timeout'` when the parse ran past its budget and `'failed'` when
 * the parser gave no tree. Never throws on hostile input.
 */
export async function parseSource(
  text: string,
  grammar: Grammar,
  limits: ParseLimits,
): Promise<ParseResult | 'timeout' | 'failed'> {
  const parser = await parserFor(grammar);
  const deadline = Date.now() + limits.maxParseMillis;
  let timedOut = false;
  let tree;
  try {
    tree = parser.parse(text, null, {
      progressCallback: () => {
        if (Date.now() > deadline) {
          timedOut = true;
          return true;
        }
        return false;
      },
    });
  } catch {
    return 'failed';
  }
  if (timedOut) {
    tree?.delete();
    return 'timeout';
  }
  if (!tree) return 'failed';
  try {
    return copyTree(tree.walk(), limits);
  } finally {
    tree.delete();
  }
}

/** A run of free text or a name in a source file, for slice hygiene (L1-07). */
export interface LexicalSpan {
  kind: 'comment' | 'string' | 'template' | 'regex' | 'jsx-text' | 'identifier';
  /** Index range in the JavaScript string that was parsed (UTF-16 code units, end exclusive). */
  start: number;
  end: number;
  /**
   * What the literal says: for a string or template, its fragments with escape sequences decoded
   * (a template substitution counts as a space); a regex's pattern; JSX text; an identifier's name.
   * Empty for a comment.
   */
  text: string;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/** Decodes one JavaScript escape sequence (`\u0041`, `\u{41}`, `\x41`, `\n`, `\'`, a line continuation). */
export function decodeEscape(seq: string): string {
  const body = seq.slice(1);
  let m = /^u\{([0-9a-fA-F]{1,6})\}$/.exec(body) ?? /^u([0-9a-fA-F]{4})$/.exec(body);
  m ??= /^x([0-9a-fA-F]{2})$/.exec(body);
  if (m?.[1]) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  if (/^(\r\n|\r|\n|\u2028|\u2029)$/.test(body)) return '';
  return SIMPLE_ESCAPES[body] ?? body;
}

interface NodeLike {
  type: string;
  text: string;
  children: (NodeLike | null)[];
}

/** Decoded content of a string or template node: fragments and escapes, a space per substitution. */
function literalText(node: NodeLike): string {
  let out = '';
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'string_fragment' || c.type === 'jsx_text') out += c.text;
    else if (c.type === 'escape_sequence') out += decodeEscape(c.text);
    else if (c.type === 'template_substitution') out += ' ';
  }
  return out;
}

const IDENTIFIER_TYPES = new Set([
  'identifier',
  'property_identifier',
  'private_property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'statement_identifier',
  'type_identifier',
]);

/**
 * Where the comments, literals and names are in a file, for slice hygiene (L1-07). Same parser
 * and budget as `parseSource`; never throws on hostile input. `syntaxError` is true when the tree
 * has an error or missing node (the spans found are still returned). Spans nest (a string inside
 * a template substitution is listed after the template) and are sorted by start.
 */
export async function lexicalSpans(
  text: string,
  grammar: Grammar,
  maxParseMillis: number,
): Promise<{ spans: LexicalSpan[]; syntaxError: boolean } | 'timeout' | 'failed'> {
  const parser = await parserFor(grammar);
  const deadline = Date.now() + maxParseMillis;
  let timedOut = false;
  let tree;
  try {
    tree = parser.parse(text, null, {
      progressCallback: () => {
        if (Date.now() > deadline) {
          timedOut = true;
          return true;
        }
        return false;
      },
    });
  } catch {
    return 'failed';
  }
  if (timedOut) {
    tree?.delete();
    return 'timeout';
  }
  if (!tree) return 'failed';
  const cursor = tree.walk();
  const spans: LexicalSpan[] = [];
  let syntaxError = false;
  try {
    for (;;) {
      const t = cursor.nodeType;
      if (t === 'ERROR' || cursor.nodeIsMissing) syntaxError = true;
      const at = { start: cursor.startIndex, end: cursor.endIndex };
      let descend = true;
      if (t === 'comment' || t === 'html_comment' || t === 'hash_bang_line') {
        spans.push({ kind: 'comment', ...at, text: '' });
        descend = false;
      } else if (t === 'string' || t === 'template_string') {
        const node = cursor.currentNode as unknown as NodeLike;
        spans.push({
          kind: t === 'string' ? 'string' : 'template',
          ...at,
          text: literalText(node),
        });
      } else if (t === 'regex') {
        const node = cursor.currentNode as unknown as NodeLike;
        const pattern = node.children.find((c) => c?.type === 'regex_pattern');
        spans.push({ kind: 'regex', ...at, text: pattern?.text ?? '' });
        descend = false;
      } else if (t === 'jsx_text') {
        spans.push({ kind: 'jsx-text', ...at, text: cursor.nodeText });
        descend = false;
      } else if (IDENTIFIER_TYPES.has(t)) {
        spans.push({ kind: 'identifier', ...at, text: cursor.nodeText });
        descend = false;
      }
      if (descend && cursor.gotoFirstChild()) continue;
      let up = false;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          up = true;
          break;
        }
      }
      if (up) break;
    }
  } finally {
    cursor.delete();
    tree.delete();
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return { spans, syntaxError };
}

interface CursorLike {
  nodeType: string;
  nodeIsNamed: boolean;
  nodeIsMissing: boolean;
  currentFieldName: string | null;
  nodeText: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number };
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoParent(): boolean;
  delete(): void;
}

function copyTree(cursor: CursorLike, limits: ParseLimits): ParseResult {
  const incomplete = new Set<IncompleteReason>();
  let count = 0;
  const make = (): AstNode => {
    count++;
    const n: AstNode = {
      t: cursor.nodeType,
      r: cursor.startPosition.row + 1,
      er: cursor.endPosition.row + 1,
      col: cursor.startPosition.column,
      c: [],
      // No prototype: field names and the lookups on them stay plain data.
      f: Object.create(null) as Record<string, AstNode | undefined>,
    };
    if (n.t === 'ERROR' || cursor.nodeIsMissing) incomplete.add('syntax-error');
    return n;
  };
  const root = make();
  // Invariant: the top of `stack` is the copy of the cursor's parent.
  const stack: AstNode[] = [root];
  try {
    if (cursor.gotoFirstChild()) {
      for (;;) {
        const parent = stack[stack.length - 1];
        if (parent && cursor.nodeIsNamed && cursor.nodeType !== 'comment') {
          if (count >= limits.maxNodes) {
            incomplete.add('node-limit');
          } else {
            const n = make();
            parent.c.push(n);
            const field = cursor.currentFieldName;
            if (field) parent.f[field] = n;
            if (LEAF_TYPES.has(n.t)) {
              const text = cursor.nodeText;
              if (text.length > LEAF_TEXT_CAP) incomplete.add('text-limit');
              n.x = text.slice(0, LEAF_TEXT_CAP);
            }
            if (stack.length >= limits.maxAstDepth) {
              incomplete.add('depth-limit');
            } else if (cursor.gotoFirstChild()) {
              stack.push(n);
              continue;
            }
          }
        } else if (parent && !cursor.nodeIsNamed) {
          if (cursor.currentFieldName === 'operator') parent.op = cursor.nodeType;
          else if (cursor.nodeType === 'get' || cursor.nodeType === 'set') parent.acc = true;
          else if (cursor.nodeType === 'static' || cursor.nodeType === 'default') {
            parent.op ??= cursor.nodeType;
          }
        }
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) return { root, incomplete: [...incomplete], nodes: count };
          stack.pop();
        }
      }
    }
    return { root, incomplete: [...incomplete], nodes: count };
  } finally {
    cursor.delete();
  }
}
