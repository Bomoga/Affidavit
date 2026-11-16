export {
  BudgetExhaustedError,
  EVENT_ACTOR_FOR_STAGE,
  EscalationNotAllowedError,
  KillSwitchError,
  MODEL_ROLE_FOR_STAGE,
  Orchestrator,
  RetryStageError,
} from './orchestrator.js';
export type {
  AgentRequest,
  EscalationReason,
  EventPayload,
  ModelTurnRequest,
  ModelTurnResult,
  OrchestratorConfig,
  OrchestratorDeps,
  RunOutcome,
  StageContext,
  StageHandler,
  StageResult,
  TrialEventType,
} from './orchestrator.js';
export { ActorMismatchError } from './orchestrator.js';
export type { ValidatedAgentResult } from './orchestrator.js';
export { ROLE_TOOLS, assertAllowedTools, isModelRole } from './roles.js';
export type { ModelRole } from './roles.js';
export { PatchSubmission, SUBMISSIONS, WitnessSubmission } from './envelope.js';
export type { BallotSubmission, SubmissionCheck, SubmissionSpec } from './envelope.js';
export { createDefenseHandler, loadCaseFile } from './defense.js';
export type {
  DefenseAttemptConfig,
  DefenseConfig,
  DefenseDeps,
  PromptRenderer,
} from './defense.js';
export { buildWitness, variantsFor, witnessExhibitId, witnessSha256 } from './witness.js';
export { InMemoryWorkspace } from './workspace.js';
export type {
  AdmittedCounterexample,
  AdmittedWitness,
  PatchOutcome,
  TrialWorkspace,
} from './workspace.js';
export {
  DEFAULT_PARAM_LIMITS,
  buildCounterexample,
  checkCounterexampleSubmission,
  counterexampleCode,
  counterexampleExhibitId,
  paramsHeader,
  resolveCounterexample,
} from './counterexample.js';
export type {
  BuiltCounterexample,
  CounterexampleChoice,
  CounterexampleSubmission,
  ParamLimits,
  ResolvedCounterexample,
} from './counterexample.js';
export { createProsecutionHandler } from './prosecution.js';
export type { ProsecutionConfig, ProsecutionDeps } from './prosecution.js';
export { survivingCounterexamples } from './verify.js';
export { createRemedyHandler } from './remedy.js';
export type { RemedyConfig, RemedyDeps } from './remedy.js';
export { buildPatchExhibit, diffStats, isAccepted, rejectionRule } from './patch.js';
export type { DiffStats } from './patch.js';
export {
  buildVerdict,
  checkSummary,
  decideOutcome,
  finalizeVerdict,
  lintGeneratedText,
  renderSummary,
} from './verdict.js';
export type { StructuredVerdict, VerdictInput, VerdictOutcome } from './verdict.js';
export { createVerifyHandler } from './verify.js';
export type { VerifyDeps } from './verify.js';
export type { RunInfo } from './orchestrator.js';
