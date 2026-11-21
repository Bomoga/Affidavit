// Test tooling: a static egress guard over this package's own source. Imported only by
// egress-guard.test.ts and never exported from the package index, so the TypeScript compiler
// (a root devDependency) is never loaded at run time.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface EgressFinding {
  file: string;
  line: number;
  /** A short, stable label: `import node:https`, `use fetch`, `spawn npm`, ... */
  what: string;
}

/** A reviewed exception: one finding in one file, with why it does not reach the network. */
export interface EgressAllow {
  file: string;
  what: string;
  reason: string;
}

/**
 * The only files under `src/` that may import `child_process`, by named import of its spawn
 * functions. Everywhere else any reference to the module is a finding. In these files the
 * executable must be a string literal from `ALLOWED_EXECUTABLES`.
 */
export const CHILD_PROCESS_FILES: readonly string[] = [
  'boot/build.ts',
  'boot/compose.ts',
  'boot/images.ts',
  'containment/plain-docker.ts',
  'containment/record.ts',
  'gvisor/network.ts',
  'gvisor/runner.ts',
];

/** Executables a sanctioned file may run on the host. git, npm and every fetch tool are not here. */
export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(['docker', 'tar']);

export const EGRESS_ALLOWLIST: readonly EgressAllow[] = [
  {
    file: 'containment/host.ts',
    what: 'import node:http',
    reason:
      'createServer only: the containment suite listens as a fake orchestrator to prove the jail cannot reach it; nothing connects out',
  },
  {
    file: 'boot/compose.ts',
    what: 'spawn <non-literal executable> inv.bin',
    reason:
      'the Compose v2 binary from a fixed absolute path (COMPOSE_BIN_PATHS or AFFIDAVIT_COMPOSE_BIN), run with an empty config directory; it normalizes a file and fetches nothing',
  },
  {
    file: 'boot/compose.ts',
    what: 'args <non-literal> inv.args',
    reason:
      'composeConfigInvocation builds `config --format json --no-interpolate` plus fixed paths; tested in compose.test.ts',
  },
  {
    file: 'boot/build.ts',
    what: 'args <non-literal> assembleBuildArgs(dockerfile, tree, iid)',
    reason:
      '`docker build --network none` with no build args, proxy, secret or host flag; asserted in bundle-build.test.ts (assembleBuildArgs)',
  },
  {
    file: 'containment/plain-docker.ts',
    what: 'args <non-literal> buildProbeDockerArgs(name, JSON.stringify(req.args))',
    reason:
      'the plain-Docker containment baseline: a probe container on the default bridge, by design the comparison case; runs only in the containment suite, never in a build or a trial',
  },
  {
    file: 'gvisor/runner.ts',
    what: 'args <non-literal> args',
    reason:
      'buildGvisorRunArgs output: runsc, `--network none` or an internal case network, refusing unknown spec keys; tested in args.test.ts',
  },
  {
    file: 'gvisor/network.ts',
    what: 'args spread ...args.slice(1)',
    reason:
      'buildGvisorRunArgs output for a sidecar on the internal case network (no route out); tested in args.test.ts',
  },
  {
    file: 'gvisor/network.ts',
    what: 'args spread ...ids',
    reason:
      'container IDs printed by `docker ps --quiet` for this run label, passed to `docker rm`',
  },
  {
    file: 'gvisor/network.ts',
    what: 'args spread ...command',
    reason:
      'a sidecar readiness probe run with `docker exec` inside a sidecar on the internal case network, which has no route out',
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
  'module',
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
const NET_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);
/** argv words a docker (or tar) call made from src/ may never carry. */
const FORBIDDEN_ARG = /^(npm|npx|pnpm|yarn|install|ci|node-gyp|curl|wget|git)$/i;
const TOOL_WORD = /(^|[\s;&|/`'"(])(npm|npx|pnpm|yarn|node-gyp|curl|wget|git)(?=$|[\s;&|'"`)])/i;

/** File extensions the guard scans, and how each is parsed. */
const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};
const extOf = (name: string): string => /\.[cm]?[jt]sx?$/.exec(name)?.[0] ?? '';

