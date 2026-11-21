// Test tooling: a static egress LINT over this package's own source. Imported only by
// egress-guard.test.ts and never exported from the package index, so the TypeScript compiler
// (a root devDependency) is never loaded at run time. It is not scanned itself.
//
// What it is and is not: a lint that raises the cost of a mistake, and of slipping a network call
// past review, in this package's host code. It is NOT a security boundary. A determined author
// can always write code a static check does not understand. The runtime boundary is gVisor with
// `--network none` (or an internal-only case network) and no egress for anything the Judge or an
// agent runs; the dependency bundle build is a human-run host step outside `src/`.
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface EgressFinding {
  file: string;
  line: number;
  /** A short, stable label: `import node:https`, `use fetch`, `docker pull`, ... */
  what: string;
}

/** A reviewed exception: one finding in one file, with why it does not reach the network. */
export interface EgressAllow {
  file: string;
  what: string;
  reason: string;
}

/**
 * Node built-in modules host code may import (allowlist). Anything else built in (`http`, `net`,
 * `vm`, `worker_threads`, `inspector`, `module`, ...) is a finding.
 */
export const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  'fs',
  'fs/promises',
  'path',
  'crypto',
  'stream',
  'stream/promises',
  'zlib',
  'os',
  'url',
  'util',
  'events',
  'buffer',
  'string_decoder',
  'assert',
]);

/**
 * The only files under `src/` that may import `child_process`, by named import of its spawn
 * functions. In these files the executable must be a string literal from `ALLOWED_EXECUTABLES`.
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

/** docker subcommands a sanctioned file may use; `image`, `network`, `volume` take a second word. */
const DOCKER_SUBCOMMANDS = new Set([
  'build',
  'run',
  'create',
  'start',
  'stop',
  'rm',
  'rmi',
  'inspect',
  'kill',
  'ps',
  'wait',
  'logs',
  'image',
  'network',
  'volume',
]);
const DOCKER_SECOND: Record<string, ReadonlySet<string>> = {
  image: new Set(['inspect', 'rm', 'ls']),
  network: new Set(['create', 'rm', 'inspect', 'ls']),
  volume: new Set(['inspect', 'rm', 'ls']),
};
/** Subcommands that start a container or a build: they must say `--network none`. */
const NEEDS_NETWORK_NONE = new Set(['build', 'run', 'create']);

/** tar flags a sanctioned file may pass: short clusters of x c t f z v, -C, and two long flags. */
const TAR_SHORT = /^-[xctfzv]+$/;
const TAR_LONG = new Set(['-C', '--no-same-owner', '--no-same-permissions']);

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
    file: 'boot/images.ts',
    what: 'docker pull',
    reason:
      'the Docker daemon pulls an official `node` base or a compose sidecar image on the host to pin it by digest (boot-recipes.md, Base); nothing the target, the Judge or an agent runs reaches this, and no container runs',
  },
  {
    file: 'containment/plain-docker.ts',
    what: 'import @affidavit/testing (not a declared dependency)',
    reason:
      'a workspace devDependency: the Phase 1 docker run flags (`buildDockerRunArgs`) for the plain-Docker baseline of the containment suite, which never runs in a build or a trial',
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
    what: "docker subcommand <non-literal> args[0] ?? 'run'",
    reason:
      'buildGvisorRunArgs output (`run` plus runsc flags) for a sidecar on the internal case network (no route out); tested in args.test.ts',
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
    what: 'docker exec',
    reason:
      'a sidecar readiness probe (`docker exec` in a sidecar the case network created, internal, no route out)',
  },
  {
    file: 'gvisor/network.ts',
    what: 'args spread ...command',
    reason:
      'the sidecar readiness command from the compose recipe, run by `docker exec` inside that sidecar on the internal case network',
  },
];

/** The package's declared runtime dependencies: the only npm packages host code may import. */
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
const DECLARED: ReadonlySet<string> = new Set(
  Object.keys(
    (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { dependencies?: Record<string, string> })
      .dependencies ?? {},
  ),
);
const BUILTINS = new Set(builtinModules);

