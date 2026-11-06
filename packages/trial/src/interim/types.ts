// INTERIM TYPES. Approved by Adrian to unblock L3-01 while Phase 0 is pending.
// Shapes follow docs/lanes/lane3/contracts-draft.md (PR 4) and implementation-plan 3.2 and 3.3.
// TODO(P0-03, P0-04): delete this file and import from @affidavit/contracts when v1.0 lands.
// Nothing outside packages/trial may import from here.

export type CaseStage =
  | 'intake'
  | 'map'
  | 'arraign'
  | 'defense'
  | 'prosecution'
  | 'remedy'
  | 'verify'
  | 'jury'
  | 'verdict'
  | 'dismissed'
  | 'escalated';

export const TERMINAL_STAGES: readonly CaseStage[] = ['verdict', 'dismissed', 'escalated'];

export function isTerminal(stage: CaseStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export type Role = 'defense' | 'prosecution' | 'remedy' | 'juror' | 'judge' | 'stenographer';

export interface StageCost {
  stage: CaseStage;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  wallMs: number;
  attempt: number;
}

export type EscalationReason =
  'no-admissible-witness-above-floor' | 'split-jury' | 'budget-exhausted';

export interface Escalation {
  caseId: string;
  reason: EscalationReason;
  detail: string;
}

export type TrialEventType =
  | 'stage-entered'
  | 'stage-exited'
  | 'cost-charged'
  | 'budget-exhausted'
  | 'exhibit-inadmissible'
  | 'exhibit-submitted'
  | 'exhibit-result'
  | 'dismissed'
  | 'patch-submitted'
  | 'patch-rejected'
  | 'patch-verified'
  | 'verdict-written'
  | 'escalated';

export interface TrialEvent {
  caseId: string;
  seq: number;
  stage: CaseStage;
  at: string;
  actor: Role;
  type: TrialEventType;
  payload: Record<string, unknown>;
}

/** Closed union: no tool in this type can run code or reach the network. */
export type SubmitToolName =
  'submit_witness' | 'submit_counterexample' | 'submit_patch' | 'submit_ballot';

export interface Budget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxUsd: number;
}

export interface ModelTurnRequest {
  promptId: string;
  promptVersion: string;
  model: string;
  system: string;
  user: string;
  tools: readonly SubmitToolName[];
  outputSchemaRef: string;
  maxTurns: number;
  budget: Budget;
}

export interface ModelTurnResult {
  outcome: 'submitted' | 'no-submission' | 'budget-exhausted' | 'turn-cap';
  submission?: unknown;
  cost: StageCost;
}

export interface ModelPort {
  runTurn(req: ModelTurnRequest): Promise<ModelTurnResult>;
}

export interface ChargeReceipt {
  chargeId: string;
  remainingUsd: number;
  remainingTokens: number;
}

export interface CaseStore {
  getStage(caseId: string): Promise<CaseStage>;
  /** Rejects illegal transitions. */
  transition(caseId: string, to: CaseStage): Promise<void>;
  /** Charge a reservation. Remaining may go negative; the caller must then stop. */
  chargeBudget(caseId: string, cost: StageCost): Promise<ChargeReceipt>;
  /** Replace a reservation with what the call actually cost. */
  settleCost(caseId: string, chargeId: string, actual: StageCost): Promise<void>;
  recordEscalation(escalation: Escalation): Promise<void>;
  nextSeq(caseId: string): Promise<number>;
  /** Settled cost rows for the case, in order. */
  getCosts(caseId: string): Promise<StageCost[]>;
}

export interface EventSink {
  emit(event: TrialEvent): Promise<void>;
}

export type SchemaValidation = { ok: true } | { ok: false; errors: string[] };

/** Validates an agent submission against the named contracts schema. */
export type SchemaValidator = (schemaRef: string, value: unknown) => SchemaValidation;

