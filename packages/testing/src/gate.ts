import type { TrialEvent } from '@affidavit/contracts';

/**
 * The walking-skeleton gate (docs/implementation-plan.md section 8): one SQL injection from a
 * Semgrep candidate to a signed verdict, with the witness admitted on the differential rule, a
 * patch that flips the whole family, a bundle that replays on a second machine, and the
 * containment suite green.
 *
 * `evaluateGate` judges a finished case against that list. It reads the case's own event stream
 * and a few facts the stream cannot hold (which implementations ran, the offline bundle check, the
 * replay, the containment run). It never runs anything and never guesses: a fact nobody supplied
 * is NOT RUN, and NOT RUN is not a pass.
 */
export type GateStatus = 'PASS' | 'FAIL' | 'NOT RUN';

export interface GateCheck {
  id: string;
  status: GateStatus;
  detail: string;
}

export interface GateReport {
  checks: GateCheck[];
  /** True only when every check is PASS. A single NOT RUN or FAIL makes it false. */
  passed: boolean;
  counts: Record<GateStatus, number>;
}

type Impl = 'real' | 'fake';

/** Facts the event stream cannot carry. Leave a field out when it was not checked. */
export interface GateFacts {
  /** `CaseFile.candidate.tool` of the case. The gate case must come from Semgrep. */
  candidateTool?: string;
  /** What the worker ran with (`AFFIDAVIT_*_IMPL`). Anything but `real` is not the gate. */
  implementations?: { intake: Impl; trial: Impl; judge: Impl };
  /** The offline check of the bundle and its signed attestation passed. */
  bundleVerified?: boolean;
  /** Replaying the bundle through the real Judge reproduced every exhibit outcome. */
  replayMatched?: boolean;
  /** That replay ran on a different machine from the one that sealed the bundle. */
  replayOnSecondMachine?: boolean;
  /** The containment suite passed on the sandbox host. */
  containmentGreen?: boolean;
}

const PATH_AFTER_ARRAIGN = ['defense', 'prosecution', 'remedy', 'verify'] as const;

const pass = (id: string, detail: string): GateCheck => ({ id, status: 'PASS', detail });
const fail = (id: string, detail: string): GateCheck => ({ id, status: 'FAIL', detail });
const notRun = (id: string, detail: string): GateCheck => ({ id, status: 'NOT RUN', detail });

function ofType<T extends TrialEvent['type']>(
  events: readonly TrialEvent[],
  type: T,
): Extract<TrialEvent, { type: T }>[] {
  return events.filter((e): e is Extract<TrialEvent, { type: T }> => e.type === type);
}

function checkRealPorts(facts: GateFacts): GateCheck {
  const id = 'real-ports';
  const impl = facts.implementations;
  if (impl === undefined) {
    return notRun(id, 'nobody stated which implementations ran (intake, trial, Judge)');
  }
  const fake = (['intake', 'trial', 'judge'] as const).filter((k) => impl[k] !== 'real');
  return fake.length === 0
    ? pass(id, 'intake, trial and Judge were all real')
    : fail(id, `not real: ${fake.join(', ')}. A fake stage cannot meet the gate`);
}

function checkCandidate(facts: GateFacts): GateCheck {
  const id = 'candidate-from-semgrep';
  if (facts.candidateTool === undefined) {
    return notRun(id, 'the case file candidate tool was not supplied');
  }
  return facts.candidateTool === 'semgrep'
    ? pass(id, 'the candidate came from Semgrep')
    : fail(id, `the candidate came from ${facts.candidateTool}, not Semgrep`);
}

function checkOneCase(events: readonly TrialEvent[]): GateCheck {
  const id = 'one-case';
  const ids = new Set(events.map((e) => e.caseId));
  if (ids.size === 0) return fail(id, 'no events');
  return ids.size === 1
    ? pass(id, 'every event belongs to one case')
    : fail(id, `${ids.size} cases mixed in one stream`);
}

function checkFullPath(events: readonly TrialEvent[]): GateCheck {
  const id = 'full-path';
  const entered = ofType(events, 'stage-entered').map((e) => e.stage);
  let from = 0;
  const missing: string[] = [];
  for (const stage of PATH_AFTER_ARRAIGN) {
    const at = entered.indexOf(stage, from);
    if (at === -1) missing.push(stage);
    else from = at + 1;
  }
  return missing.length === 0
    ? pass(id, `entered ${PATH_AFTER_ARRAIGN.join(', ')} in order`)
    : fail(id, `never entered, or out of order: ${missing.join(', ')}`);
}

function checkWitness(events: readonly TrialEvent[]): GateCheck {
  const id = 'witness-admitted-differential';
  const results = ofType(events, 'exhibit-result').map((e) => e.payload.result);
  if (results.length === 0) return fail(id, 'no exhibit result in the stream');
  const ok = results.find((r) => r.admissible && r.vulnPass && r.safeVariantFail === true);
  if (ok) {
    return pass(id, `${ok.exhibitId} passed on the vulnerable code and failed on the safe variant`);
  }
  if (results.some((r) => r.admissible && r.safeVariantFail === undefined)) {
    return fail(
      id,
      'a witness was admitted with no safe variant to compare, which is not differential proof',
    );
  }
  const why = results.map(
    (r) =>
      `${r.exhibitId}: ${r.admissible ? 'admitted without a differential pass' : `rejected by ${r.rejectedBy ?? 'unknown'}`}`,
  );
  return fail(id, `no witness is admitted on the differential rule (${why.join('; ')})`);
}