/** Test files and test-only helpers, which the guard does not scan. */
const isTestFile = (name: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /^(testkit|testutil|test-helpers)\./.test(name);

/** Every file under `dir` the guard scans: all JS and TS sources, not tests or test helpers. */
export function guardedSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...guardedSourceFiles(p));
    else if (e.isFile() && SCRIPT_KINDS[extOf(e.name)] !== undefined && !isTestFile(e.name)) {
      out.push(p);
    }
  }
  return out;
}

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

const plainString = (n: ts.Node | undefined): string | null =>
  n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    ? n.text
    : null;

/**
 * Parses one file with the TypeScript compiler (no regex over raw text) and fails closed:
 *
 * - a module name that is not a plain string literal (`import()`, `require()`), any use of
 *   `createRequire` or `node:module`, and any import of a network module or `undici`;
 * - any reference to `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource`, bare, through a
 *   global object (dot or bracket), aliased or through `.call`/`.apply`/`.bind`, and any bracket
 *   access on a global object with a computed key;
 * - `child_process` outside `CHILD_PROCESS_FILES`, and inside them anything but a named import
 *   of a spawn function called directly (or through `promisify`) with a string-literal executable
 *   from `ALLOWED_EXECUTABLES` and an array-literal argv with no spread, no package-manager or
 *   fetch-tool word, and no `--network` other than `none`.
 *
 * Text inside string literals and templates (scripts that run in the jail) is data, not code.
 */
