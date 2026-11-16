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
export {
  CounterexampleSubmission,
  PatchSubmission,
  SUBMISSIONS,
  WitnessSubmission,
} from './envelope.js';
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
export type { AdmittedWitness, TrialWorkspace } from './workspace.js';
export { buildPatchExhibit, createRemedyHandler, isAccepted } from './remedy.js';
export type { RemedyConfig, RemedyDeps } from './remedy.js';
export type { PatchOutcome } from './workspace.js';
