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
  rejectedBy?: AdmissibilityRule;
  runs: RunView[];
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
  /** Plain-language summary first, technical exhibits after. */
  sections: Section[];
  docket: DocketEntry[];
  exhibits: ExhibitView[];
  humanReview?: { reason: Escalation['reason']; detail: string; nextSteps: string[] };
}

export interface CaseViewInput {
  /**
   * Judge patch verification results. Contracts v1.0 has no trial event that carries a
   * `VerifyResult`, so the event stream alone can never show an accepted patch (see
   * docs/lanes/lane3/contract-requests.md). Until it does, these come from outside the stream.
   */
  verifyResults?: readonly VerifyResult[];
}

function label(e: TrialEvent): string {
  switch (e.type) {
    case 'stage-entered':
      return `Stage started: ${e.stage}`;
    case 'stage-exited':
      return `Stage finished: ${e.stage}, next ${e.payload.to}`;
    case 'exhibit-submitted':
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
      return `Objection to ${e.payload.exhibitId}`;
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
  }
}

/** A patch counts as accepted only when the Judge recorded every check passing. */
function isAccepted(v: VerifyResult): boolean {
  return (
    v.rejectedBy === undefined &&
    v.familyFlipped &&
    v.suitePassed &&
    v.rescanClean &&
    v.counterexamples.every((c) => !c.survived)
  );
}

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
  if (acceptedPatches.size === 0)
    out.push('The record has no Judge result accepting a patch for this case.');
  else if (!cited.some((id) => acceptedPatches.has(id)))
    out.push('The verdict does not cite the patch the Judge accepted.');
  return out;
}

export function buildCaseView(input: readonly TrialEvent[], extra: CaseViewInput = {}): CaseView {
  const bySeq = new Map<number, TrialEvent>();
  for (const e of input) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const exhibits = new Map<string, ExhibitView>();
  let verdict: Verdict | undefined;
  let escalation: Escalation | undefined;
  let dismissed = false;

  const ensure = (id: string): ExhibitView => {
    const prev = exhibits.get(id);
    if (prev) return prev;
    // An exhibit seen first in a Judge result is a witness unless a submission says otherwise.
    const next: ExhibitView = { id, kind: 'witness', admitted: false, runs: [] };
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
          ...(r.rejectedBy !== undefined ? { rejectedBy: r.rejectedBy } : {}),
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
        exhibits.set(prev.id, { ...prev, admitted: false, rejectedBy: e.payload.rejectedBy });
        break;
      }
      case 'verdict-written':
        verdict = e.payload.verdict;
        break;
      case 'escalated':
      case 'budget-exhausted':
        escalation = e.payload.escalation;
        break;
      case 'dismissed':
        dismissed = true;
        break;
      default:
        break;
    }
  }

  const acceptedPatches = new Set<string>(
    (extra.verifyResults ?? [])
      .filter((v) => isAccepted(v) && exhibits.get(v.patchExhibitId)?.kind === 'patch')
      .map((v) => v.patchExhibitId as string),
  );

  let status: CaseStatus = 'in-progress';
  let headline = 'This case is still being tried.';
  let summary = 'The trial is in progress. A summary appears when the Judge has ruled.';
  let withheld: string[] = [];
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
        headline =
          withheld.length === 0
            ? 'Verified: weakness proven and fix confirmed'
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
  const docket = events.map((e) => ({ seq: e.seq, at: e.at, stage: e.stage, label: label(e) }));

  return {
    caseId: events[0]?.caseId ?? '',
    status,
    headline,
    summary,
    stamp: status === 'verified' ? 'VERIFIED' : null,
    stampWithheld: withheld,
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
              'No conclusion has been reached about the safety of this code.',
            ],
          },
        }
      : {}),
  };
}
