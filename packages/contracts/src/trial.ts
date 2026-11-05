import { z } from 'zod';
import {
  AdmissibilityRule,
  BudgetState,
  CaseId,
  CaseStage,
  ExhibitId,
  IsoDate,
  PromptId,
  Role,
  SchemaVersion,
  Severity,
  Sha256,
  StageCost,
} from './common.js';
import { Dismissal } from './discovery.js';
import { ExhibitResult } from './evidence.js';

const BallotBase = z.object({
  schemaVersion: SchemaVersion,
  jurorId: z.string().min(1),
  model: z.string().min(1),
  mandate: z.enum(['security', 'maintainability', 'blast-radius']),
  /** F4: which exhibit ordering or raw-results-only view this juror saw. */
  inputVariant: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /** A ballot that cites no exhibit is invalid. */
  citedExhibits: z.array(ExhibitId).min(1),
});

/**
 * Discriminated on `question` so a ballot can only carry a judgment vote. "Did the test pass" or
 * "did the exploit land" has no representation: those are the Judge's questions.
 */
export const Ballot = z.discriminatedUnion('question', [
  BallotBase.extend({ question: z.literal('severity'), vote: Severity }),
  BallotBase.extend({
    question: z.literal('fix-minimality'),
    vote: z.enum(['minimal', 'acceptable', 'excessive']),
  }),
  BallotBase.extend({ question: z.literal('merge-risk'), vote: z.enum(['low', 'medium', 'high']) }),
  BallotBase.extend({
    question: z.literal('evidence-sufficiency'),
    vote: z.enum(['sufficient', 'insufficient']),
  }),
]);
export type Ballot = z.infer<typeof Ballot>;

export const Escalation = z.object({
  schemaVersion: SchemaVersion,
  caseId: CaseId,
  reason: z.enum(['no-admissible-witness-above-floor', 'split-jury', 'budget-exhausted']),
  detail: z.string(),
});
export type Escalation = z.infer<typeof Escalation>;

export const Verdict = z.object({
  schemaVersion: SchemaVersion,
  caseId: CaseId,
  outcome: z.enum(['proven-fixed', 'proven-unfixed', 'not-proven', 'dismissed', 'escalated']),
  /** Absent for dismissed, escalated, and not-proven outcomes. */
  severity: Severity.optional(),
  exhibits: z.array(ExhibitId),
  ballots: z.array(Ballot),
  jurorCorrelation: z.number().min(-1).max(1).optional(),
  /** Generated from the structured fields, never the reverse. */
  summary: z.string(),
  bundleSha256: Sha256.optional(),
  /** Keyed by prompt id; only prompts that actually ran appear. */
  promptVersions: z.partialRecord(PromptId, z.string()),
  modelIds: z.partialRecord(PromptId, z.string()),
  cost: z.array(StageCost),
});
export type Verdict = z.infer<typeof Verdict>;

export const TrialEventType = z.enum([
  'stage-entered',
  'stage-exited',
  'exhibit-submitted',
  'exhibit-result',
  'exhibit-inadmissible',
  'objection',
  'appeal',
  'ballot-cast',
  'cost-charged',
  'budget-exhausted',
  'escalated',
  'dismissed',
  'verdict-written',
]);
export type TrialEventType = z.infer<typeof TrialEventType>;

const EventBase = z.object({
  schemaVersion: SchemaVersion,
  caseId: CaseId,
  /** Monotonic per case, assigned by the store; SSE resumes from the last seq seen. */
  seq: z.int().min(0),
  stage: CaseStage,
  at: IsoDate,
  actor: Role,
});

function event<T extends TrialEventType, P extends z.ZodType>(type: T, payload: P) {
  return EventBase.extend({ type: z.literal(type), payload });
}

export const TrialEvent = z.discriminatedUnion('type', [
  event('stage-entered', z.object({ from: CaseStage.optional() })),
  event('stage-exited', z.object({ to: CaseStage })),
  event(
    'exhibit-submitted',
    z.object({ exhibitId: ExhibitId, kind: z.enum(['witness', 'counterexample', 'patch']) }),
  ),
  event('exhibit-result', z.object({ result: ExhibitResult })),
  event('exhibit-inadmissible', z.object({ exhibitId: ExhibitId, rejectedBy: AdmissibilityRule })),
  event('objection', z.object({ exhibitId: ExhibitId, claim: z.string().min(1) })),
  event('appeal', z.object({ round: z.int().min(1).max(2), counterexampleId: ExhibitId })),
  event('ballot-cast', z.object({ ballot: Ballot })),
  event('cost-charged', z.object({ cost: StageCost, remaining: BudgetState })),
  event('budget-exhausted', z.object({ escalation: Escalation })),
  event('escalated', z.object({ escalation: Escalation })),
  event('dismissed', z.object({ dismissal: Dismissal })),
  event('verdict-written', z.object({ verdict: Verdict })),
]);
export type TrialEvent = z.infer<typeof TrialEvent>;