const CHILD_FNS = new Set([
  'exec',
  'execFile',
  'execSync',
  'execFileSync',
  'spawn',
  'spawnSync',
  'fork',
]);
/** Identifiers banned wherever they are referenced as values. */
const BANNED_NAMES = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'eval',
  'Function',
]);
/** Global objects: any reference but `typeof <name>` is a finding (so aliasing one is too). */
const GLOBAL_NAMES = new Set(['globalThis', 'window', 'self', 'global']);
const PROCESS_BANNED = new Set(['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule']);
const REFLECT_BANNED = new Set(['get', 'apply', 'construct']);
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
  '.jsx': ts.ScriptKind.JSX,
};
const extOf = (name: string): string => /\.[cm]?[jt]sx?$/.exec(name)?.[0] ?? '';

/** Test files, test-only helpers and this lint itself, which the guard does not scan. */
const isTestFile = (name: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
  /^(testkit|testutil|test-helpers)\./.test(name) ||
  name === 'egress-guard.ts';

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

const packageName = (spec: string): string => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
};

/** Null when host code in `file` may import `spec` (allowlist), else the finding label. */
function moduleProblem(spec: string, sanctioned: boolean): string | null {
  if (spec.startsWith('./') || spec.startsWith('../')) return null;
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  if (spec.startsWith('node:') || BUILTINS.has(bare)) {
    if (ALLOWED_BUILTINS.has(bare)) return null;
    if (bare === 'child_process') {
      return sanctioned ? null : 'import child_process outside the sanctioned files';
    }
    return `import node:${bare}`;
  }
  const name = packageName(spec);
  return DECLARED.has(name) ? null : `import ${name} (not a declared dependency)`;
}

const plainString = (n: ts.Node | undefined): string | null =>
  n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    ? n.text
    : null;

