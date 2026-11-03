import type { TrialEvent, VerdictView } from './types.js';

export type CaseStatus =
  'in-progress' | 'verified' | 'unverified' | 'unfixed' | 'not-proven' | 'closed' | 'human-review';

export interface DocketEntry {
  seq: number;
  at: string;
  label: string;
}

export interface RunView {
  variant: string;
  attempt: number;
  passed: boolean;
  log: string;
}

export interface ExhibitView {
  id: string;
  kind: 'witness' | 'patch';
  admitted: boolean;
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
  /** Present only when the recorded events back up a proven-fixed verdict. */
  stamp: 'VERIFIED' | null;
  /** Plain-language summary first, technical exhibits after. */
  sections: Section[];
  docket: DocketEntry[];
  exhibits: ExhibitView[];
  humanReview?: { reason: string; detail: string; nextSteps: string[] };
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function label(e: TrialEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'stage-entered':
      return `Stage started: ${e.stage}`;
    case 'exhibit-submitted':
      return `Exhibit submitted by ${e.actor}`;
    case 'exhibit-result':
      return `The Judge ran ${str(p.exhibitId, 'an exhibit')}: ${
        p.admissible === true && p.passed === true ? 'admitted and passed' : 'not admitted'
      }`;
    case 'exhibit-inadmissible':
      return `Output rejected by rule ${str(p.rule, 'unknown')}`;
    case 'patch-submitted':
      return 'Patch submitted';
    case 'patch-rejected':
      return `Patch rejected: ${str(p.rule, 'unknown')}`;
    case 'patch-verified':
      return p.accepted === true
        ? 'The Judge verified the patch'
        : 'The Judge did not accept the patch';
    case 'verdict-written':
      return `Verdict written: ${str(p.outcome, 'unknown')}`;
    case 'escalated':
      return 'Escalated to human review';
    default:
      return e.type;
  }
}

function runsOf(value: unknown): RunView[] {
  if (!Array.isArray(value)) return [];
  return value.map((r: Record<string, unknown>) => ({
    variant: str(r.variant),
    attempt: typeof r.attempt === 'number' ? r.attempt : 1,
    passed: r.passed === true,
    log: str(r.log),
  }));
}

export function buildCaseView(input: readonly TrialEvent[]): CaseView {
  const bySeq = new Map<number, TrialEvent>();
  for (const e of input) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const exhibits = new Map<string, ExhibitView>();
  let patchAccepted = false;
  let verdict: VerdictView | undefined;
  let escalation: { reason: string; detail: string } | undefined;

  for (const e of events) {
    const id = str(e.payload.exhibitId);
    if (e.type === 'exhibit-submitted' && id && !exhibits.has(id)) {
      exhibits.set(id, { id, kind: 'witness', admitted: false, runs: [] });
    } else if (e.type === 'exhibit-result' && id) {
      const prev = exhibits.get(id) ?? { id, kind: 'witness' as const, admitted: false, runs: [] };
      exhibits.set(id, {
        ...prev,
        admitted: e.payload.admissible === true && e.payload.passed === true,
        runs: runsOf(e.payload.runs),
      });
    } else if (e.type === 'patch-submitted' && id && !exhibits.has(id)) {
      exhibits.set(id, { id, kind: 'patch', admitted: false, runs: [] });
    } else if (e.type === 'patch-verified' && e.payload.accepted === true) {
      patchAccepted = true;
      const pid = id;
      const prev = pid ? exhibits.get(pid) : undefined;
      if (pid && prev) exhibits.set(pid, { ...prev, admitted: true });
    } else if (e.type === 'verdict-written') {
      verdict = e.payload.verdict as VerdictView | undefined;
    } else if (e.type === 'escalated') {
      escalation = { reason: str(e.payload.reason), detail: str(e.payload.detail) };
    }
  }

  const known = new Set(exhibits.keys());
  const consistent =
    verdict !== undefined &&
    verdict.outcome === 'proven-fixed' &&
    patchAccepted &&
    verdict.exhibits.length > 0 &&
    verdict.exhibits.every((x) => known.has(x));

  let status: CaseStatus = 'in-progress';
  let headline = 'This case is still being tried.';
  let summary = 'The trial is in progress. A summary appears when the Judge has ruled.';
  if (escalation) {
    status = 'human-review';
    headline = 'Needs human review';
    summary =
      'This finding needs a human reviewer before anything is concluded. No conclusion about safety has been reached.';
  } else if (verdict) {
    summary = verdict.summary;
    switch (verdict.outcome) {
      case 'proven-fixed':
        status = consistent ? 'verified' : 'unverified';
        headline = consistent
          ? 'Verified: weakness proven and fix confirmed'
          : 'The recorded events do not back up this verdict';
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
      default:
        status = 'closed';
        headline = 'Closed without a proven finding';
    }
  }

  const exhibitList = [...exhibits.values()];
  const docket = events.map((e) => ({ seq: e.seq, at: e.at, label: label(e) }));

  return {
    caseId: events[0]?.caseId ?? '',
    status,
    headline,
    summary,
    stamp: status === 'verified' ? 'VERIFIED' : null,
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
            ...escalation,
            nextSteps: [
              'A person should review the candidate and its code slices.',
              'No conclusion has been reached about the safety of this code.',
            ],
          },
        }
      : {}),
  };
}
