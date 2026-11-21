// Test tooling: a static egress guard over this package's own source. Imported only by
// egress-guard.test.ts and never exported from the package index, so the TypeScript compiler
// (a root devDependency) is never loaded at run time.
import ts from 'typescript';

export interface EgressFinding {
  file: string;
  line: number;
  /** A short, stable label: `import node:https`, `call fetch`, `spawn npm`, ... */
  what: string;
}

/** A reviewed exception: one finding in one file, with why it does not reach the network. */
export interface EgressAllow {
  file: string;
  what: string;
  reason: string;
}

export const EGRESS_ALLOWLIST: readonly EgressAllow[] = [
  {
    file: 'containment/host.ts',
    what: 'import node:http',
    reason:
      'createServer only: the containment suite listens as a fake orchestrator to prove the jail cannot reach it; nothing connects out',
  },
  {
    file: 'boot/compose.ts',
    what: 'spawn <unresolved>',
    reason:
      'the Compose v2 binary from a fixed absolute path (COMPOSE_BIN_PATHS or AFFIDAVIT_COMPOSE_BIN), run with an empty config directory; it normalizes a file and fetches nothing',
  },
];

const NET_MODULES = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
]);
const NET_PACKAGES = new Set(['undici']);
const CHILD_FNS = new Set([
  'exec',
  'execFile',
  'execSync',
  'execFileSync',
  'spawn',
  'spawnSync',
  'fork',
]);
const TOOLS = /^(npm|npx|pnpm|yarn|node-gyp|curl|wget|git|node)(\.cmd|\.exe)?$/i;
const TOOL_WORD = /(^|[\s;&|/`'"(])(npm|npx|pnpm|yarn|node-gyp|curl|wget|git)(?=$|[\s;&|'"`)])/i;
const SHELLS = /^(sh|bash|dash|zsh|ash|cmd|cmd\.exe|powershell|pwsh)$/i;
const BROWSER_NET = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource']);
const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);

function netModuleLabel(spec: string): string | null {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  if (NET_MODULES.has(bare)) return `import node:${bare}`;
  if (NET_PACKAGES.has(spec) || [...NET_PACKAGES].some((p) => spec.startsWith(`${p}/`))) {
    return `import ${spec}`;
  }
  return null;
}

const isChildProcessModule = (spec: string): boolean =>
  spec === 'child_process' || spec === 'node:child_process';

/**
 * Parses one file with the TypeScript compiler (no regex over raw text) and returns every
 * runtime import of a network module, every `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`
 * use, and every host `child_process` call that runs a package manager, a fetch tool, git, node,
 * a shell running one of those, or a command it cannot resolve to a string. Text inside string
 * literals and templates (scripts that run in the jail) is data, not code, and is not a finding.
 */
export function findEgress(
  file: string,
  text: string,
  allow: readonly EgressAllow[] = EGRESS_ALLOWLIST,
): EgressFinding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: EgressFinding[] = [];
  const add = (node: ts.Node, what: string): void => {
    if (allow.some((a) => a.file === file && a.what === what)) return;
    findings.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      what,
    });
  };

  // Local names bound to child_process functions or to the module namespace, and const strings.
  const childFns = new Set<string>();
  const childNamespaces = new Set<string>();
  const constStrings = new Map<string, string>();

  const literal = (n: ts.Expression | undefined): string | null => {
    if (n === undefined) return null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isIdentifier(n)) return constStrings.get(n.text) ?? null;
    return null;
  };
  const isChildCallee = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return childFns.has(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
      return (
        ts.isIdentifier(callee.expression) &&
        childNamespaces.has(callee.expression.text) &&
        CHILD_FNS.has(callee.name.text)
      );
    }
    return false;
  };
  const isPromisify = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && callee.text === 'promisify') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify');

  // First pass: bindings.
  const bind = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause !== undefined && isChildProcessModule(node.moduleSpecifier.text)) {
        if (clause.name !== undefined) childNamespaces.add(clause.name.text);
        const nb = clause.namedBindings;
        if (nb !== undefined && ts.isNamespaceImport(nb)) childNamespaces.add(nb.name.text);
        if (nb !== undefined && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (CHILD_FNS.has(imported)) childFns.add(el.name.text);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      const s = literal(init);
      if (s !== null) constStrings.set(node.name.text, s);
      if (ts.isCallExpression(init) && isPromisify(init.expression)) {
        const arg = init.arguments[0];
        if (arg !== undefined && isChildCallee(arg)) childFns.add(node.name.text);
        if (
          arg !== undefined &&
          ts.isPropertyAccessExpression(arg) &&
          ts.isIdentifier(arg.expression) &&
          childNamespaces.has(arg.expression.text)
        ) {
          childFns.add(node.name.text);
        }
      }
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'require'
      ) {
        const spec = literal(init.arguments[0]);
        if (spec !== null && isChildProcessModule(spec)) childNamespaces.add(node.name.text);
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);

  const checkSpawn = (call: ts.CallExpression): void => {
    const [cmdArg, argsArg] = call.arguments;
    const isExecPath =
      cmdArg !== undefined &&
      ts.isPropertyAccessExpression(cmdArg) &&
      ts.isIdentifier(cmdArg.expression) &&
      cmdArg.expression.text === 'process' &&
      cmdArg.name.text === 'execPath';
    if (isExecPath) return add(call, 'spawn node');
    const cmd = literal(cmdArg);
    if (cmd === null) return add(call, 'spawn <unresolved>');
    const base = cmd.split(/[\\/]/).pop() ?? cmd;
    const first = base.trim().split(/\s+/)[0] ?? '';
    if (TOOLS.test(first))
      return add(call, `spawn ${first.toLowerCase().replace(/\.(cmd|exe)$/, '')}`);
    // `exec` and `execSync` take a shell string; a shell run with `-c` takes one as an argument.
    if (TOOL_WORD.test(cmd)) return add(call, 'spawn shell command with a fetch tool');
    if (SHELLS.test(first) && argsArg !== undefined && ts.isArrayLiteralExpression(argsArg)) {
      for (const el of argsArg.elements) {
        const s = literal(el);
        if (s !== null && TOOL_WORD.test(s))
          return add(call, 'spawn shell command with a fetch tool');
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      const label = netModuleLabel(node.moduleSpecifier.text);
      if (label !== null && !typeOnly) add(node, label);
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const label = netModuleLabel(node.moduleSpecifier.text);
      if (label !== null) add(node, label);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require')
      ) {
        const spec = literal(node.arguments[0]);
        const label = spec === null ? null : netModuleLabel(spec);
        if (label !== null) add(node, label);
      }
      if (ts.isIdentifier(callee) && callee.text === 'fetch') add(node, 'call fetch');
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'fetch' &&
        ts.isIdentifier(callee.expression) &&
        GLOBALS.has(callee.expression.text)
      ) {
        add(node, 'call fetch');
      }
      if (isChildCallee(callee)) checkSpawn(node);
    }
    if (ts.isIdentifier(node) && BROWSER_NET.has(node.text)) {
      const p = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(p) && p.name === node;
      if (!isPropertyName) add(node, `use ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