/**
 * Parses one file with the TypeScript compiler and reports, allowlist style:
 *
 * - a runtime import, re-export, `import()` or `require()` of anything but a relative path, a
 *   built-in in `ALLOWED_BUILTINS` (plus `child_process` in `CHILD_PROCESS_FILES`), or a package
 *   in this package's `dependencies`; a module name that is not a plain string literal;
 * - any value reference to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval` or
 *   `Function`; any reference to `globalThis`, `window`, `self` or `global` other than `typeof`;
 *   `process.binding`, `process.dlopen`, `process.getBuiltinModule` (dot, bracket, destructured)
 *   and computed access on `process`; `Reflect.get`, `Reflect.apply`, `Reflect.construct`;
 * - in the sanctioned files, a spawn whose executable is not a literal in `ALLOWED_EXECUTABLES`,
 *   whose argv is not an array literal or has a spread, a package-manager or fetch-tool word, a
 *   docker subcommand outside the allowlist (no `pull`, `exec`, `cp`, `push`), a docker `build`,
 *   `run` or `create` without `--network none`, a `network create` without `--internal`, or a tar
 *   flag outside the allowlist (no `--to-command`, `-I`, `--use-compress-program`,
 *   `--checkpoint-action`, `-T`, `--files-from`).
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
      const isChild = spec === 'child_process' || spec === 'node:child_process';
      if (isChild && sanctioned && clause !== undefined && !clause.isTypeOnly) {
        const nb = clause.namedBindings;
        if (clause.name === undefined && nb !== undefined && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (el.isTypeOnly) continue;
            if (CHILD_FNS.has(imported)) {
              childFns.add(el.name.text);
              childImportNames.add(el.name);
            } else add(el, `child_process import ${imported}`);
          }
        } else {
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

  const checkDocker = (
    call: ts.CallExpression,
    els: ts.NodeArray<ts.Expression>,
    words: (string | null)[],
  ): void => {
    const at: ts.Node = els[0] ?? call;
    const sub = words[0];
    if (sub === null || sub === undefined) {
      const first = els[0];
      add(at, `docker subcommand <non-literal> ${first === undefined ? '' : src(first)}`);
      return;
    }
    if (!DOCKER_SUBCOMMANDS.has(sub)) return add(at, `docker ${sub}`);
    const second = DOCKER_SECOND[sub];
    if (second !== undefined) {
      const w = words[1];
      if (w === null || w === undefined || !second.has(w)) {
        return add(at, `docker ${sub} ${w ?? '<non-literal>'}`);
      }
      if (sub === 'network' && w === 'create' && !words.includes('--internal')) {
        add(at, 'docker network create without --internal');
      }
    }
    if (NEEDS_NETWORK_NONE.has(sub)) {
      const none = words.some(
        (s, i) =>
          s === '--network=none' ||
          s === '--net=none' ||
          ((s === '--network' || s === '--net') && words[i + 1] === 'none'),
      );
      if (!none) add(at, `docker ${sub} without --network none`);
    }
  };

  const checkTar = (els: ts.NodeArray<ts.Expression>, words: (string | null)[]): void => {
    words.forEach((w, i) => {
      if (w === null || !w.startsWith('-')) return;
      if (TAR_SHORT.test(w) || TAR_LONG.has(w)) return;
      add(els[i] as ts.Node, `tar flag ${w.split('=')[0] ?? w}`);
    });
  };

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
    const words = els.map((el) => plainString(el));
    els.forEach((el, i) => {
      if (ts.isSpreadElement(el)) return add(el, `args spread ${src(el)}`);
      const s = words[i];
      if (s === null || s === undefined) return;
      if (FORBIDDEN_ARG.test(s) || TOOL_WORD.test(s)) add(el, `args word ${s}`);
      const eq = /^--net(work)?=(.*)$/.exec(s);
      if (eq !== null && eq[2] !== 'none') add(el, `args --network ${eq[2]}`);
      if (s === '--network' || s === '--net') {
        const next = words[i + 1];
        if (next !== 'none') add(el, `args --network ${next ?? '<non-literal>'}`);
      }
    });
    if (cmd === 'docker') checkDocker(call, els, words);
    if (cmd === 'tar') checkTar(els, words);
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
      ts.isExpressionWithTypeArguments(p) ||
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p)
    );
  };

  const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
    const clause = node.importClause;
    return (
      clause !== undefined &&
      (clause.isTypeOnly ||
        (clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly)))
    );
  };

  const visit = (node: ts.Node): void => {
    // Static imports and re-exports: allowlist.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier === undefined ? null : plainString(node.moduleSpecifier);
      const typeOnly = ts.isImportDeclaration(node) ? isTypeOnlyImport(node) : node.isTypeOnly;
      if (node.moduleSpecifier !== undefined && spec === null) {
        add(node, 'import of a non-literal module name');
      } else if (spec !== null && !typeOnly) {
        if (
          ts.isExportDeclaration(node) &&
          (spec === 'child_process' || spec === 'node:child_process')
        ) {
          add(node, 'child_process re-export');
        } else {
          const problem = moduleProblem(spec, sanctioned);
          if (problem !== null) add(node, problem);
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
        else if (spec === 'child_process' || spec === 'node:child_process') {
          add(node, `${how} of child_process`);
        } else {
          const problem = moduleProblem(spec, sanctioned);
          if (problem !== null) add(node, problem);
        }
      }
      if (ts.isIdentifier(callee) && childFns.has(callee.text)) checkSpawn(node);
    }

    if (ts.isIdentifier(node) && !isNameOnly(node)) {
      const name = node.text;
      if (BANNED_NAMES.has(name)) add(node, `use ${name}`);
      if (GLOBAL_NAMES.has(name) && !ts.isTypeOfExpression(node.parent)) add(node, `use ${name}`);
      if (name === 'createRequire') add(node, 'use createRequire');
      if (
        name === 'require' &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        add(node, 'alias of require');
      }
      // A spawn function referenced other than as a direct call (an alias, `.call`, an argument).
      if (
        childFns.has(name) &&
        !childImportNames.has(node) &&
        !promisifyArgs.has(node) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      ) {
        add(node, `alias of ${name}`);
      }
    }
    // process.binding / dlopen / getBuiltinModule, Reflect.get / apply / construct.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const obj = node.expression.text;
      const prop = node.name.text;
      if (obj === 'process' && PROCESS_BANNED.has(prop)) add(node, `use process.${prop}`);
      if (obj === 'Reflect' && REFLECT_BANNED.has(prop)) add(node, `use Reflect.${prop}`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'process' || node.expression.text === 'Reflect')
    ) {
      const key = plainString(node.argumentExpression);
      if (key === null) add(node, `computed access on ${node.expression.text}`);
      else if (PROCESS_BANNED.has(key) || REFLECT_BANNED.has(key)) {
        add(node, `use ${node.expression.text}.${key}`);
      }
    }
    // Destructuring a banned name: `const { fetch: f } = x`, `const { binding } = process`.
    if (ts.isBindingElement(node)) {
      const prop = node.propertyName ?? node.name;
      const name = ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : null;
      if (
        name !== null &&
        (BANNED_NAMES.has(name) || PROCESS_BANNED.has(name) || REFLECT_BANNED.has(name)) &&
        node.propertyName !== undefined
      ) {
        add(node, `use ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