// Interim shapes for the Defense stage. Replace with contracts v1.0 (CaseFile, Witness,
// ExhibitResult) and the JudgePort when P0-03 lands.
export interface CaseFile {
  id: string;
  /** Candidates scoring at or above this are never dismissed on one attempt (F3). */
  escalationFloor: number;
  candidate: { id: string; cls: 'injection' | 'idor'; score: number };
  /** Already stripped of comments and prose by discovery. Still untrusted. */
  slices: { file: string; code: string }[];
}

export interface WitnessSubmission {
  template: string;
  params: unknown;
}

export interface JudgeResult {
  exhibitId: string;
  admissible: boolean;
  rejectedBy?: string;
  passed: boolean;
  detail?: string;
}

export interface JudgePort {
  runWitness(caseFile: CaseFile, witness: WitnessSubmission): Promise<JudgeResult>;
  verifyPatch(
    caseFile: CaseFile,
    patch: PatchSubmission,
    witness: WitnessSubmission,
    counterexampleIds: readonly string[],
  ): Promise<VerifyResult>;
}

// Interim Remedy shapes. Replace with PatchExhibit and VerifyResult from contracts v1.0.
export interface PatchSubmission {
  diff: string;
  filesTouched: string[];
  linesChanged: number;
}

export type VerifyRejection =
  'literal-only-patch' | 'diff-too-large' | 'suite-fails' | 'counterexample-survives';

export interface VerifyResult {
  familyFlipped: boolean;
  suitePassed: boolean;
  rescanClean: boolean;
  patchExhibitId?: string;
  counterexamples: { exhibitId: string; survived: boolean }[];
  rejectedBy?: VerifyRejection;
  detail?: string;
}

export function isAccepted(r: VerifyResult): boolean {
  return (
    r.rejectedBy === undefined &&
    r.familyFlipped &&
    r.suitePassed &&
    r.rescanClean &&
    r.counterexamples.every((c) => !c.survived)
  );
}

export interface PatchOutcome {
  accepted: boolean;
  patch?: PatchSubmission;
  result?: VerifyResult;
  reason?: string;
}

// Interim Verdict shape, following docs/lanes/lane3/contracts-draft.md. Replace with contracts v1.0.
export type VerdictOutcome =
  'proven-fixed' | 'proven-unfixed' | 'not-proven' | 'dismissed' | 'escalated';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** Everything in a verdict except the plain-language summary. Built first. */
export interface StructuredVerdict {
  schemaVersion: 1;
  caseId: string;
  outcome: VerdictOutcome;
  severity?: Severity;
  exhibits: string[];
  ballots: unknown[];
  jurorCorrelation?: number;
  bundleSha256?: string;
  /** Keyed by prompt id, per the decision on contracts draft issue A. */
  promptVersions: Record<string, string>;
  modelIds: Record<string, string>;
  cost: StageCost[];
}

export interface Verdict extends StructuredVerdict {
  summary: string;
}

/** Interim handoff between stages until an exhibit store exists in the real ports. */
export interface TrialWorkspace {
  saveWitness(caseId: string, witness: WitnessSubmission): Promise<void>;
  getWitness(caseId: string): Promise<WitnessSubmission | undefined>;
  savePatchOutcome(caseId: string, outcome: PatchOutcome): Promise<void>;
  getPatchOutcome(caseId: string): Promise<PatchOutcome | undefined>;
  /** Exhibit ids the Judge admitted or verified, in the order they were produced. */
  addExhibit(caseId: string, exhibitId: string): Promise<void>;
  getExhibits(caseId: string): Promise<string[]>;
  saveVerdict(caseId: string, verdict: Verdict): Promise<void>;
  getVerdict(caseId: string): Promise<Verdict | undefined>;
}

export interface RenderedPrompt {
  promptId: string;
  version: string;
  outputSchemaRef: string;
  system: string;
  user: string;
}

/** Matches renderPrompt in @affidavit/prompts. Injected so trial does not depend on it directly. */
export type PromptRenderer = (
  id: string,
  blocks: readonly { label: string; content: string }[],
) => RenderedPrompt;
