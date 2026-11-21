/**
 * Reachability: does a route entry reach the function that holds a candidate's lines?
 *
 * The answer is three-valued and the rules are one-sided on purpose:
 *   reachable   a resolved route (mounted under an application) reaches the function.
 *   unreachable only when the analysis is complete for the repo, nothing handed the function to
 *               code the map cannot see, and nothing refers to the function (or the functions
 *               around it) by name at all. Dead code, in other words.
 *   unknown     everything else, with a reason. Downstream never treats this as a dismissal.
 */
import type { InterpOutput } from './engine.js';
import { fnRef, safeIdent, type FileFacts, type FnInfo } from './prepass.js';
import type { FlatRoute } from './routes.js';
import type {
  CandidateReachability,
  MapCandidate,
  MapCoverage,
  ReachPath,
  ReachReason,
} from './types.js';

export interface ReachModel {
  facts: ReadonlyMap<string, FileFacts>;
  interp: InterpOutput;
  routes: readonly FlatRoute[];
  coverage: MapCoverage;
  /** Names used as references anywhere, summed over all files. */
  uses: ReadonlyMap<string, number>;
  maxPaths: number;
}

/** Leak kinds that mean unseen code may call any function, so no function is provably dead. */
const GLOBAL_LEAKS = new Set([
  'dynamic-dispatch',
  'unresolved-handler',
  'unresolved-router',
  'code-eval',
]);

interface Derived {
  fnById: Map<number, FnInfo>;
  rev: Map<number, number[]>;
  /** Entry function id to the routes (indexes into `routes`) it serves. */
  entryIndex: Map<number, number[]>;
  /** Functions reachable from any app-mounted route entry. */
  appReach: Set<number>;
  /** Functions reachable from code handed to a package from outside any request. */
  extReach: Set<number>;
  /** Functions run by module-level code (start-up). */
  startup: Set<number>;
}

const derivedCache = new WeakMap<ReachModel, Derived>();

