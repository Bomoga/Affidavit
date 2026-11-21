// Test tooling: a static egress LINT over the host code in packages/sandbox/src and
// packages/judge/src (GUARD_ROOTS). Imported only by egress-guard.test.ts and never exported from
// the package index, so the TypeScript compiler (a root devDependency) is never loaded at run
// time. It is not scanned itself.
//
// What it is and is not: a lint that raises the cost of a mistake, and of slipping a network call
// past review, in Lane 2 host code. It is NOT a security boundary. A determined author
// can always write code a static check does not understand. The runtime boundary is gVisor with
// `--network none` (or an internal-only case network) and no egress for anything the Judge or an
// agent runs; the dependency bundle build is a human-run host step outside `src/`.
//
// Five reviewed exceptions have network on purpose, by design, and are human-review items for the
// lead (an egress and supply-chain decision on the host, not a jail matter). Each is a named
// `networkByDesign` entry in EGRESS_ALLOWLIST:
// - `pinImage` (boot/images.ts) runs `docker pull` against Docker Hub on the host to pin an image
//   by digest. That includes target-named compose sidecar images (boot/boot.ts calls it per
//   sidecar), so a target's compose file chooses which public images the host pulls.
// - `pullPinned` (boot/images.ts) runs `docker pull` against Docker Hub for a digest-pinned ref.
// - The plain-Docker containment baseline (containment/plain-docker.ts) runs a probe container on
//   Docker's default bridge, which has a route out, as the comparison case for the jail.
// - `buildPatchApplyImage` (judge jail/workbench.ts) runs `docker build` on the host with network:
//   the patch-apply Dockerfile installs a pinned `git` package with `apk add`.
// - `buildRunnerImage` (judge jail/harness.ts) runs `docker build` on the host with network: the
//   witness-runner Dockerfile runs `npm ci` from its lockfile. Both images then run with none.
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
  /** The name of the enclosing function, when there is one. */
  within?: string;
}

/**
 * A reviewed exception: one finding at one call site, with why it is acceptable. It covers at most
 * `count` (default 1) findings with this label in this file, and only inside the function `within`
 * when that is set, so a second call site with the same label is a finding.
 */
export interface EgressAllow {
  file: string;
  what: string;
  reason: string;
  within?: string;
  count?: number;
  /** A short name for an exception that has network on purpose (see the header). */
  name?: string;
  /** True for the exceptions that reach a network by design: human-review items for the lead. */
  networkByDesign?: true;
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
 * The only files that may import `child_process`, by named import of its spawn functions. Paths
 * are relative to a scan root, with that root's prefix (`judge:` for packages/judge/src). In these files the executable must be a string literal from `ALLOWED_EXECUTABLES`.
 */
export const CHILD_PROCESS_FILES: readonly string[] = [
  'boot/build.ts',
  'boot/compose.ts',
  'boot/images.ts',
  'containment/plain-docker.ts',
  'containment/record.ts',
  'gvisor/network.ts',
  'gvisor/runner.ts',
  'judge:jail/harness.ts',
  'judge:jail/workbench.ts',
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
    within: 'pinImage',
    name: 'pinImage pulls from Docker Hub',
    networkByDesign: true,
    reason:
      'NETWORK BY DESIGN, a human-review item for the lead: the Docker daemon pulls from Docker Hub on the host to pin an image by digest, both the official `node` base and target-named compose sidecar images (boot.ts calls pinImage per sidecar). No container runs and nothing the target, the Judge or an agent runs reaches this, but pulling target-named images from a public registry is an egress and supply-chain decision on the host, not a jail matter',
  },
  {
    file: 'boot/images.ts',
    what: 'docker pull',
    within: 'pullPinned',
    name: 'pullPinned pulls from Docker Hub',
    networkByDesign: true,
    reason:
      'NETWORK BY DESIGN, a human-review item for the lead: the Docker daemon pulls from Docker Hub on the host an image already pinned by digest (`name:tag@sha256:...`, checked before the call). No container runs, but it is a host pull from a public registry',
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
    name: 'plain-Docker baseline on the default bridge',
    networkByDesign: true,
    reason:
      "NETWORK BY DESIGN, a human-review item for the lead: the plain-Docker containment baseline runs a probe container on Docker's default bridge, which has a route out, as the comparison case for the jail. It runs only in the containment suite (`pnpm containment`), never in a build, a boot or a trial",
  },
  {
    file: 'gvisor/runner.ts',
    what: 'args <const> args = buildGvisorRunArgs(...)',
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
  {
    file: 'judge:jail/workbench.ts',
    what: 'docker build without --network none',
    within: 'buildPatchApplyImage',
    name: 'patch-apply image built on the host with network',
    networkByDesign: true,
    reason:
      'NETWORK BY DESIGN, a human-review item for the lead: the patch-apply image is built on the host from docker/sandbox/patch-apply, a digest-pinned base plus a version-pinned `apk add git`, which needs the Alpine package mirror. The Judge then runs the image by ID with no network. A host build with network is an egress and supply-chain decision, not a jail matter',
  },
  {
    file: 'judge:jail/harness.ts',
    what: 'docker build without --network none',
    within: 'buildRunnerImage',
    name: 'witness-runner image built on the host with network',
    networkByDesign: true,
    reason:
      'NETWORK BY DESIGN, a human-review item for the lead: the witness-runner image is built on the host from docker/sandbox/witness-runner, a digest-pinned base plus `npm ci --ignore-scripts` from its committed lockfile, which needs the npm registry. The witness then runs in it with no network. A host build with network is an egress and supply-chain decision, not a jail matter',
  },
];

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where the guard scans, and the prefix its file keys carry (`judge:jail/harness.ts`). */
export const GUARD_ROOTS: readonly { prefix: string; dir: string }[] = [
  { prefix: '', dir: join(PACKAGES, 'sandbox', 'src') },
  { prefix: 'judge:', dir: join(PACKAGES, 'judge', 'src') },
];

/** Each package's declared runtime dependencies: the only npm packages its host code may import. */
const declaredDeps = (pkg: string): ReadonlySet<string> =>
  new Set(
    Object.keys(
      (
        JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        }
      ).dependencies ?? {},
    ),
  );
