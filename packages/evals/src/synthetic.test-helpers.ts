import type { Ballot, CaseId, ExhibitId } from '@affidavit/contracts';
import {
  asRunId,
  createEvalRun,
  tagReplay,
  type CaseLabel,
  type EvalRun,
  type LabelsSource,
} from './calibration.js';
import type { ReplayResult, TrialOutcome } from './replay.js';

/** Synthetic data for unit tests only. Never used to produce a reported number. */
export const cid = (s: string): CaseId => s as CaseId;

export function ballot(
  jurorId: string,
  vote: 'low' | 'medium' | 'high' | 'critical',
  question: 'severity' = 'severity',
): Ballot {
  return {
    schemaVersion: 1,
    jurorId,
    model: 'test-model',
    mandate: 'security',
    inputVariant: 'test',
    confidence: 0.5,
    citedExhibits: ['exhibit-1' as ExhibitId],
    question,
    vote,
  };
}

export function replay(
  caseId: string,
  outcome: TrialOutcome,
  votes: ('low' | 'medium' | 'high' | 'critical')[],
  usd = 0,
  withVerdict = true,
): ReplayResult {
  const ballots = votes.map((v, i) => ballot(`juror-${i}`, v));
  const base: ReplayResult = {
    caseId: cid(caseId),
    outcome,
    exhibits: [],
    ballots,
    costRows: [],
    cost: { inputTokens: 0, outputTokens: 0, usd, wallMs: 0 },
    eventCount: 0,
    opensAt: 'intake',
    complete: true,
  };
  if (withVerdict) {
    base.verdict = { outcome } as ReplayResult['verdict'];
  }
  return base;
}

/**
 * Corpus-labelled run in which the jury is right on 2 cases and wrong on `nWrong`, with
 * anti-correlated votes on the wrong cases, and a baseline that is wrong everywhere.
 */
export function winRun(runId = 'run-win', nWrong = 12): EvalRun {
  const ids = Array.from({ length: nWrong + 2 }, (_, i) => `c${i}`);
  return makeRun({
    kind: 'corpus',
    runId,
    labels: ids.map((id) => [id, 'proven-fixed']),
    replays: ids.map((id, i) =>
      i < 2
        ? replay(id, 'proven-fixed', ['high', 'high'])
        : replay(id, 'not-proven', i % 2 === 0 ? ['low', 'critical'] : ['critical', 'low']),
    ),
    baseline: ids.map((id) => [id, 'not-proven']),
  });
}

export function makeRun(opts: {
  runId?: string;
  kind?: LabelsSource['kind'];
  labels: [string, TrialOutcome][];
  replays: ReplayResult[];
  baseline?: [string, TrialOutcome][];
  ref?: string;
  startedAt?: string;
}): EvalRun {
  const runId = asRunId(opts.runId ?? 'test-run-synthetic');
  const labels: CaseLabel[] = opts.labels.map(([id, expected]) => ({ caseId: cid(id), expected }));
  return createEvalRun({
    manifest: {
      runId,
      startedAt: opts.startedAt ?? 'synthetic',
      labelsSource: { kind: opts.kind ?? 'synthetic', ref: opts.ref ?? 'in-test' },
      modelIds: {},
      promptVersions: {},
    },
    labels,
    replays: opts.replays.map((r) => tagReplay(runId, r)),
    baseline: (opts.baseline ?? []).map(([id, outcome]) => ({
      runId,
      caseId: cid(id),
      outcome,
    })),
  });
}
