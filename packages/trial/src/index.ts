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
export { createDefenseHandler } from './defense.js';
export type { DefenseAttemptConfig, DefenseConfig, DefenseDeps } from './defense.js';