const DECLARED: Record<string, ReadonlySet<string>> = {
  '': declaredDeps('sandbox'),
  'judge:': declaredDeps('judge'),
};
/** Array methods that change an argv array in place. */
const MUTATORS = new Set([
  'push',
  'unshift',
  'splice',
  'pop',
  'shift',
  'fill',
  'copyWithin',
  'reverse',
  'sort',
]);
const BUILTINS = new Set(builtinModules);
/**
 * Declared packages host code may still not import. `dockerode` is declared but unused: a Docker API
 * client can set its own host, network mode and pulls, none of which this lint can see.
 */
const BANNED_PACKAGES: ReadonlySet<string> = new Set(['dockerode']);

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
/** Objects host code may use only as `x.member` or `typeof x`: never aliased or destructured. */
const HOST_OBJECTS = new Set(['process', 'Reflect', 'module']);
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
function moduleProblem(
  spec: string,
  sanctioned: boolean,
  declared: ReadonlySet<string>,
): string | null {
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
  if (BANNED_PACKAGES.has(name)) return `import ${name} (banned)`;
  return declared.has(name) ? null : `import ${name} (not a declared dependency)`;
}

const plainString = (n: ts.Node | undefined): string | null =>
  n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    ? n.text
    : null;

/** Unwraps `(x)`, `x as T`, `<T>x` and `x satisfies T`. */
const strip = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x)
  ) {
    x = x.expression;
  }
  return x;
};

const bindsName = (b: ts.BindingName, text: string): boolean =>
  ts.isIdentifier(b)
    ? b.text === text
    : b.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, text));

const declaresIn = (list: ts.ForInitializer | undefined, text: string): boolean =>
  list !== undefined &&
  ts.isVariableDeclarationList(list) &&
  list.declarations.some((d) => bindsName(d.name, text));

/**
 * The nearest declaration of `id` in scope: a `const` declaration bound to that plain name, 'other'
 * for a parameter, `let`, `var`, destructuring, function, class or loop variable, or undefined.
 */
function declarationOf(id: ts.Identifier): ts.VariableDeclaration | 'other' | undefined {
  const text = id.text;
  for (let n: ts.Node = id.parent; ; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, text))) return 'other';
    if (
      (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      declaresIn(n.initializer, text)
    ) {
      return 'other';
    }
    if (ts.isCatchClause(n) && n.variableDeclaration !== undefined) {
      if (bindsName(n.variableDeclaration.name, text)) return 'other';
    }
    const statements =
      ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseOrDefaultClause(n)
        ? n.statements
        : undefined;
    for (const st of statements ?? []) {
      if (ts.isVariableStatement(st)) {
        const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const d of st.declarationList.declarations) {
          if (!bindsName(d.name, text)) continue;
          return isConst && ts.isIdentifier(d.name) ? d : 'other';
        }
      } else if (
        (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
        st.name?.text === text
      ) {
        return 'other';
      }
    }
    if (ts.isSourceFile(n)) return undefined;
  }
}

/** The name of the function enclosing `node`, when it has one. */
function enclosingName(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined) {
      return n.name.getText();
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return undefined;
}

