import type { Budget, BudgetState, CaseId, CaseStage, StageCost, TenantId } from '../common.js';
import type { CaseFile } from '../discovery.js';
import type {
  Attestation,
  BundleManifest,
  Exhibit,
  ExhibitResult,
  PatchExhibit,
  VerifyResult,
  Witness,
} from '../evidence.js';
import type { Candidate } from '../discovery.js';
import type { TargetVariant } from '../common.js';
import type { TrialEvent, Verdict } from '../trial.js';

/** Lane 2 provides, Lane 3 consumes. An inadmissible exhibit is a value, never a thrown error. */
export interface JudgePort {
  runWitness(
    caseFile: CaseFile,
    witness: Witness,
    variants: readonly TargetVariant[],
  ): Promise<ExhibitResult>;
  runCounterexample(
    caseFile: CaseFile,
    witness: Witness,
    counterexample: Exhibit,
  ): Promise<ExhibitResult>;
  verifyPatch(
    caseFile: CaseFile,
    patch: PatchExhibit,
    witness: Witness,
    counterexamples: readonly Exhibit[],
  ): Promise<VerifyResult>;
}

/** Lane 1 provides, Lane 2 consumes inside verifyPatch (L2-07). */
export interface RescanPort {
  rescan(
    caseFile: CaseFile,
    patchedWorkspacePath: string,
  ): Promise<{ clean: boolean; candidates: readonly Candidate[] }>;
}

export interface ToolRunnerPort {
  run(
    image: string,
    args: readonly string[],
    mounts: readonly { hostPath: string; containerPath: string; readOnly: boolean }[],
  ): Promise<{ exitCode: number; outputPath: string }>;
}

export interface CaseFileSource {
  next(tenantId: TenantId): Promise<CaseFile | null>;
  get(caseId: CaseId): Promise<CaseFile | null>;
}

/** Idempotent on (caseId, seq): emitting the same event twice stores it once. */
export interface EventSink {
  emit(event: TrialEvent): Promise<void>;
}

export interface CaseStore {
  /** Registers a case at stage `intake` with its budget. */
  open(caseFile: CaseFile, budget: Budget): Promise<void>;
  stage(caseId: CaseId): Promise<CaseStage>;
  /** Rejects illegal transitions with IllegalTransitionError. */
  transition(caseId: CaseId, to: CaseStage): Promise<void>;
  /** Called BEFORE the retry it pays for. Returns what is left; never throws on exhaustion. */
  chargeBudget(caseId: CaseId, cost: StageCost): Promise<BudgetState>;
  nextSeq(caseId: CaseId): Promise<number>;
  /** Append-only. A second verdict for a case throws VerdictAlreadyWrittenError. */
  appendVerdict(verdict: Verdict): Promise<void>;
  getVerdict(caseId: CaseId): Promise<Verdict | null>;
}

export interface EvidenceStore {
  put(bytes: Uint8Array): Promise<string>;
  get(sha256: string): Promise<Uint8Array | null>;
}

export interface SignerPort {
  sign(manifest: BundleManifest): Promise<Attestation>;
}

export type SubmitToolName =
  'submit_witness' | 'submit_counterexample' | 'submit_patch' | 'submit_ballot';

/**
 * Lane 3 provides and consumes. `SubmitToolName` is a closed union, so "no shell, no network" is a
 * type-level property: there is no tool name that could execute code or reach a host.
 */
export interface ModelPort {
  runTurn(req: {
    promptId: string;
    promptVersion: string;
    model: string;
    /** Static prompt text only. */
    system: string;
    /** Untrusted content, already wrapped and labeled. */
    user: string;
    tools: readonly SubmitToolName[];
    outputSchemaRef: string;
    maxTurns: number;
    budget: Budget;
  }): Promise<{
    outcome: 'submitted' | 'no-submission' | 'budget-exhausted' | 'turn-cap';
    /** Unvalidated; the caller parses it against the contracts schema. */
    submission?: unknown;
    cost: StageCost;
  }>;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: CaseStage,
    readonly to: CaseStage,
    readonly why: string,
  ) {
    super(`illegal transition ${from} -> ${to}: ${why}`);
    this.name = 'IllegalTransitionError';
  }
}

export class VerdictAlreadyWrittenError extends Error {
  constructor(readonly caseId: CaseId) {
    super(`verdict already written for case ${caseId}`);
    this.name = 'VerdictAlreadyWrittenError';
  }
}
