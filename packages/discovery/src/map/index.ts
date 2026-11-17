/**
 * L1-05, the map. Reads the redacted workspace that ingestion produced and builds, with
 * tree-sitter, a route table (method, path, middleware chain, handler), the data-access calls
 * seen, and an approximate call graph from route entries to functions. `reachabilityFor` then
 * answers, per candidate, whether a route reaches the code the candidate points at.
 *
 * The workspace is untrusted data. Nothing in it is run, required or evaluated; comments never
 * leave the parser; every size, depth, count and time bound is a limit that is reported when hit.
 */
import type { RouteInfo } from '@affidavit/contracts';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Interpreter, type InterpOutput } from './engine.js';
import { grammarFor, initParser, parseSource, type Grammar } from './parse.js';
import { prepass, type FileFacts } from './prepass.js';
import { reachability, type ReachModel } from './reach.js';
import { buildRoutes, type FlatRoute } from './routes.js';
import {
  DEFAULT_MAP_LIMITS,
  type CandidateReachability,
  type DataAccessCall,
  type IncompleteFile,
  type IncompleteReason,
  type LimitHit,
  type MapCandidate,
  type MapCoverage,
  type MapLimits,
  type MapRoute,
  type ReachPath,
  type SkippedPath,
} from './types.js';

export {
  DEFAULT_MAP_LIMITS,
  type CandidateReachability,
  type ChainItem,
  type DataAccessCall,
  type DataAccessKind,
  type FnRef,
  type IncompleteFile,
  type IncompleteReason,
  type Leak,
  type LeakKind,
  type LimitHit,
  type MapCandidate,
  type MapCoverage,
  type MapLimits,
  type MapRoute,
  type ReachPath,
  type ReachReason,
  type RouteMount,
  type SkippedPath,
  type MapSkipReason,
} from './types.js';

/** The contract's `RouteInfo` for one reaching path (what `CaseFile.route` carries). */
export function routeInfoOf(p: ReachPath): RouteInfo {
  return {
    method: p.method,
    path: p.path,
    handlerFile: p.handlerFile,
    middleware: p.middleware,
    authRequired: p.authRequired,
  };
}

export interface MapOptions {
  /** The redacted workspace root (an absolute path). Nothing outside it is read. */
  root: string;
  limits?: Partial<MapLimits>;
}

export interface RepoMap {
  routes: MapRoute[];
  dataAccess: DataAccessCall[];
  coverage: MapCoverage;
}

interface Model extends ReachModel {
  flat: FlatRoute[];
}

const models = new WeakMap<RepoMap, Model>();

function publicRoute(r: FlatRoute): MapRoute {
  const { route, appMiddleware, chain, handlerLabel, pathDynamic, mounted, file, line } = r;
  const out: MapRoute = {
    route,
    appMiddleware,
    chain,
    handlerLabel,
    pathDynamic,
    mounted,
    file,
    line,
  };
  if (r.handler) out.handler = r.handler;
  return out;
}

/**
 * Directories never read. `affectsCompleteness` says whether skipping them can leave a route or
 * a handler unseen: dependencies and vendored code are third party, build output may not be.
 */
const EXCLUDED_DIRS = new Map<string, boolean>([
  ['node_modules', false],
  ['.git', false],
  ['bower_components', false],
  ['vendor', false],
  ['third_party', false],
  ['coverage', false],
  ['.cache', false],
  ['dist', true],
  ['build', true],
  ['.next', true],
  ['.nuxt', true],
  ['out', true],
]);

interface SourceEntry {
  path: string;
  abs: string;
  grammar: Grammar;
}

async function collect(
  root: string,
  limits: MapLimits,
  skipped: SkippedPath[],
): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    let entries;
    try {
      entries = await readdir(join(root, cur.rel), { withFileTypes: true });
    } catch {
      skipped.push({ path: cur.rel || '.', reason: 'unreadable', affectsCompleteness: true });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: { rel: string; depth: number }[] = [];
    for (const e of entries) {
      const rel = cur.rel ? posix.join(cur.rel, e.name) : e.name;
      if (e.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'symlink', affectsCompleteness: true });
      } else if (e.isDirectory()) {
        const excluded = EXCLUDED_DIRS.get(e.name);
        if (excluded !== undefined) {
          skipped.push({ path: rel, reason: 'excluded-directory', affectsCompleteness: excluded });
        } else if (cur.depth + 1 > limits.maxDirDepth) {
          skipped.push({ path: rel, reason: 'directory-too-deep', affectsCompleteness: true });
        } else {
          subdirs.push({ rel, depth: cur.depth + 1 });
        }
      } else if (e.isFile()) {
        const grammar = grammarFor(e.name);
        if (!grammar) continue;
        if (/\.d\.[cm]?ts$/.test(e.name)) {
          skipped.push({ path: rel, reason: 'declaration-file', affectsCompleteness: false });
        } else if (/\.min\.[cm]?js$/.test(e.name)) {
          // Not read (a bundle is not worth the budget), but it may hold first-party code, so
          // skipping it counts against completeness.
          skipped.push({ path: rel, reason: 'minified', affectsCompleteness: true });
        } else if (out.length >= limits.maxFiles) {
          skipped.push({ path: rel, reason: 'too-many-files', affectsCompleteness: true });
        } else {
          out.push({ path: rel, abs: join(root, rel), grammar });
        }
      }
    }
    // Depth-first in sorted order: push in reverse so the first directory is walked first.
    for (const s of subdirs.reverse()) stack.push(s);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Builds the map for a workspace. Never throws on hostile input: a file that cannot be read or
 * parsed is reported in `coverage` and the rest is still mapped. Throws only if the parser itself
 * cannot start (the installed grammar files are missing).
 */
