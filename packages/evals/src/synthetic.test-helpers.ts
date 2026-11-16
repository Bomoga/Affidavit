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
  };
  if (withVerdict) {
    base.verdict = { outcome } as ReplayResult['verdict'];
  }
  return base;
}

export function makeRun(opts: {
  runId?: string;
  kind?: LabelsSource['kind'];
  labels: [string, TrialOutcome][];
  replays: ReplayResult[];
  baseline?: [string, TrialOutcome][];
}): EvalRun {
  const runId = asRunId(opts.runId ?? 'test-run-synthetic');
  const labels: CaseLabel[] = opts.labels.map(([id, expected]) => ({ caseId: cid(id), expected }));
  return createEvalRun({
    manifest: {
      runId,
      startedAt: 'synthetic',
      labelsSource: { kind: opts.kind ?? 'synthetic', ref: 'in-test' },
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
