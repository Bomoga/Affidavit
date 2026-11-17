import type { RouteInfo } from '@affidavit/contracts';

/**
 * Bounds on the map. Every limit that is hit is reported in `MapCoverage` (nothing is dropped
 * silently), and a hit limit means the analysis is incomplete, so no candidate is called
 * unreachable because of it.
 */
export interface MapLimits {
  /** Source files read. Files past this count are reported as skipped. */
  maxFiles: number;
  /** A single file larger than this is skipped, not parsed. */
  maxFileBytes: number;
  /** Total bytes read across all files. */
  maxTotalBytes: number;
  /** Total syntax nodes kept across all files (this is what memory scales with). */
  maxTotalNodes: number;
  /** Deepest syntax tree level kept. Deeper subtrees are cut and the file is marked incomplete. */
  maxAstDepth: number;
  /** Most syntax nodes kept per file. */
  maxNodesPerFile: number;
  /** Directory nesting walked below the root. */
  maxDirDepth: number;
  /** Deepest chain of inlined calls while interpreting. */
  maxCallDepth: number;
  /** Interpreter steps (one per syntax node evaluated) across the whole run. */
  maxSteps: number;
  /** Times one function body is executed with different argument shapes. */
  maxExecutionsPerFunction: number;
  /** Wall-clock budget for the whole run. */
  maxMillis: number;
  /** Wall-clock budget for parsing one file. */
  maxParseMillis: number;
  /** Reachability paths reported per candidate. */
  maxPathsPerCandidate: number;
}

export const DEFAULT_MAP_LIMITS: MapLimits = {
  maxFiles: 5_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxTotalNodes: 2_500_000,
  maxAstDepth: 100,
  maxNodesPerFile: 400_000,
  maxDirDepth: 40,
  maxCallDepth: 12,
  maxSteps: 3_000_000,
  maxExecutionsPerFunction: 256,
  maxMillis: 60_000,
  maxParseMillis: 5_000,
  maxPathsPerCandidate: 5,
};

export type MapSkipReason =
  | 'too-large'
  | 'too-many-files'
  | 'total-bytes-exceeded'
  | 'total-nodes-exceeded'
  | 'parse-timeout'
  | 'parse-failed'
  | 'unreadable'
  | 'binary'
  | 'symlink'
  | 'minified'
  | 'declaration-file'
  | 'excluded-directory'
  | 'directory-too-deep';

/** A file or directory the map did not read. Reported so a gap is never silent. */
export interface SkippedPath {
  /** Posix path relative to the workspace root. */
  path: string;
  reason: MapSkipReason;
  /** True when the skipped content could contain code that matters (a source file or directory). */
  affectsCompleteness: boolean;
}

export type IncompleteReason =
  'syntax-error' | 'depth-limit' | 'node-limit' | 'interpreter-aborted' | 'stack-overflow';

export interface IncompleteFile {
  file: string;
  reasons: IncompleteReason[];
}

export type LeakKind =
  /** `require(expr)` with an expression that could not be reduced to a string. */
  | 'dynamic-require'
  /** A call through a computed key (`obj[key](...)`) that could not be resolved. */
  | 'dynamic-dispatch'
  /** A route handler or middleware argument that could not be resolved to code. */
  | 'unresolved-handler'
  /** A route registration (`x.get('/p', fn)`) on a receiver the map could not tie to Express. */
  | 'unresolved-router'
  /** `eval` or `new Function` ran code the map cannot see. */
  | 'code-eval';

/** Something that could invoke code the map cannot see. */
export interface Leak {
  kind: LeakKind;
  file: string;
  line: number;
}

export type LimitHit =
  | 'steps'
  | 'time'
  | 'call-depth'
  | 'executions-per-function'
  | 'files'
  | 'total-bytes'
  | 'total-nodes'
  | 'value-set-cap'
  | 'routes';

export interface MapCoverage {
  /**
   * True only when every source file was read and parsed without error or truncation, the
   * interpreter ran inside its budgets, and nothing could invoke unseen code. A candidate is
   * never called unreachable unless this holds (or the leak is irrelevant to the candidate; see
   * `CandidateReachability.reason`).
   */
  complete: boolean;
  filesAnalyzed: number;
  skipped: SkippedPath[];
  incomplete: IncompleteFile[];
  limitsHit: LimitHit[];
  leaks: Leak[];
  functions: number;
  callEdges: number;
}