function forward(
  edges: ReadonlyMap<number, ReadonlySet<number>>,
  from: Iterable<number>,
): Set<number> {
  const seen = new Set<number>(from);
  const stack = [...seen];
  while (stack.length > 0) {
    const u = stack.pop();
    if (u === undefined) break;
    for (const v of edges.get(u) ?? []) {
      if (!seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
    }
  }
  return seen;
}

function derive(m: ReachModel): Derived {
  const cached = derivedCache.get(m);
  if (cached) return cached;
  const fnById = new Map<number, FnInfo>();
  for (const f of m.facts.values()) for (const fn of f.fns) fnById.set(fn.id, fn);
  const rev = new Map<number, number[]>();
  for (const [u, vs] of m.interp.edges) {
    for (const v of vs) {
      const list = rev.get(v);
      if (list) list.push(u);
      else rev.set(v, [u]);
    }
  }
  const entryIndex = new Map<number, number[]>();
  const appEntries: number[] = [];
  m.routes.forEach((r, i) => {
    for (const id of new Set(r.entryFns)) {
      const list = entryIndex.get(id);
      if (list) list.push(i);
      else entryIndex.set(id, [i]);
      if (r.mounted === 'app') appEntries.push(id);
    }
  });
  const appReach = forward(m.interp.edges, appEntries);
  // Code handed to a package by start-up code (a module's top level: timers, event handlers,
  // another framework's route registration) may be invoked by that package at any time. Code
  // handed over from functions that nothing runs is dead and does not count; code handed over
  // from functions that start-up code runs is followed through the call edges.
  const startup = forward(
    m.interp.edges,
    [...fnById.values()].filter((f) => f.kind === 'module').map((f) => f.id),
  );
  const isDead = (id: number): boolean => {
    const f = fnById.get(id);
    if (!f || f.kind === 'module' || startup.has(id) || appReach.has(id)) return false;
    let named = false;
    for (let cur: FnInfo | undefined = f; cur && cur.kind !== 'module';) {
      for (const name of cur.names) {
        // `module.exports = function () {}` and `export default` name nothing: the function
        // is whatever the importer calls it.
        if (name === 'exports' || name === 'default') continue;
        if (alwaysReferenced(cur, name) || (m.uses.get(name) ?? 0) > 0) return false;
        named = true;
      }
      cur = cur.parent === null ? undefined : fnById.get(cur.parent);
    }
    return named;
  };
  const extStarts = m.interp.handoffs.filter(([from]) => !isDead(from)).map(([, to]) => to);
  const extReach = forward(m.interp.edges, extStarts);
  const d: Derived = { fnById, rev, entryIndex, appReach, extReach, startup };
  derivedCache.set(m, d);
  return d;
}

/**
 * Names the language or a library calls for you: `m + 1` runs `valueOf`, a template literal runs
 * `toString`, `await` runs `then`, `JSON.stringify` runs `toJSON`. No reference to them exists in
 * the source, so a missing reference proves nothing.
 */
const PROTOCOL_NAMES = new Set([
  'toString',
  'valueOf',
  'toJSON',
  'then',
  'catch',
  'finally',
  'inspect',
  'handleEvent',
  'constructor',
  'next',
  'return',
  'throw',
  'toLocaleString',
]);

const alwaysReferenced = (fn: FnInfo, name: string): boolean =>
  fn.accessor || PROTOCOL_NAMES.has(name) || name.startsWith('Symbol.');

function normalizePath(file: string): string | undefined {
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return undefined;
  if (p.split('/').includes('..')) return undefined;
  return p;
}

function enclosing(facts: FileFacts, start: number, end: number): FnInfo {
  let best: FnInfo | undefined;
  for (const fn of facts.fns) {
    if (fn.kind === 'module') continue;
    if (fn.startLine <= start && end <= fn.endLine) {
      if (
        !best ||
        fn.endLine - fn.startLine < best.endLine - best.startLine ||
        (fn.endLine - fn.startLine === best.endLine - best.startLine && fn.id > best.id)
      ) {
        best = fn;
      }
    }
  }
  return best ?? (facts.fns[0] as FnInfo);
}

function result(
  c: MapCandidate,
  reachability: CandidateReachability['reachability'],
  reason: ReachReason,
  detail: string,
  extra: Partial<CandidateReachability> = {},
): CandidateReachability {
  return {
    candidateId: c.id,
    reachability,
    reason,
    detail,
    paths: [],
    authRequired: 'unknown',
    pathsComplete: true,
    ...extra,
  };
}

/** Per-candidate reachability. Pure over the model; candidates are not changed. */
export function reachability(
  m: ReachModel,
  candidates: readonly MapCandidate[],
): CandidateReachability[] {
  const d = derive(m);
  return candidates.map((c) => reachOne(m, d, c));
}

function reachOne(m: ReachModel, d: Derived, c: MapCandidate): CandidateReachability {
  const file = normalizePath(c.file);
  const { startLine, endLine } = c.range;
  if (
    !file ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return result(
      c,
      'unknown',
      'invalid-location',
      'the candidate has no usable file and line range',
    );
  }
  const facts = m.facts.get(file);
  if (!facts) {
    return result(
      c,
      'unknown',
      'file-not-analyzed',
      'the map has no analysis for this file (not a source file, skipped, or outside the workspace)',
    );
  }
  const target = enclosing(facts, startLine, endLine);
  const ref = fnRef(target);

  // Reverse walk from the target to every route entry that reaches it.
  const parent = new Map<number, number>();
  const queue: number[] = [target.id];
  while (queue.length > 0) {
    const u = queue.shift();
    if (u === undefined) break;
    for (const p of d.rev.get(u) ?? []) {
      if (p !== target.id && !parent.has(p)) {
        parent.set(p, u);
        queue.push(p);
      }
    }
  }
  const entries = [...new Set([...parent.keys(), target.id])]
    .filter((id) => d.entryIndex.has(id))
    .sort((a, b) => a - b);
  type Found = { len: number; path: number[]; route: number };
  const found: Found[] = [];
  for (const e of entries) {
    const path = [e];
    for (let cur = e; cur !== target.id && path.length < 64;) {
      const next = parent.get(cur);
      if (next === undefined) break;
      path.push(next);
      cur = next;
    }
    for (const r of d.entryIndex.get(e) ?? []) found.push({ len: path.length, path, route: r });
  }
  const isUse = (f: Found): number => ((m.routes[f.route] as FlatRoute).kind === 'use' ? 1 : 0);
  found.sort((a, b) => isUse(a) - isUse(b) || a.len - b.len || a.route - b.route);
  const toPath = (f: Found): ReachPath => {
    const r = m.routes[f.route] as FlatRoute;
    return {
      method: r.route.method,
      path: r.route.path,
      handlerFile: r.route.handlerFile,
      functions: f.path.map((id) => fnRef(d.fnById.get(id) as FnInfo)),
      middleware: r.route.middleware,
      authRequired: r.route.authRequired,
    };
  };
  const mounted = found.filter((f) => (m.routes[f.route] as FlatRoute).mounted === 'app');
  const aggregateAuth = (fs: Found[]): boolean | 'unknown' => {
    const vals = fs.map((f) => (m.routes[f.route] as FlatRoute).route.authRequired);
    if (vals.every((v) => v === true)) return true;
    if (vals.some((v) => v === false)) return false;
    return 'unknown';
  };

  if (mounted.length > 0) {
    return result(
      c,
      'reachable',
      'route-path',
      `reached from ${mounted.length} route entr${mounted.length === 1 ? 'y' : 'ies'}`,
      {
        fn: ref,
        paths: mounted.slice(0, m.maxPaths).map(toPath),
        authRequired: aggregateAuth(mounted),
        pathsComplete: mounted.length <= m.maxPaths,
      },
    );
  }
  if (found.length > 0) {
    return result(
      c,
      'unknown',
      'route-not-mounted',
      'reached only from routes on a router that no application mounts, or on a receiver the map could not tie to Express',
      {
        fn: ref,
        paths: found.slice(0, m.maxPaths).map(toPath),
        pathsComplete: found.length <= m.maxPaths,
      },
    );
  }

  // Not reached. Decide between unknown and unreachable; unknown is the default.
  if (m.interp.incompleteFiles.has(file) || facts.incomplete.length > 0) {
    return result(
      c,
      'unknown',
      'file-incomplete',
      'the file was parsed with errors or only partly analyzed',
      { fn: ref },
    );
  }
  if (target.kind === 'module') {
    return result(
      c,
      'unknown',
      'no-enclosing-function',
      'the lines are in module-level code; the map does not decide request reachability for them',
      { fn: ref },
    );
  }
  const cov = m.coverage;
  const repoGaps: string[] = [];
  if (cov.skipped.some((s) => s.affectsCompleteness)) repoGaps.push('files skipped');
  if (cov.incomplete.length > 0) repoGaps.push('files only partly analyzed');
  if (cov.limitsHit.length > 0) repoGaps.push(`limits hit (${cov.limitsHit.join(', ')})`);
  const leakKinds = [
    ...new Set(cov.leaks.filter((l) => GLOBAL_LEAKS.has(l.kind)).map((l) => l.kind)),
  ];
  if (leakKinds.length > 0) repoGaps.push(`code the map cannot see (${leakKinds.join(', ')})`);
  if (repoGaps.length > 0) {
    return result(
      c,
      'unknown',
      'repo-incomplete',
      `not reached, but the analysis is incomplete: ${repoGaps.join('; ')}`,
      { fn: ref },
    );
  }
  const hasRequirers = (m.interp.requiredBy.get(file)?.size ?? 0) > 0;
  if (!hasRequirers && cov.leaks.some((l) => l.kind === 'dynamic-require')) {
    return result(
      c,
      'unknown',
      'dynamic-require',
      'the file is not required by name anywhere and a dynamic require could load it',
      { fn: ref },
    );
  }
  if (d.extReach.has(target.id)) {
    return result(
      c,
      'unknown',
      'external-entry',
      'reached only from code handed to a package, which may call it as a request handler',
      { fn: ref },
    );
  }
  if (d.startup.has(target.id)) {
    return result(
      c,
      'unknown',
      'startup-code',
      'run by start-up code and not reached from a route; start-up code can register handlers the map does not follow',
      { fn: ref },
    );
  }
  // Name rule: the function and every named function around it must be unreferenced, and at
  // least one of them must have a name (an unnamed function is whatever its caller makes it).
  let named = false;
  for (
    let cur: FnInfo | undefined = target;
    cur && cur.kind !== 'module';
    cur = cur.parent === null ? undefined : d.fnById.get(cur.parent)
  ) {
    for (const name of cur.names) {
      if (name === 'exports' || name === 'default') continue;
      named = true;
      if (alwaysReferenced(cur, name) || (m.uses.get(name) ?? 0) > 0) {
        return result(
          c,
          'unknown',
          'referenced-unresolved',
          `no resolved route reaches this code, but the name "${safeIdent(name)}" is referenced somewhere the map could not follow`,
          { fn: ref },
        );
      }
    }
  }
  if (!named) {
    return result(
      c,
      'unknown',
      'referenced-unresolved',
      'no route reaches this code and no function around it has a name to check references for',
      { fn: ref },
    );
  }
  return result(
    c,
    'unreachable',
    'unreferenced',
    'complete analysis; no route reaches this function and nothing refers to it or the functions around it',
    { fn: ref },
  );
}