function checkNoEgress(events: readonly TrialEvent[]): GateCheck {
  const id = 'no-egress';
  const results = ofType(events, 'exhibit-result').map((e) => e.payload.result);
  if (results.length === 0) return fail(id, 'no exhibit result to check');
  const bad = results.filter((r) => r.egressAttempts > 0);
  return bad.length === 0
    ? pass(id, 'no exhibit run tried to leave the jail')
    : fail(id, `egress attempted in: ${bad.map((r) => r.exhibitId).join(', ')}`);
}

function checkPatch(events: readonly TrialEvent[]): GateCheck {
  const id = 'patch-flips-family';
  const verifies = ofType(events, 'verify-result');
  const last = verifies[verifies.length - 1]?.payload.result;
  if (last === undefined) return fail(id, 'no verify-result: the Judge never checked a patch');
  const problems: string[] = [];
  if (last.rejectedBy !== undefined) problems.push(`rejected by ${last.rejectedBy}`);
  if (!last.familyFlipped) problems.push('the witness family did not flip');
  if (!last.suitePassed) problems.push("the target's own tests did not pass");
  if (!last.rescanClean) problems.push('the re-scan still finds it');
  const survivors = last.counterexamples.filter((c) => c.survived);
  if (survivors.length > 0) {
    problems.push(`${survivors.length} counterexample(s) survived the patch`);
  }
  return problems.length === 0
    ? pass(id, `${last.patchExhibitId} flipped the whole family, passed the suite and the re-scan`)
    : fail(id, problems.join('; '));
}

function checkVerdict(events: readonly TrialEvent[]): { verdict: GateCheck; bundle: GateCheck } {
  const written = ofType(events, 'verdict-written');
  const v = written[written.length - 1]?.payload.verdict;
  if (v === undefined) {
    return {
      verdict: fail('verdict-proven-fixed', 'no verdict was written'),
      bundle: fail('bundle-sealed', 'no verdict, so no bundle'),
    };
  }
  const verdict =
    v.outcome === 'proven-fixed'
      ? pass('verdict-proven-fixed', 'the verdict is proven-fixed')
      : fail('verdict-proven-fixed', `the verdict is ${v.outcome}, not proven-fixed`);
  const bundle =
    v.bundleSha256 !== undefined
      ? pass('bundle-sealed', 'the verdict names its evidence bundle')
      : fail('bundle-sealed', 'the verdict names no bundle, so there is nothing to sign or replay');
  return { verdict, bundle };
}

function tri(
  id: string,
  value: boolean | undefined,
  ok: string,
  bad: string,
  missing: string,
): GateCheck {
  if (value === undefined) return notRun(id, missing);
  return value ? pass(id, ok) : fail(id, bad);
}

function checkReplay(facts: GateFacts): GateCheck[] {
  const matched = tri(
    'replay-matches',
    facts.replayMatched,
    'replay reproduced every exhibit outcome',
    'replay did not reproduce the recorded outcomes',
    'the bundle was not replayed',
  );
  const second =
    facts.replayOnSecondMachine === undefined
      ? notRun('replay-second-machine', 'nobody stated whether the replay ran on a second machine')
      : facts.replayOnSecondMachine
        ? pass('replay-second-machine', 'the replay ran on a different machine')
        : notRun(
            'replay-second-machine',
            'the replay ran on the same machine that sealed the bundle',
          );
  return [matched, second];
}

/** Judges a finished case. `events` must already be parsed with `TrialEvent.parse`. */
export function evaluateGate(events: readonly TrialEvent[], facts: GateFacts = {}): GateReport {
  const { verdict, bundle } = checkVerdict(events);
  const checks: GateCheck[] = [
    checkRealPorts(facts),
    checkCandidate(facts),
    checkOneCase(events),
    checkFullPath(events),
    checkWitness(events),
    checkNoEgress(events),
    checkPatch(events),
    verdict,
    bundle,
    tri(
      'attestation-verified',
      facts.bundleVerified,
      'the bundle and its signed attestation verify offline',
      'the offline check of the bundle or its attestation failed',
      'the bundle and attestation were not verified',
    ),
    ...checkReplay(facts),
    tri(
      'containment-green',
      facts.containmentGreen,
      'the containment suite passed',
      'the containment suite did not pass',
      'the containment suite was not run',
    ),
  ];
  const counts: Record<GateStatus, number> = { PASS: 0, FAIL: 0, 'NOT RUN': 0 };
  for (const c of checks) counts[c.status] += 1;
  return { checks, passed: counts.FAIL === 0 && counts['NOT RUN'] === 0, counts };
}

/** Plain text, one line per check. No numbers beyond the counts. */
export function formatGateReport(report: GateReport): string {
  const lines = report.checks.map((c) => `${c.status.padEnd(7)} ${c.id}: ${c.detail}`);
  const { PASS, FAIL, 'NOT RUN': NOT_RUN } = report.counts;
  lines.push(
    '',
    report.passed
      ? 'GATE MET: every check passed.'
      : `GATE NOT MET: ${PASS} passed, ${FAIL} failed, ${NOT_RUN} not run. A check that was not run is not a pass.`,
  );
  return lines.join('\n');
}
