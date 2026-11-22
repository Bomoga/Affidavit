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
import { ExhibitResult, VerifyResult } from './evidence.js';

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

/** v1.2 (CR-T1): why part of an up-front charge was given back. */
export const CostReleaseReason = z.enum([
  /** The model call failed and reported what it spent; the unspent part is returned. */
  'model-call-failed',
  /** The call completed and spent less than the up-front reservation. */
  'reservation-unspent',
]);
export type CostReleaseReason = z.infer<typeof CostReleaseReason>;

/** v1.2 (CR-T1): the payload of a `cost-released` event. */
export const CostRelease = z.object({
  /** What was given back. Non-negative fields, for the stage and attempt of the reservation. */
  cost: StageCost,
  /** The budget after the release. */
  remaining: BudgetState,
  /** The seq of the `cost-charged` event that recorded the charge being released. */
  reservationSeq: z.int().min(0),
  reason: CostReleaseReason,
});
export type CostRelease = z.infer<typeof CostRelease>;

/**
 * v1.2 (CR-T12, CR-T13): why a case stopped without a verdict, dismissal or escalation. A halt is
 * not a stage: the case stays at the stage it was in, so running it again resumes there.
 */
export const HaltReason = z.enum([
  'kill-switch',
  /** No model credential is configured; checked before any charge. */
  'model-unconfigured',
  /** The provider declined the request under its usage policy. Never a dismissal. */
  'model-refusal',
  /**
   * The budget cannot pay for the next call. When the case also goes to human review, the
   * existing `budget-exhausted` event with its Escalation is still emitted; `halted` never
   * replaces it.
   */
  'budget-exhausted',
]);
export type HaltReason = z.infer<typeof HaltReason>;

/** v1.2 (CR-T13): the allowlisted category a provider gives for a refusal. */
export const RefusalCategory = z.enum([
  'cyber',
  'bio',
  'chem',
  'csam',
  'frontier_llm',
  'reasoning_extraction',
  'other',
]);
export type RefusalCategory = z.infer<typeof RefusalCategory>;

/** v1.2 (CR-T12): the payload of a `halted` event. */
export const Halt = z
  .object({
    reason: HaltReason,
    /** Only with reason `model-refusal`. */
    refusalCategory: RefusalCategory.optional(),
    /** Operator-facing text. Never carries a credential or a model's output. */
    detail: z.string().optional(),
  })
  .refine((h) => h.refusalCategory === undefined || h.reason === 'model-refusal', {
    message: 'a refusal category is allowed only when the reason is model-refusal',
    path: ['refusalCategory'],
  });
export type Halt = z.infer<typeof Halt>;

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
  // v1.1 (CR-1): appended at the end, additive.
  'verify-result',
  // v1.2 (CR-T1, CR-T12): appended at the end, additive.
  'cost-released',
  'halted',
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
  /**
   * v1.1 (CR-1): the Judge's `VerifyResult` for one `JudgePort.verifyPatch` call. Emitted by actor
   * `judge` in stage `verify`, once per call, so appeals produce one per round. Clients that read
   * only the stream (web, CLI) learn from this event, not from the verdict, whether a patch passed.
   */
  event('verify-result', z.object({ result: VerifyResult })),
  /**
   * v1.2 (CR-T1): part of an up-front charge was given back through `CaseStore.releaseCharge`.
   * Emitted by the stage's actor, after the release succeeds, at most once per `reservationSeq`.
   * The net cost of a stage is its `cost-charged` events minus its `cost-released` events, which
   * is what `Verdict.cost` reports.
   */
  event('cost-released', CostRelease),
  /**
   * v1.2 (CR-T12): the case stopped at `stage` without a terminal outcome. Legal from any stage,
   * because it moves no stage: there is no `halted` CaseStage and no transition.
   */
  event('halted', Halt),
]);
export type TrialEvent = z.infer<typeof TrialEvent>;

/**
 * v1.2 (CR-T11): one recorded agent turn, as written by record mode to
 * `fixtures/models/<promptId>/<inputSha256>.json` and read back by replay. Holds only the agent's
 * output and usage: never a credential, a request header, or the request beyond the hashes that
 * key it.
 */
export const ModelRecording = z.object({
  schemaVersion: SchemaVersion,
  promptId: PromptId,
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  /** Hash of everything that shapes the answer; the file name. */
  inputSha256: Sha256,
  userSha256: Sha256,
  result: z.object({
    outcome: z.enum(['submitted', 'no-submission', 'budget-exhausted', 'turn-cap']),
    /** Unvalidated, exactly as the agent sent it; the caller parses it against its schema. */
    submission: z.unknown().optional(),
    cost: StageCost,
  }),
  /** Set by a person who scrubbed the submission after recording. Replay never judges it. */
  redacted: z.boolean().optional(),
});
export type ModelRecording = z.infer<typeof ModelRecording>;
