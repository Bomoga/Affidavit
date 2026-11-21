/**
 * L1-06, arraignment. Turns normalized candidates (L1-03) and the map's answers (L1-05) into a
 * deterministic score, sends what deserves a trial on, and records a `Dismissal` with a reason
 * for everything it filters out.
 *
 * Everything here is a pure function of its arguments: no clock, no randomness, no I/O. The same
 * inputs give the same output, whatever the order of candidates, reachability answers or
 * negative controls (when several controls match one candidate, the one with the lowest id wins;
 * two reachability answers for one candidate are refused).
 *
 * Root rule F3: a candidate whose score is at or above the escalation floor is never dismissed
 * here. If a dismissal rule matches it anyway, it is held for review (`review`) instead.
 */
import { Candidate, CommitSha, type Dismissal, VulnClass } from '@affidavit/contracts';
import type { CandidateReachability, DataAccessCall } from '../map/index.js';

/** What kind of sink a candidate points at, coarse enough to score. */
export type SinkClass =
  /** `eval`, `new Function`, a shell command built from data. */
  | 'code-exec'
  /** SQL text built from data. */
  | 'sql'
  /** A MongoDB `$where` JavaScript expression built from data (runs code in the database). */
  | 'nosql-where'
  /** A request value used as a MongoDB filter or update (operator injection). */
  | 'nosql-operator'
  /** A data-access call keyed by a value the caller controls (IDOR). */
  | 'data-access'
  /** A vulnerable package version (OSV-Scanner). */
  | 'dependency'
  | 'unclassified';

/** Sink weights in 0..1. Design constants of the scoring function, not measurements. */
export const SINK_WEIGHTS: Readonly<Record<SinkClass, number>> = Object.freeze({
  'code-exec': 1,
  sql: 0.9,
  'nosql-where': 0.9,
  'nosql-operator': 0.7,
  'data-access': 0.7,
  unclassified: 0.5,
  dependency: 0.4,
});

/** Weights of the recorded inputs. They sum to 1, so the score is in 0..1. */
export const SCORE_WEIGHTS: Readonly<Record<ScoreInputName, number>> = Object.freeze({
  reachability: 0.4,
  sinkType: 0.3,
  noAuthOnPath: 0.1,
  toolAgreement: 0.2,
});

export type ScoreInputName = 'reachability' | 'sinkType' | 'noAuthOnPath' | 'toolAgreement';

export interface ScoreFacts {
  cls: VulnClass;
  reachability: 'reachable' | 'unreachable' | 'unknown';
  sink: SinkClass;
  /** From the map's route chain (`RouteInfo.authRequired`). */
  authRequired: boolean | 'unknown';
  /** Distinct tools that reported the candidate (`Candidate.toolAgreement`). */
  toolAgreement: number;
}

export interface Score {
  score: number;
  scoreInputs: Record<ScoreInputName, number>;
}

const REACH_VALUE = { reachable: 1, unknown: 0.5, unreachable: 0 } as const;

/** Four decimals: enough to order candidates, and free of float noise in recorded output. */
const round = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * The scoring function. Inputs, each in 0..1, recorded under these names:
 * - `reachability`: reachable 1, unknown 0.5, unreachable 0.
 * - `sinkType`: `SINK_WEIGHTS[sink]`.
 * - `noAuthOnPath`: no guard 1, unknown 0.5, a proven guard 0. For `idor` it is always 0.5: an
 *   IDOR needs a signed-in attacker, so a login guard neither lowers nor raises it.
 * - `toolAgreement`: `1 - 0.5^tools` (one tool 0.5, two 0.75, three 0.875).
 * The score is the weighted sum (`SCORE_WEIGHTS`).
 */
