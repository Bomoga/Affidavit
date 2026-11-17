/**
 * One cheap pass over each file's syntax tree, before any interpretation: which functions exist
 * (with their line ranges, names and lexical parents), which names are referenced, and which
 * modules the file asks for by a literal specifier.
 */
import type { AstNode } from './parse.js';
import type { FnRef, IncompleteReason } from './types.js';

export type FnKind = 'module' | 'function' | 'arrow' | 'method' | 'class';

export interface FnInfo {
  /** Unique across the run. */
  id: number;
  file: string;
  node: AstNode;
  kind: FnKind;
  /** Declared or assigned names, in order of discovery. Identifier text only. */
  names: string[];
  startLine: number;
  endLine: number;
  /** Lexically enclosing function (the module function for top-level code); null for a module. */
  parent: number | null;
}

export interface FileFacts {
  path: string;
  root: AstNode;
  incomplete: IncompleteReason[];
  /** `fns[0]` is the module function. */
  fns: FnInfo[];
  fnByNode: Map<AstNode, FnInfo>;
  /** Count of each name used as a reference (not as a declaration or an assignment target). */
  uses: Map<string, number>;
  /** Literal module specifiers (`require('x')`, `import 'x'`), with their lines. */
  specs: { spec: string; line: number }[];
}

const FN_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
  'class_declaration',
  'class',
]);

const NAME_DECL_PARENTS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'class_declaration',
  'class',
  'method_definition',
  'variable_declarator',
]);

const IDENT = new Set([
  'identifier',
  'property_identifier',
  'shorthand_property_identifier',
  'private_property_identifier',
]);

/** Text of a string literal node (no substitutions), or undefined. */
export function plainString(n: AstNode | undefined): string | undefined {
  if (!n) return undefined;
  if (n.t === 'string') return strBody(n);
  if (
    n.t === 'template_string' &&
    n.c.every((c) => c.t === 'string_fragment' || c.t === 'escape_sequence')
  ) {
    return strBody(n);
  }
  return undefined;
}

function strBody(n: AstNode): string {
  let s = '';
  for (const c of n.c) {
    if (c.t === 'string_fragment') s += c.x ?? '';
    else if (c.t === 'escape_sequence') s += unescapeOne(c.x ?? '');
  }
  return s;
}

function unescapeOne(e: string): string {
  switch (e) {
    case '\\n':
      return '\n';
    case '\\t':
      return '\t';
    case '\\r':
      return '\r';
    default:
      return e.startsWith('\\') ? e.slice(1) : e;
  }
}

export function keyName(n: AstNode | undefined): string | undefined {
  if (!n) return undefined;
  if (
    n.t === 'property_identifier' ||
    n.t === 'identifier' ||
    n.t === 'private_property_identifier'
  ) {
    return n.x;
  }
  if (n.t === 'string') return strBody(n);
  if (n.t === 'number') return n.x;
  return undefined;
}

export function safeIdent(s: string | undefined, cap = 80): string {
  if (!s) return '<anonymous>';
  const cleaned = s.replace(/[^A-Za-z0-9_$.<>()[\]-]/g, '_');
  return cleaned.slice(0, cap) || '<anonymous>';
}

export function fnRef(fn: FnInfo): FnRef {
  return {
    file: fn.file,
    name: fn.kind === 'module' ? '<module>' : safeIdent(fn.names[0]),
    startLine: fn.startLine,
    endLine: fn.endLine,
  };
}

function nameFromContext(n: AstNode, parent: AstNode | undefined, field: string): string[] {
  const out: string[] = [];
  const own = n.f['name'];
  if (own?.x) out.push(own.x);
  if (own && !own.x) {
    const k = keyName(own);
    if (k) out.push(k);
  }
  if (!parent) return out;
  if (parent.t === 'variable_declarator' && field === 'value') {
    const nm = parent.f['name'];
    if (nm?.t === 'identifier' && nm.x) out.push(nm.x);
  } else if (parent.t === 'assignment_expression' && field === 'right') {
    const left = parent.f['left'];
    if (left?.t === 'identifier' && left.x) out.push(left.x);
    else if (left?.t === 'member_expression') {
      const p = left.f['property']?.x;
      if (p) out.push(p);
    }
  } else if (parent.t === 'pair' && field === 'value') {
    const k = keyName(parent.f['key']);
    if (k) out.push(k);
  } else if (parent.t === 'field_definition' && field === 'value') {
    const k = keyName(parent.f['property']);
    if (k) out.push(k);
  } else if (parent.t === 'export_statement') {
    out.push('default');
  }
  return [...new Set(out)];
}