export type RouteMount =
  /** Reached from an `express()` application through `use` mounts. */
  | 'app'
  /** Registered on a router that no application mounts (the mount may be out of sight). */
  | 'unmounted'
  /** Registered on a receiver the map could not resolve; matched by call shape only. */
  | 'orphan';

/** One middleware or handler in the chain in front of a route. */
export interface ChainItem {
  /** Source form of the argument, restricted to identifier characters; never a free-text string. */
  label: string;
  scope: 'app' | 'mount' | 'router' | 'route';
  /** Posix path of the file where the registering call is. */
  file: string;
  line: number;
  /** The function the argument resolved to, when it did. */
  fn?: FnRef;
  /** True when the argument is a known third-party middleware (session, bodyParser and so on). */
  external: boolean;
  /** True when the argument resolved to neither a function in the repo nor a known package. */
  unresolved: boolean;
  /** Why the map treats this item as an authentication guard, if it does. */
  authGuard?: 'name' | 'body';
}

export interface MapRoute {
  /** The contract shape. `middleware` is the ordered chain in front of the handler, without
   * application-wide `app.use` middleware (that is `appMiddleware`). */
  route: RouteInfo;
  /** Application-wide middleware (`app.use(fn)` with no path) registered before this route. */
  appMiddleware: string[];
  /** Full ordered chain (application-wide, mount, router and route level), handler excluded. */
  chain: ChainItem[];
  handler?: FnRef;
  handlerLabel: string;
  /** True when the path has a part the map could not reduce to a string. */
  pathDynamic: boolean;
  mounted: RouteMount;
  /** File and line of the registering call. */
  file: string;
  line: number;
}

export interface FnRef {
  file: string;
  /** Declared or assigned name, identifier characters only; `<anonymous>` when there is none. */
  name: string;
  startLine: number;
  endLine: number;
}

export type DataAccessKind = 'mongo' | 'sql' | 'code-eval' | 'command';

/** A call that reads or writes data, runs a query, or runs dynamic code. */
export interface DataAccessCall {
  kind: DataAccessKind;
  /** Method or function name (`find`, `query`, `eval`). */
  method: string;
  /** Mongo collection name when it is a string literal. */
  collection?: string;
  file: string;
  startLine: number;
  endLine: number;
  /** The function the call sits in. */
  fn: FnRef;
  /** `value`: the receiver was tied to a collection or driver. `name`: matched by name only. */
  basis: 'value' | 'name';
}

export type ReachReason =
  /** A route entry reaches the sink function. */
  | 'route-path'
  /** Not reached, and nothing refers to the function or its enclosing functions by name. */
  | 'unreferenced'
  /** Reached only from routes whose mount the map could not confirm. */
  | 'route-not-mounted'
  | 'file-not-analyzed'
  | 'file-incomplete'
  | 'repo-incomplete'
  | 'dynamic-require'
  | 'no-enclosing-function'
  /** Reached only from code handed to a package (another framework, a scheduler, an event). */
  | 'external-entry'
  /** Referred to somewhere, but no resolved route reaches it. */
  | 'referenced-unresolved'
  | 'invalid-location';

/** One way a route reaches a sink. */
export interface ReachPath {
  method: string;
  path: string;
  /** The file the route's handler is defined in (the contract's `RouteInfo.handlerFile`). */
  handlerFile: string;
  /** The functions walked, from the route entry (middleware or handler) to the sink's function. */
  functions: FnRef[];
  /** Middleware in front of the entry on this route, in order (chain labels). */
  middleware: string[];
  authRequired: boolean | 'unknown';
}

/**
 * Reachability for one candidate. `reachability` is the contract's three-valued answer.
 * `unknown` is not `unreachable`: it means the map could not tell, and a high-score candidate
 * with `unknown` must go on to trial or review, never to a dismissal.
 */
export interface CandidateReachability {
  candidateId: string;
  reachability: 'reachable' | 'unreachable' | 'unknown';
  reason: ReachReason;
  detail: string;
  /** The innermost function that holds the candidate's range, when there is one. */
  fn?: FnRef;
  paths: ReachPath[];
  /** True when every reaching path has an auth guard; `unknown` when no path was found. */
  authRequired: boolean | 'unknown';
  /** False when more paths exist than `paths` lists. */
  pathsComplete: boolean;
}

/** The shape of a candidate the map needs; a contract `Candidate` fits. */
export interface MapCandidate {
  id: string;
  file: string;
  range: { startLine: number; endLine: number };
}