export function scoreFacts(f: ScoreFacts): Score {
  if (!Number.isSafeInteger(f.toolAgreement) || f.toolAgreement < 0) {
    throw new RangeError('toolAgreement must be a whole number of tools, at least 0');
  }
  const sinkType = SINK_WEIGHTS[f.sink];
  if (sinkType === undefined) throw new RangeError('unknown sink class');
  const noAuthOnPath =
    f.cls === 'idor' ? 0.5 : f.authRequired === false ? 1 : f.authRequired === true ? 0 : 0.5;
  const scoreInputs: Record<ScoreInputName, number> = {
    reachability: REACH_VALUE[f.reachability],
    sinkType,
    noAuthOnPath,
    toolAgreement: round(1 - 0.5 ** f.toolAgreement),
  };
  let sum = 0;
  for (const k of Object.keys(SCORE_WEIGHTS) as ScoreInputName[]) {
    sum += SCORE_WEIGHTS[k] * scoreInputs[k];
  }
  return { score: round(Math.min(1, Math.max(0, sum))), scoreInputs };
}

const RULE_SINKS: readonly [RegExp, SinkClass][] = [
  [/^affidavit\.injection\.sql-/, 'sql'],
  [/^affidavit\.injection\.nosql-where-/, 'nosql-where'],
  [/^affidavit\.injection\.nosql-operator-/, 'nosql-operator'],
  [/^affidavit\.idor\./, 'data-access'],
];

const MAP_SINKS: Readonly<Record<DataAccessCall['kind'], SinkClass>> = {
  'code-eval': 'code-exec',
  command: 'code-exec',
  sql: 'sql',
  mongo: 'data-access',
};

/**
 * The sink class: from our own rule id, raised (never lowered) by a data-access call the map saw
 * inside the candidate's lines. OSV findings are `dependency`.
 */
export function sinkClassOf(c: Candidate, dataAccess: readonly DataAccessCall[]): SinkClass {
  if (c.tool === 'osv') return 'dependency';
  const options: SinkClass[] = [];
  for (const [re, sink] of RULE_SINKS) if (re.test(c.ruleId)) options.push(sink);
  for (const d of dataAccess) {
    if (d.file === c.file && d.startLine <= c.range.endLine && d.endLine >= c.range.startLine) {
      options.push(MAP_SINKS[d.kind]);
    }
  }
  let best: SinkClass = 'unclassified';
  for (const s of options) if (SINK_WEIGHTS[s] > SINK_WEIGHTS[best]) best = s;
  return best;
}

export interface ArraignConfig {
  /** Written to every case file. At or above it, nothing is dismissed (F3). */
  escalationFloor: number;
  /** A candidate with known reachability and a score below this is dismissed. 0 turns it off. */
  dismissBelow: number;
}

export const DEFAULT_ARRAIGN_CONFIG: Readonly<ArraignConfig> = Object.freeze({
  escalationFloor: 0.7,
  dismissBelow: 0,
});

function checkConfig(c: ArraignConfig): ArraignConfig {
  for (const [k, v] of Object.entries(c)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new RangeError(`${k} must be a number in 0..1`);
    }
  }
  if (c.dismissBelow > c.escalationFloor) {
    throw new RangeError('dismissBelow must not be above escalationFloor');
  }
  return { escalationFloor: c.escalationFloor, dismissBelow: c.dismissBelow };
}

function num(env: Readonly<Record<string, string | undefined>>, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) throw new RangeError(`${key} must be a number in 0..1`);
  return Number(raw.trim());
}

/** `AFFIDAVIT_ESCALATION_FLOOR` and `AFFIDAVIT_DISMISS_BELOW`, validated; defaults otherwise. */
export function arraignConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): ArraignConfig {
  return checkConfig({
    escalationFloor:
      num(env, 'AFFIDAVIT_ESCALATION_FLOOR') ?? DEFAULT_ARRAIGN_CONFIG.escalationFloor,
    dismissBelow: num(env, 'AFFIDAVIT_DISMISS_BELOW') ?? DEFAULT_ARRAIGN_CONFIG.dismissBelow,
  });
}

/** The tree a scan ran on: a commit and the corpus patch set applied over it (empty for none). */
export interface ScannedTree {
  commit: string;
  patches: readonly string[];
}