function isDeclarationPosition(
  n: AstNode,
  parent: AstNode,
  field: string,
  grand: AstNode | undefined,
): boolean {
  const p = parent.t;
  if (NAME_DECL_PARENTS.has(p) && field === 'name') return true;
  if (p === 'pair' && field === 'key') return true;
  if (p === 'field_definition' && field === 'property') return true;
  if (p === 'formal_parameters' || p === 'rest_pattern' || p === 'object_pattern') return true;
  if (p === 'pair_pattern') return true;
  if ((p === 'required_parameter' || p === 'optional_parameter') && field === 'pattern')
    return true;
  if (p === 'assignment_pattern' && field === 'left') return true;
  if (p === 'arrow_function' && field === 'parameter') return true;
  if (p === 'member_expression' && field === 'property' && grand?.t === 'assignment_expression') {
    return grand.f['left'] === parent;
  }
  return n.t === 'private_property_identifier' && field === 'name';
}

/** Collects functions, name uses and module specifiers. Recursion depth is bounded by the tree. */
export function prepass(
  path: string,
  root: AstNode,
  incomplete: IncompleteReason[],
  nextFnId: () => number,
): FileFacts {
  const fns: FnInfo[] = [];
  const fnByNode = new Map<AstNode, FnInfo>();
  const uses = new Map<string, number>();
  const specs: { spec: string; line: number }[] = [];
  const moduleFn: FnInfo = {
    id: nextFnId(),
    file: path,
    node: root,
    kind: 'module',
    names: [],
    startLine: 1,
    endLine: Math.max(root.er, 1),
    parent: null,
  };
  fns.push(moduleFn);
  fnByNode.set(root, moduleFn);

  const visit = (
    n: AstNode,
    parent: AstNode | undefined,
    field: string,
    grand: AstNode | undefined,
    enclosing: FnInfo,
  ): void => {
    let current = enclosing;
    if (FN_TYPES.has(n.t) && (n.f['body'] || n.t === 'class_declaration' || n.t === 'class')) {
      const kind: FnKind =
        n.t === 'arrow_function'
          ? 'arrow'
          : n.t === 'method_definition'
            ? 'method'
            : n.t === 'class_declaration' || n.t === 'class'
              ? 'class'
              : 'function';
      const info: FnInfo = {
        id: nextFnId(),
        file: path,
        node: n,
        kind,
        names: nameFromContext(n, parent, field),
        startLine: n.r,
        endLine: n.er,
        parent: enclosing.id,
      };
      fns.push(info);
      fnByNode.set(n, info);
      // A class body's methods are functions of their own; the class function stands for the
      // constructor, so nested functions inside methods hang off the method, not the class.
      current = info;
    }
    if (IDENT.has(n.t) && n.x && parent && !isDeclarationPosition(n, parent, field, grand)) {
      uses.set(n.x, (uses.get(n.x) ?? 0) + 1);
    }
    // A string key names a member as surely as an identifier does: `o['go']()`, `{ 'go': f }`.
    if (n.t === 'subscript_expression') {
      const idx = n.f['index'];
      const s = plainString(idx);
      if (s !== undefined) uses.set(s, (uses.get(s) ?? 0) + 1);
      else if (idx?.t === 'template_string') {
        for (const c of idx.c) {
          const t = c.t === 'string_fragment' ? c.x?.trim() : undefined;
          if (t) uses.set(t, (uses.get(t) ?? 0) + 1);
        }
      }
    } else if ((n.t === 'pair' || n.t === 'pair_pattern') && n.f['key']?.t === 'string') {
      const s = plainString(n.f['key']);
      if (s !== undefined) uses.set(s, (uses.get(s) ?? 0) + 1);
    }
    if (n.t === 'call_expression') {
      const fnNode = n.f['function'];
      const args = n.f['arguments'];
      if ((fnNode?.t === 'identifier' && fnNode.x === 'require') || fnNode?.t === 'import') {
        const s = plainString(args?.c[0]);
        if (s !== undefined && args?.c.length === 1) specs.push({ spec: s, line: n.r });
      }
    } else if (n.t === 'import_statement' || n.t === 'export_statement') {
      const s = plainString(n.f['source']);
      if (s !== undefined) specs.push({ spec: s, line: n.r });
    }
    for (const c of n.c) {
      const f = Object.entries(n.f).find(([, v]) => v === c)?.[0] ?? '';
      visit(c, n, f, parent, current);
    }
  };
  for (const c of root.c) visit(c, root, '', undefined, moduleFn);
  return { path, root, incomplete, fns, fnByNode, uses, specs };
}
