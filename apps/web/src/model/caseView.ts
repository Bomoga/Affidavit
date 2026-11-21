import type {
  AdmissibilityRule,
  CaseStage,
  Escalation,
  TrialEvent,
  Verdict,
  VerifyResult,
} from '@affidavit/contracts';

export type Outcome = Verdict['outcome'];

export type CaseStatus =
  'in-progress' | 'verified' | 'unverified' | 'unfixed' | 'not-proven' | 'closed' | 'human-review';

export interface DocketEntry {
  seq: number;
  at: string;
  stage: CaseStage;
  label: string;
  /**
   * Set on entries that are about one exhibit (a counterexample or an objection) so the UI can
   * open that exhibit one click deeper. Never set on entries that carry no exhibit.
   */
  exhibitId?: string;
  /** Which docket detail to render. Absent for plain entries. */
  entry?: 'counterexample' | 'objection' | 'appeal';
  /** Recorded text for the entry, shown as untrusted plain text one click deeper. */
  detail?: string;
}

export interface RunView {
  variant: string;
  attempt: number;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface ExhibitView {
  id: string;
  kind: 'witness' | 'counterexample' | 'patch';
  /** True only when the Judge recorded an admissible result for this exhibit. */
  admitted: boolean;
  /**
   * True once the record holds any Judge ruling on this exhibit (a result or an inadmissible
   * record). False means nothing is recorded yet, which is not the same as rejected.
   */
  judged: boolean;
  rejectedBy?: AdmissibilityRule;
  runs: RunView[];
  /** The differential part of the Judge result, copied as recorded. Absent with no result. */
  proof?: {
    vulnPass: boolean;
    /** Absent when the corpus has no known-safe variant to compare against. */
    safeVariantFail?: boolean;
    family?: { passed: number; total: number };
  };
}

export interface Section {
  id: 'summary' | 'exhibits' | 'docket';
  title: string;
  body: string;
}

export interface CaseView {
  caseId: string;
  status: CaseStatus;
  headline: string;
  summary: string;
  /** Present only when the recorded evidence backs up a proven-fixed verdict. */
  stamp: 'VERIFIED' | null;
  /** Why the stamp is withheld on a proven-fixed verdict, in plain language. Empty otherwise. */
  stampWithheld: string[];
  /**
   * The stamp is withheld only because no Judge patch verification is in the record, and the
   * cited patch was never rejected. The fix has not failed; its check is just not recorded (no
   * `verify-result` event from the Judge yet). False in every other case.
   */
  awaitingVerification: boolean;
  /** Plain-language summary first, technical exhibits after. */
  sections: Section[];
  docket: DocketEntry[];
  exhibits: ExhibitView[];
  humanReview?: { reason: Escalation['reason']; detail: string; nextSteps: string[] };
}

/**
 * A `verify-result` counts as the Judge's patch check only when the Judge recorded it in the
 * verify stage (contracts v1.1, CR-1), for this stream's case, before any verdict was written. The
 * same payload from any other actor or stage, or recorded after a verdict, is shown on the docket
 * but never backs the stamp. A check for another case is dropped with every other such event.
 */
function isJudgeVerify(e: TrialEvent): e is Extract<TrialEvent, { type: 'verify-result' }> {
  return e.type === 'verify-result' && e.actor === 'judge' && e.stage === 'verify';
}

function label(
  e: TrialEvent,
  acceptedVerify: ReadonlySet<TrialEvent>,
  lateVerify: ReadonlySet<TrialEvent>,
): string {
  switch (e.type) {
    case 'stage-entered':
      return `Stage started: ${e.stage}`;
    case 'stage-exited':
      return `Stage finished: ${e.stage}, next ${e.payload.to}`;
    case 'exhibit-submitted':
      if (e.payload.kind === 'counterexample')
        return `Counterexample ${e.payload.exhibitId} filed by ${e.actor}`;
      return `${e.payload.kind} exhibit ${e.payload.exhibitId} submitted by ${e.actor}`;
    case 'exhibit-result': {
      const r = e.payload.result;
      return r.admissible
        ? `The Judge admitted ${r.exhibitId}`
        : `The Judge did not admit ${r.exhibitId} (rule ${r.rejectedBy ?? 'not recorded'})`;
    }
    case 'exhibit-inadmissible':
      return `The Judge did not admit ${e.payload.exhibitId} (rule ${e.payload.rejectedBy})`;
    case 'objection':
      return e.actor === 'prosecution'
        ? `The Prosecution objected, citing ${e.payload.exhibitId}`
        : `An objection was raised, citing ${e.payload.exhibitId}`;
    case 'appeal':
      return `Appeal round ${e.payload.round}`;
    case 'ballot-cast':
      return `Ballot cast by ${e.payload.ballot.jurorId} on ${e.payload.ballot.question}`;
    case 'cost-charged':
      return `Cost recorded for ${e.payload.cost.stage}`;
    case 'budget-exhausted':
      return 'Budget exhausted, sent to human review';
    case 'escalated':
      return 'Escalated to human review';
    case 'dismissed':
      return `Dismissed: ${e.payload.dismissal.reason}`;
    case 'verdict-written':
      return `Verdict written: ${e.payload.verdict.outcome}`;
    case 'verify-result': {
      const r = e.payload.result;
      if (e.actor !== 'judge' || e.stage !== 'verify')
        return `A patch check for ${r.patchExhibitId} was recorded by ${e.actor} in ${e.stage}, not by the Judge in verify`;
      if (lateVerify.has(e))
        return `A patch check for ${r.patchExhibitId} was recorded after the verdict, so it does not count`;
      if (acceptedVerify.has(e)) return `The Judge confirmed the fix in patch ${r.patchExhibitId}`;
      return `The Judge did not confirm patch ${r.patchExhibitId} (rule ${r.rejectedBy ?? 'not recorded'})`;
    }
  }
}

/**
 * A patch counts as accepted only when the Judge recorded every check passing, reported exactly
 * one result for each counterexample the Judge admitted, and none of them survived. A result that
 * misses, repeats or invents a counterexample is not evidence the patch was tested against them.
 * This is the same rule `packages/trial` applies before Remedy accepts a patch.
 */
function isAccepted(v: VerifyResult, expectedCounterexamples: readonly string[]): boolean {
  const got = v.counterexamples.map((c) => c.exhibitId as string);
  const want = new Set(expectedCounterexamples);
  const complete =
    got.length === want.size && new Set(got).size === got.length && got.every((id) => want.has(id));
  return (
    v.rejectedBy === undefined &&
    v.familyFlipped &&
    v.suitePassed &&
    v.rescanClean &&
    complete &&
    v.counterexamples.every((c) => !c.survived)
  );
}

/**
 * One docket line. Objections and counterexamples carry the exhibit they cite so the UI can open
 * it one click deeper. Appeals get a distinct entry kind with only the recorded round and
 * counterexample id; rendering them fully is L3-09 (see `AppealDocketDetail` in CaseFile).
 */
function docketEntry(
  e: TrialEvent,
  exhibits: ReadonlyMap<string, ExhibitView>,
  acceptedVerify: ReadonlySet<TrialEvent>,
  lateVerify: ReadonlySet<TrialEvent>,
): DocketEntry {
  const base = {
    seq: e.seq,
    at: e.at,
    stage: e.stage,
    label: label(e, acceptedVerify, lateVerify),
  };
  switch (e.type) {
    case 'exhibit-submitted':
      return e.payload.kind === 'counterexample'
        ? { ...base, entry: 'counterexample', exhibitId: e.payload.exhibitId }
        : base;
    case 'exhibit-result':
    case 'exhibit-inadmissible': {
      const id = e.type === 'exhibit-result' ? e.payload.result.exhibitId : e.payload.exhibitId;
      return exhibits.get(id)?.kind === 'counterexample'
        ? { ...base, entry: 'counterexample', exhibitId: id }
        : base;
    }
    case 'objection':
      return {
        ...base,
        entry: 'objection',
        exhibitId: e.payload.exhibitId,
        detail: e.payload.claim,
      };
    case 'appeal':
      return { ...base, entry: 'appeal', exhibitId: e.payload.counterexampleId };
    default:
      return base;
  }
}

const NO_ACCEPTED_PATCH = 'The record has no Judge result accepting a patch for this case.';

function stampBlockers(
  verdict: Verdict,
  exhibits: ReadonlyMap<string, ExhibitView>,
  acceptedPatches: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const cited = verdict.exhibits as readonly string[];
  if (cited.length === 0) out.push('The verdict cites no exhibits.');
  for (const id of cited) {
    const x = exhibits.get(id);
    if (!x) out.push(`The verdict cites ${id}, which does not appear in the record.`);
    else if (x.kind === 'witness' && !x.admitted)
      out.push(`The verdict cites witness ${id}, which the Judge did not admit.`);
  }
  if (!cited.some((id) => exhibits.get(id)?.kind === 'witness' && exhibits.get(id)?.admitted))
    out.push('The verdict cites no admitted witness.');
  if (acceptedPatches.size === 0) out.push(NO_ACCEPTED_PATCH);
  else if (!cited.some((id) => acceptedPatches.has(id)))
    out.push('The verdict does not cite the patch the Judge accepted.');
  return out;
}

/**
 * Builds the case view from the event stream alone. The VERIFIED stamp rests on the Judge's own
 * `verify-result` events, never on what the verdict claims.
 */
export function buildCaseView(input: readonly TrialEvent[]): CaseView {
  // The stream's case is the case of its first event by seq (the first one received on a tie).
  // Any event naming another case is ignored entirely: it is not part of this record.
  let streamCase: string | undefined;
  let firstSeq = Infinity;
  for (const e of input)
    if (e.seq < firstSeq) {
      firstSeq = e.seq;
      streamCase = e.caseId;
    }
  const bySeq = new Map<number, TrialEvent>();
  for (const e of input) if (e.caseId === streamCase && !bySeq.has(e.seq)) bySeq.set(e.seq, e);
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const exhibits = new Map<string, ExhibitView>();
  let verdict: Verdict | undefined;
  let escalation: Escalation | undefined;
  let dismissed = false;
  let firstVerdictSeq: number | undefined;
  // Judge checks recorded in verify before any verdict, in seq order. Only these count.
  const verifyEvents: Extract<TrialEvent, { type: 'verify-result' }>[] = [];
  // Judge checks recorded after a verdict. Shown on the docket, never counted.
  const lateVerify = new Set<TrialEvent>();

  const ensure = (id: string): ExhibitView => {
    const prev = exhibits.get(id);
    if (prev) return prev;
    // An exhibit seen first in a Judge result is a witness unless a submission says otherwise.
    const next: ExhibitView = { id, kind: 'witness', admitted: false, judged: false, runs: [] };
    exhibits.set(id, next);
    return next;
  };

  for (const e of events) {
    switch (e.type) {
      case 'exhibit-submitted':
        if (!exhibits.has(e.payload.exhibitId))
          exhibits.set(e.payload.exhibitId, {
            id: e.payload.exhibitId,
            kind: e.payload.kind,
            admitted: false,
            judged: false,
            runs: [],
          });
        break;
      case 'exhibit-result': {
        const r = e.payload.result;
        const prev = ensure(r.exhibitId);
        exhibits.set(r.exhibitId, {
          id: prev.id,
          kind: prev.kind,
          admitted: r.admissible,
          judged: true,
          ...(r.rejectedBy !== undefined ? { rejectedBy: r.rejectedBy } : {}),
          proof: {
            vulnPass: r.vulnPass,
            ...(r.safeVariantFail !== undefined ? { safeVariantFail: r.safeVariantFail } : {}),
            ...(r.familyResults !== undefined
              ? {
                  family: {
                    passed: r.familyResults.filter((f) => f.passed).length,
                    total: r.familyResults.length,
                  },
                }
              : {}),
          },
          runs: r.runs.map((run) => ({
            variant: run.variant,
            attempt: run.attempt,
            passed: run.passed,
            exitCode: run.exitCode,
            durationMs: run.durationMs,
            stdoutSha256: run.stdoutSha256,
            stderrSha256: run.stderrSha256,
          })),
        });
        break;
      }
      case 'exhibit-inadmissible': {
        const prev = ensure(e.payload.exhibitId);
        exhibits.set(prev.id, {
          ...prev,
          admitted: false,
          judged: true,
          rejectedBy: e.payload.rejectedBy,
        });
        break;
      }
      case 'verdict-written':
        verdict = e.payload.verdict;
        firstVerdictSeq ??= e.seq;
        break;
      case 'escalated':
      case 'budget-exhausted':
        escalation = e.payload.escalation;
        break;
      case 'dismissed':
        dismissed = true;
        break;
      case 'verify-result':
        // Events arrive here in seq order, so a check after any verdict is already known as late.
        if (!isJudgeVerify(e)) break;
        if (firstVerdictSeq !== undefined) lateVerify.add(e);
        else verifyEvents.push(e);
        break;
      default:
        break;
    }
  }

  // The counterexamples a patch must be tested against: those the Judge admitted.
  const admittedCounterexamples = [...exhibits.values()]
    .filter((x) => x.kind === 'counterexample' && x.admitted)
    .map((x) => x.id);

  // A Judge check counts only for an exhibit the record submitted as a patch. It never creates an
  // exhibit, so a check naming a witness or an unknown id changes nothing.
  // The last counted check of a patch (by seq) is the Judge's decision on it: a later failure
  // overrules an earlier pass, and a later pass supersedes an earlier failure.
  const acceptedVerify = new Set<TrialEvent>();
  const acceptedPatches = new Set<string>();
  for (const e of verifyEvents) {
    const r = e.payload.result;
    const target = exhibits.get(r.patchExhibitId);
    if (target?.kind !== 'patch') continue;
    const ok = isAccepted(r, admittedCounterexamples);
    if (ok) {
      acceptedVerify.add(e);
      acceptedPatches.add(target.id);
    } else acceptedPatches.delete(target.id);
    // The patch's own Judge ruling follows its latest check: admitted when it accepts the patch,
    // otherwise judged and not admitted, with the rule if the Judge named one.
    const next: ExhibitView = { ...target, admitted: ok, judged: true };
    delete next.rejectedBy;
    if (!ok && r.rejectedBy !== undefined) next.rejectedBy = r.rejectedBy;
    exhibits.set(target.id, next);
  }

  let status: CaseStatus = 'in-progress';
  let headline = 'This case is still being tried.';
  let summary = 'The trial is in progress. A summary appears when the Judge has ruled.';
  let withheld: string[] = [];
  let awaitingVerification = false;
  if (escalation) {
    status = 'human-review';
    headline = 'Needs human review';
    summary =
      'This finding needs a human reviewer before anything is concluded. No conclusion about safety has been reached.';
  } else if (verdict) {
    summary = verdict.summary;
    switch (verdict.outcome) {
      case 'proven-fixed':
        withheld = stampBlockers(verdict, exhibits, acceptedPatches);
        status = withheld.length === 0 ? 'verified' : 'unverified';
        awaitingVerification =
          withheld.length === 1 &&
          withheld[0] === NO_ACCEPTED_PATCH &&
          (verdict.exhibits as readonly string[]).some((id) => {
            const x = exhibits.get(id);
            return x?.kind === 'patch' && !x.judged;
          });
        headline =
          withheld.length === 0
            ? 'Verified: weakness proven and fix confirmed'
            : awaitingVerification
              ? 'Weakness proven, fix not yet confirmed by a recorded Judge check'
              : 'Fix claimed, not yet confirmed by the recorded evidence';
        break;
      case 'proven-unfixed':
        status = 'unfixed';
        headline = 'Weakness proven, fix not yet proven';
        break;
      case 'not-proven':
        status = 'not-proven';
        headline = 'Not proven';
        break;
      case 'escalated':
        status = 'human-review';
        headline = 'Needs human review';
        break;
      case 'dismissed':
        status = 'closed';
        headline = 'Closed without a proven finding';
        break;
    }
  } else if (dismissed) {
    status = 'closed';
    headline = 'Closed without a proven finding';
    summary = 'The case was closed before trial. The docket records the reason.';
  }

  const exhibitList = [...exhibits.values()];
  const docket = events.map((e) => docketEntry(e, exhibits, acceptedVerify, lateVerify));

  return {
    caseId: events[0]?.caseId ?? '',
    status,
    headline,
    summary,
    stamp: status === 'verified' ? 'VERIFIED' : null,
    stampWithheld: withheld,
    awaitingVerification,
    sections: [
      { id: 'summary', title: 'Summary', body: summary },
      { id: 'exhibits', title: 'Exhibits', body: exhibitList.map((x) => x.id).join(', ') },
      { id: 'docket', title: 'Docket', body: docket.map((d) => d.label).join('. ') },
    ],
    docket,
    exhibits: exhibitList,
    ...(escalation
      ? {
          humanReview: {
            reason: escalation.reason,
            detail: escalation.detail,
            nextSteps: [
              'A person should review the candidate and its code slices.',
              'Open the exhibits below to see each attempt and the Judge rule that applied.',
              'Record a decision with a reason. The case stays open until a person does; nothing closes it automatically.',
              'No conclusion has been reached about the safety of this code.',
            ],
          },
        }
      : {}),
  };
}