export function findEgress(
  file: string,
  text: string,
  allow: readonly EgressAllow[] = EGRESS_ALLOWLIST,
): EgressFinding[] {
  const kind = SCRIPT_KINDS[extOf(file)] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const findings: EgressFinding[] = [];
  const add = (node: ts.Node, what: string): void => {
    if (allow.some((a) => a.file === file && a.what === what)) return;
    findings.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      what,
    });
  };
  const src = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').slice(0, 80);
  const sanctioned = CHILD_PROCESS_FILES.includes(file);

  // Local names bound to child_process spawn functions (named imports, and promisify of one).
  const childFns = new Set<string>();
  const childImportNames = new Set<ts.Node>();
  const promisifyArgs = new Set<ts.Node>();
  const isPromisify = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && callee.text === 'promisify') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify');

  const bind = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && plainString(node.moduleSpecifier) !== null) {
      const spec = plainString(node.moduleSpecifier) as string;
      const clause = node.importClause;
      if (isChildProcessModule(spec) && clause !== undefined && !clause.isTypeOnly) {
        const nb = clause.namedBindings;
        if (sanctioned && clause.name === undefined && nb !== undefined && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (el.isTypeOnly) continue;
            if (CHILD_FNS.has(imported)) {
              childFns.add(el.name.text);
              childImportNames.add(el.name);
            } else add(el, `child_process import ${imported}`);
          }
        } else if (sanctioned) {
          add(node, 'child_process import not by named spawn functions');
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      isPromisify(node.initializer.expression)
    ) {
      const arg = node.initializer.arguments[0];
      if (arg !== undefined && ts.isIdentifier(arg) && childFns.has(arg.text)) {
        childFns.add(node.name.text);
        promisifyArgs.add(arg);
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);

  const checkSpawn = (call: ts.CallExpression): void => {
    const [cmdArg, argsArg] = call.arguments;
    const cmd = plainString(cmdArg);
    if (cmd === null) {
      add(call, `spawn <non-literal executable> ${cmdArg === undefined ? '' : src(cmdArg)}`);
    } else if (!ALLOWED_EXECUTABLES.has(cmd)) {
      add(call, `spawn ${cmd}`);
    }
    if (argsArg === undefined) return;
    if (!ts.isArrayLiteralExpression(argsArg)) {
      add(call, `args <non-literal> ${src(argsArg)}`);
      return;
    }
    const els = argsArg.elements;
    els.forEach((el, i) => {
      if (ts.isSpreadElement(el)) return add(el, `args spread ${src(el)}`);
      const s = plainString(el);
      if (s === null) return;
      if (FORBIDDEN_ARG.test(s) || TOOL_WORD.test(s)) add(el, `args word ${s}`);
      const eq = /^--net(work)?=(.*)$/.exec(s);
      if (eq !== null && eq[2] !== 'none') add(el, `args --network ${eq[2]}`);
      if (s === '--network' || s === '--net') {
        const next = plainString(els[i + 1]);
        if (next !== 'none') add(el, `args --network ${next ?? '<non-literal>'}`);
      }
    });
  };

  const isNameOnly = (node: ts.Identifier): boolean => {
    const p = node.parent;
    return (
      (ts.isPropertyAccessExpression(p) && p.name === node) ||
      (ts.isPropertyAssignment(p) && p.name === node) ||
      (ts.isMethodDeclaration(p) && p.name === node) ||
      (ts.isPropertyDeclaration(p) && p.name === node) ||
      (ts.isPropertySignature(p) && p.name === node) ||
      (ts.isMethodSignature(p) && p.name === node) ||
      (ts.isGetAccessor(p) && p.name === node) ||
      (ts.isSetAccessor(p) && p.name === node) ||
      (ts.isBindingElement(p) && p.propertyName === node && p.name !== node) ||
      ts.isQualifiedName(p) ||
      ts.isTypeReferenceNode(p) ||
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p)
    );
  };

  const visit = (node: ts.Node): void => {
    // Static imports and re-exports.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specNode = node.moduleSpecifier;
      const spec = plainString(specNode);
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const typeOnly = ts.isImportDeclaration(node)
        ? clause !== undefined &&
          (clause.isTypeOnly ||
            (clause.name === undefined &&
              clause.namedBindings !== undefined &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.length > 0 &&
              clause.namedBindings.elements.every((e) => e.isTypeOnly)))
        : node.isTypeOnly;
      if (spec !== null && !typeOnly) {
        const label = netModuleLabel(spec);
        if (label !== null) add(node, label);
        if (isChildProcessModule(spec)) {
          if (ts.isExportDeclaration(node)) add(node, 'child_process re-export');
          else if (!sanctioned) add(node, 'import child_process outside the sanctioned files');
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)) add(node, 'import = require');

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isImport || isRequire) {
        const spec = plainString(node.arguments[0]);
        const how = isImport ? 'import()' : 'require()';
        if (spec === null) add(node, `${how} of a non-literal module name`);
        else {
          const label = netModuleLabel(spec);
          if (label !== null) add(node, label);
          if (isChildProcessModule(spec)) add(node, `${how} of child_process`);
        }
      }
      if (ts.isIdentifier(callee) && childFns.has(callee.text)) checkSpawn(node);
    }

    if (ts.isIdentifier(node)) {
      if (node.text === 'createRequire' && !ts.isPropertyAccessExpression(node.parent)) {
        add(node, 'use createRequire');
      }
      if (NET_GLOBALS.has(node.text) && !isNameOnly(node)) add(node, `use ${node.text}`);
      // A spawn function referenced other than as a direct call (an alias, `.call`, an argument).
      if (
        childFns.has(node.text) &&
        !childImportNames.has(node) &&
        !promisifyArgs.has(node) &&
        !isNameOnly(node) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      ) {
        add(node, `alias of ${node.text}`);
      }
    }
    // Network globals through a global object: `globalThis.fetch`, `self.WebSocket`.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBALS.has(node.expression.text) &&
      (NET_GLOBALS.has(node.name.text) || node.name.text === 'require')
    ) {
      add(node, `use ${node.name.text}`);
    }
    // Bracket access on a global object: a network name, or any computed key (fail closed).
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBALS.has(node.expression.text)
    ) {
      const key = plainString(node.argumentExpression);
      if (key === null) add(node, `computed access on ${node.expression.text}`);
      else if (NET_GLOBALS.has(key) || key === 'require') add(node, `use ${key}`);
    }
    // Destructuring a network name off any object: `const { fetch } = globalThis`.
    if (ts.isBindingElement(node)) {
      const prop = node.propertyName ?? node.name;
      const name = ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : null;
      if (name !== null && NET_GLOBALS.has(name) && node.propertyName !== undefined) {
        add(node, `use ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