export async function buildMap(options: MapOptions): Promise<RepoMap> {
  const limits: MapLimits = { ...DEFAULT_MAP_LIMITS, ...options.limits };
  const started = Date.now();
  const deadline = started + limits.maxMillis;
  await initParser();

  const skipped: SkippedPath[] = [];
  const limitsHit = new Set<LimitHit>();
  const entries = await collect(options.root, limits, skipped);
  if (skipped.some((s) => s.reason === 'too-many-files')) limitsHit.add('files');

  let fnCounter = 0;
  const nextFnId = (): number => fnCounter++;
  const facts = new Map<string, FileFacts>();
  let totalBytes = 0;
  let totalNodes = 0;
  for (const e of entries) {
    if (Date.now() > deadline) {
      limitsHit.add('time');
      skipped.push({ path: e.path, reason: 'parse-timeout', affectsCompleteness: true });
      continue;
    }
    let text: string;
    try {
      const st = await lstat(e.abs);
      if (!st.isFile()) {
        skipped.push({ path: e.path, reason: 'unreadable', affectsCompleteness: true });
        continue;
      }
      if (st.size > limits.maxFileBytes) {
        skipped.push({ path: e.path, reason: 'too-large', affectsCompleteness: true });
        continue;
      }
      if (totalBytes + st.size > limits.maxTotalBytes) {
        limitsHit.add('total-bytes');
        skipped.push({ path: e.path, reason: 'total-bytes-exceeded', affectsCompleteness: true });
        continue;
      }
      const buf = await readFile(e.abs);
      totalBytes += buf.length;
      if (buf.includes(0)) {
        skipped.push({ path: e.path, reason: 'binary', affectsCompleteness: true });
        continue;
      }
      text = buf.toString('utf8').replace(/^\uFEFF/, '');
    } catch {
      skipped.push({ path: e.path, reason: 'unreadable', affectsCompleteness: true });
      continue;
    }
    const parsed = await parseSource(text, e.grammar, {
      maxAstDepth: limits.maxAstDepth,
      maxNodes: limits.maxNodesPerFile,
      maxParseMillis: limits.maxParseMillis,
    });
    if (parsed === 'timeout' || parsed === 'failed') {
      skipped.push({
        path: e.path,
        reason: parsed === 'timeout' ? 'parse-timeout' : 'parse-failed',
        affectsCompleteness: true,
      });
      continue;
    }
    totalNodes += parsed.nodes;
    if (totalNodes > limits.maxTotalNodes) {
      limitsHit.add('total-nodes');
      skipped.push({ path: e.path, reason: 'total-nodes-exceeded', affectsCompleteness: true });
      continue;
    }
    facts.set(e.path, prepass(e.path, parsed.root, parsed.incomplete, nextFnId));
  }

  const interp: InterpOutput = new Interpreter(facts, limits, deadline).run();
  for (const l of interp.limitsHit) limitsHit.add(l);
  const { routes: flat, truncated } = buildRoutes(interp);
  if (truncated) limitsHit.add('routes');

  const uses = new Map<string, number>();
  for (const f of facts.values()) for (const [k, v] of f.uses) uses.set(k, (uses.get(k) ?? 0) + v);

  const incomplete: IncompleteFile[] = [];
  for (const [path, f] of [...facts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const reasons = new Set<IncompleteReason>(f.incomplete);
    for (const r of interp.incompleteFiles.get(path) ?? []) reasons.add(r);
    if (reasons.size > 0) incomplete.push({ file: path, reasons: [...reasons].sort() });
  }
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const leaks = interp.leaks
    .slice()
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const GLOBAL = new Set([
    'dynamic-dispatch',
    'unresolved-handler',
    'unresolved-router',
    'code-eval',
    'dynamic-require',
  ]);
  const coverage: MapCoverage = {
    complete:
      !skipped.some((s) => s.affectsCompleteness) &&
      incomplete.length === 0 &&
      limitsHit.size === 0 &&
      !leaks.some((l) => GLOBAL.has(l.kind)),
    filesAnalyzed: facts.size,
    skipped,
    incomplete,
    limitsHit: [...limitsHit].sort(),
    leaks,
    functions: fnCounter,
    callEdges: interp.edgeCount,
  };
  const map: RepoMap = {
    routes: flat.filter((r) => r.kind === 'route').map((r) => publicRoute(r)),
    dataAccess: interp.sinks
      .slice()
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine)),
    coverage,
  };
  models.set(map, {
    facts,
    interp,
    routes: flat,
    coverage,
    uses,
    maxPaths: limits.maxPathsPerCandidate,
    flat,
  });
  return map;
}

/**
 * Reachability for each candidate, in input order. `unknown` is a real answer and is not
 * `unreachable`: callers must never dismiss a high-score candidate on `unknown`.
 */
export function reachabilityFor(
  map: RepoMap,
  candidates: readonly MapCandidate[],
): CandidateReachability[] {
  const model = models.get(map);
  if (!model) throw new TypeError('reachabilityFor needs a map returned by buildMap');
  return reachability(model, candidates);
}