/** One argv element: its node and its text when it is a plain string literal. */
interface ArgWord {
  node: ts.Node;
  word: string | null;
}

/**
 * Parses one file with the TypeScript compiler and reports, allowlist style:
 *
 * - a runtime import, re-export, `import()` or `require()` of anything but a relative path, a
 *   built-in in `ALLOWED_BUILTINS` (plus `child_process` in `CHILD_PROCESS_FILES`), or a package
 *   in the scanned package's `dependencies`; a module name that is not a plain string literal;
 *   any `.require` member access (`module.require`, `process.mainModule.require`, `x['require']`);
 * - any value reference to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval` or
 *   `Function`; any reference to `globalThis`, `window`, `self` or `global` other than `typeof`;
 *   `process.binding`, `process.dlopen`, `process.getBuiltinModule` (dot or bracket) and computed
 *   access on `process`; `Reflect.get`, `Reflect.apply`, `Reflect.construct`; any use of
 *   `process`, `Reflect`, `module` or `require` other than `x.member`, `typeof x` or (for
 *   `require`) a direct call, so destructuring or aliasing one is a finding;
 * - `dockerode`, although declared;
 * - in the sanctioned files, a spawn whose executable is not a literal in `ALLOWED_EXECUTABLES`;
 *   whose argv is not an inline array literal or a `const` array literal in scope in the same file,
 *   so a variable of unknown origin is a finding. Spreads of other such `const` arrays are
 *   followed; any other spread is a finding. An element that names a same-file `const` string
 *   literal is checked as that string; an element naming nothing declared in the file is a
 *   finding; other elements are typed values and not checked. Any in-place change to a `const`
 *   argv array (`push`, `unshift`, `splice` and the other mutating methods, an index or `length`
 *   assignment, `delete`, `++`/`--`) is a finding. Then: a package-manager or fetch-tool word, a
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
  const used = new Map<EgressAllow, number>();
  const add = (node: ts.Node, what: string): void => {
    const within = enclosingName(node);
    const entry = allow.find(
      (a) =>
        a.file === file &&
        a.what === what &&
        (a.within === undefined || a.within === within) &&
        (used.get(a) ?? 0) < (a.count ?? 1),
    );
    if (entry !== undefined) {
      used.set(entry, (used.get(entry) ?? 0) + 1);
      return;
    }
    findings.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      what,
      ...(within === undefined ? {} : { within }),
    });
  };
  const src = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').slice(0, 80);
  const sanctioned = CHILD_PROCESS_FILES.includes(file);
  const declared = DECLARED[file.startsWith('judge:') ? 'judge:' : ''] ?? new Set<string>();

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

  /** True when `e` is written to: assigned, `++`/`--`, or deleted. */
  const isWritten = (e: ts.Expression): boolean => {
    const p = e.parent;
    return (
      (ts.isBinaryExpression(p) &&
        p.left === e &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
        (p.operator === ts.SyntaxKind.PlusPlusToken ||
          p.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ts.isDeleteExpression(p)
    );
  };

  /** Reports every in-place change to the `const` argv array `d` anywhere in the file. */
  const checked = new Set<ts.VariableDeclaration>();
  const checkMutation = (d: ts.VariableDeclaration): void => {
    if (checked.has(d) || !ts.isIdentifier(d.name)) return;
    checked.add(d);
    const name = d.name.text;
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === name && n !== d.name && declarationOf(n) === d) {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === n) {
          if (MUTATORS.has(p.name.text)) add(p, `args mutation ${name}.${p.name.text}`);
          else if (isWritten(p)) add(p, `args mutation ${name}.${p.name.text} =`);
        }
        if (ts.isElementAccessExpression(p) && p.expression === n) {
          const key = plainString(p.argumentExpression);
          if (key !== null && MUTATORS.has(key)) add(p, `args mutation ${name}.${key}`);
          else if (isWritten(p)) add(p, `args mutation ${name}[...] =`);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  };

  /** The `const` declaration of an array literal `id` names in scope, or undefined. */
  const constArray = (id: ts.Identifier): ts.VariableDeclaration | undefined => {
    const d = declarationOf(id);
    if (d === undefined || d === 'other' || d.initializer === undefined) return undefined;
    return ts.isArrayLiteralExpression(strip(d.initializer)) ? d : undefined;
  };

  /** One non-spread argv element: a literal, a same-file `const` string, or a typed value. */
  const elementOf = (el: ts.Expression): ArgWord => {
    const e = strip(el);
    if (!ts.isIdentifier(e)) return { node: el, word: plainString(e) };
    const d = declarationOf(e);
    if (d === undefined) {
      add(el, `args unresolved identifier ${e.text}`);
      return { node: el, word: null };
    }
    if (d === 'other' || d.initializer === undefined) return { node: el, word: null };
    return { node: el, word: plainString(strip(d.initializer)) };
  };

  /**
   * The argv words of an inline array literal or a `const` array literal in scope, following
   * spreads of other `const` arrays. Anything else is a finding at `at`, and null is returned.
   */
  const argvOf = (expr: ts.Expression, at: ts.Node, seen: Set<ts.Node>): ArgWord[] | null => {
    const e = strip(expr);
    if (ts.isArrayLiteralExpression(e)) {
      if (seen.has(e)) {
        add(at, 'args cycle');
        return null;
      }
      seen.add(e);
      const out: ArgWord[] = [];
      for (const el of e.elements) {
        if (!ts.isSpreadElement(el)) {
          out.push(elementOf(el));
          continue;
        }
        const inner = strip(el.expression);
        const d = ts.isIdentifier(inner) ? constArray(inner) : undefined;
        if (d !== undefined) checkMutation(d);
        const arr = d?.initializer === undefined ? undefined : strip(d.initializer);
        const sub = arr === undefined ? null : argvOf(arr, el, seen);
        if (arr === undefined) add(el, `args spread ${src(el)}`);
        if (sub === null) out.push({ node: el, word: null });
        else out.push(...sub);
      }
      return out;
    }
    if (ts.isIdentifier(e)) {
      const d = declarationOf(e);
      if (d === undefined || d === 'other' || d.initializer === undefined) {
        add(at, `args <unknown origin> ${e.text}`);
        return null;
      }
      const init = strip(d.initializer);
      if (ts.isArrayLiteralExpression(init)) {
        checkMutation(d);
        return argvOf(init, at, seen);
      }
      const origin = ts.isCallExpression(init) ? `${src(init.expression)}(...)` : src(init);
      add(at, `args <const> ${e.text} = ${origin}`);
      return null;
    }
    add(at, `args <non-literal> ${src(e)}`);
    return null;
  };

  const checkDocker = (call: ts.CallExpression, argv: ArgWord[]): void => {
    const words = argv.map((a) => a.word);
    // Anchor at the call unless the first word is inline, so `within` names the calling function.
    const first0 = argv[0]?.node;
    const inline = first0 !== undefined && first0.pos >= call.pos && first0.end <= call.end;
    const at: ts.Node = inline ? first0 : call;
    const sub = words[0];
    if (sub === null || sub === undefined) {
      const first = argv[0];
      add(at, `docker subcommand <non-literal> ${first === undefined ? '' : src(first.node)}`);
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

  const checkTar = (argv: ArgWord[]): void => {
    for (const { node, word: w } of argv) {
      if (w === null || !w.startsWith('-')) continue;
      if (TAR_SHORT.test(w) || TAR_LONG.has(w)) continue;
      add(node, `tar flag ${w.split('=')[0] ?? w}`);
    }
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
    const argv = argvOf(argsArg, call, new Set());
    if (argv === null) return;
    const words = argv.map((a) => a.word);
    argv.forEach(({ node: el, word: s }, i) => {
      if (s === null) return;
      if (FORBIDDEN_ARG.test(s) || TOOL_WORD.test(s)) add(el, `args word ${s}`);
      const eq = /^--net(work)?=(.*)$/.exec(s);
      if (eq !== null && eq[2] !== 'none') add(el, `args --network ${eq[2]}`);
      if (s === '--network' || s === '--net') {
        const next = words[i + 1];
        if (next !== 'none') add(el, `args --network ${next ?? '<non-literal>'}`);
      }
    });
    if (cmd === 'docker') checkDocker(call, argv);
    if (cmd === 'tar') checkTar(argv);
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
          const problem = moduleProblem(spec, sanctioned, declared);
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
          const problem = moduleProblem(spec, sanctioned, declared);
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
      // process, Reflect, module: only `x.member`, `x[...]` (checked below) or `typeof x`.
      const p = node.parent;
      if (
        HOST_OBJECTS.has(name) &&
        !ts.isTypeOfExpression(p) &&
        !(
          (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
          p.expression === node
        )
      ) {
        add(node, `alias of ${name}`);
      }
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
    // Any `.require` member: `module.require(...)`, `process.mainModule.require(...)`, `x['require']`.
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'require') ||
      (ts.isElementAccessExpression(node) && plainString(node.argumentExpression) === 'require')
    ) {
      add(node, 'use .require');
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
    // Renaming a banned name out of any object: `const { fetch: f } = x`. Destructuring process,
    // Reflect, module or require at all is caught above as an alias of that object.
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