/**
 * A corpus negative control: code a rule flags that is known not to be exploitable, in one tree.
 * It matches a candidate only when the scanned tree (commit and patch set), the rule id, the class
 * and the file are the same and the lines overlap. A control recorded on a patched tree therefore
 * never dismisses a scan of the vulnerable tree.
 */
export interface KnownNegativeControl {
  id: string;
  tree: ScannedTree;
  ruleId: string;
  cls: VulnClass;
  file: string;
  range: { startLine: number; endLine: number };
}

const treeKey = (t: ScannedTree): string => `${t.commit}|${[...t.patches].sort().join('|')}`;

function checkTree(t: ScannedTree, where: string): ScannedTree {
  if (!CommitSha.safeParse(t.commit).success) throw new RangeError(`${where}: bad commit`);
  if (!Array.isArray(t.patches) || t.patches.some((p) => typeof p !== 'string' || p === '')) {
    throw new RangeError(`${where}: patches must be non-empty strings`);
  }
  return t;
}

function checkControl(n: KnownNegativeControl): KnownNegativeControl {
  const where = `negative control ${n.id}`;
  if (typeof n.id !== 'string' || n.id === '') throw new RangeError('negative control: empty id');
  checkTree(n.tree, where);
  if (typeof n.ruleId !== 'string' || n.ruleId === '') throw new RangeError(`${where}: no rule id`);
  if (!VulnClass.safeParse(n.cls).success) throw new RangeError(`${where}: bad class`);
  if (typeof n.file !== 'string' || n.file === '') throw new RangeError(`${where}: no file`);
  return n;
}

export interface ArraignInput {
  /** From `normalizeReports`. */
  candidates: readonly Candidate[];
  /** From `reachabilityFor`. A candidate with no entry is treated as `unknown`. */
  reachability: readonly CandidateReachability[];
  /** `RepoMap.dataAccess`, to refine the sink class. */
  dataAccess?: readonly DataAccessCall[];
  negativeControls?: readonly KnownNegativeControl[];
  /** The tree the candidates were found in. Required when `negativeControls` is not empty. */
  tree?: ScannedTree;
  config: ArraignConfig;
}

export interface Arraigned {
  /** The input candidate with `reachability`, `score` and `scoreInputs` filled in. */
  candidate: Candidate;
  reach: CandidateReachability;
  sink: SinkClass;
  /** From config; goes into `CaseFile.escalationFloor`. */
  escalationFloor: number;
}

/**
 * An F3 hold. `wouldDismiss` is the dismissal that matched but was not applied because the score
 * is at or above the floor. `route` says who may take it:
 * - `person`: an `osv-no-path` hold. There is no call path to build a witness on, so it goes to a
 *   person only, never to trial.
 * - `person-or-trial`: any other hold. A person, or a second Defense attempt.
 */
export type HeldForReview = Arraigned & { detail: string } & (
    | { wouldDismiss: 'osv-no-path'; route: 'person' }
    | { wouldDismiss: Exclude<Dismissal['reason'], 'osv-no-path'>; route: 'person-or-trial' }
  );

export interface ArraignResult {
  /** Highest score first, then by candidate id. */
  toTrial: Arraigned[];
  /** By candidate id. Every one has a reason and a detail. */
  dismissed: Dismissal[];
  /** F3 holds (see `HeldForReview`). By candidate id. */
  review: HeldForReview[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function noAnswer(id: string): CandidateReachability {
  return {
    candidateId: id,
    reachability: 'unknown',
    reason: 'file-not-analyzed',
    detail: 'no map answer for this candidate',
    paths: [],
    authRequired: 'unknown',
    pathsComplete: false,
  };
}

/** The first dismissal rule that matches, in precedence order, or undefined. */
function dismissalFor(
  c: Candidate,
  r: CandidateReachability,
  score: number,
  controls: readonly KnownNegativeControl[],
  tree: string,
  config: ArraignConfig,
): { reason: Dismissal['reason']; detail: string } | undefined {
  // `controls` is sorted, so when several match the choice does not depend on input order.
  const nc = controls.find(
    (n) =>
      treeKey(n.tree) === tree &&
      n.ruleId === c.ruleId &&
      n.cls === c.cls &&
      n.file === c.file &&
      n.range.startLine <= c.range.endLine &&
      n.range.endLine >= c.range.startLine,
  );
  if (nc) return { reason: 'negative-control', detail: `matches corpus negative control ${nc.id}` };
  if (c.tool === 'osv' && r.reachability !== 'reachable') {
    return {
      reason: 'osv-no-path',
      detail: `no reachable call path to the vulnerable package (map: ${r.reachability}, ${r.reason})`,
    };
  }
  if (r.reachability === 'unreachable') {
    // Only the enum reason: the map's free-text detail can carry repo-derived names.
    return { reason: 'unreachable', detail: `the map found no path to it (${r.reason})` };
  }
  if (r.reachability !== 'unknown' && score < config.dismissBelow) {
    return {
      reason: 'below-threshold',
      detail: `score ${score} is below the dismissal threshold ${config.dismissBelow}`,
    };
  }
  return undefined;
}

export function arraign(input: ArraignInput): ArraignResult {
  const config = checkConfig(input.config);
  const controls = (input.negativeControls ?? [])
    .map(checkControl)
    .sort(
      (a, b) =>
        cmp(a.id, b.id) ||
        cmp(treeKey(a.tree), treeKey(b.tree)) ||
        cmp(a.file, b.file) ||
        a.range.startLine - b.range.startLine ||
        a.range.endLine - b.range.endLine,
    );
  if (controls.length > 0 && input.tree === undefined) {
    throw new RangeError('negative controls need the scanned tree (input.tree)');
  }
  const tree = input.tree ? treeKey(checkTree(input.tree, 'input.tree')) : '';
  const byId = new Map<string, CandidateReachability>();
  for (const r of input.reachability) {
    // Two answers for one candidate would make the result depend on their order.
    if (byId.has(r.candidateId)) throw new Error(`duplicate reachability for ${r.candidateId}`);
    byId.set(r.candidateId, r);
  }
  const seen = new Set<string>();
  const toTrial: Arraigned[] = [];
  const dismissed: Dismissal[] = [];
  const review: HeldForReview[] = [];
  for (const raw of input.candidates) {
    const c = Candidate.parse(raw);
    if (seen.has(c.id)) throw new Error(`duplicate candidate id ${c.id}`);
    seen.add(c.id);
    const reach = byId.get(c.id) ?? noAnswer(c.id);
    const sink = sinkClassOf(c, input.dataAccess ?? []);
    const { score, scoreInputs } = scoreFacts({
      cls: c.cls,
      reachability: reach.reachability,
      sink,
      authRequired: reach.authRequired,
      toolAgreement: c.toolAgreement,
    });
    const candidate = Candidate.parse({
      ...c,
      reachability: reach.reachability,
      score,
      scoreInputs,
    });
    const out: Arraigned = { candidate, reach, sink, escalationFloor: config.escalationFloor };
    const d = dismissalFor(c, reach, score, controls, tree, config);
    if (!d) toTrial.push(out);
    else if (score >= config.escalationFloor) {
      review.push(
        d.reason === 'osv-no-path'
          ? { ...out, wouldDismiss: d.reason, route: 'person', detail: d.detail }
          : { ...out, wouldDismiss: d.reason, route: 'person-or-trial', detail: d.detail },
      );
    } else
      dismissed.push({ schemaVersion: 1, candidateId: c.id, reason: d.reason, detail: d.detail });
  }
  toTrial.sort(
    (a, b) => b.candidate.score - a.candidate.score || cmp(a.candidate.id, b.candidate.id),
  );
  dismissed.sort((a, b) => cmp(a.candidateId, b.candidateId));
  review.sort((a, b) => cmp(a.candidate.id, b.candidate.id));
  return { toTrial, dismissed, review };
}
