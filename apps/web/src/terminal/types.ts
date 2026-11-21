import type {
  AdmissibilityRule,
  CaseStage,
  Role,
  TargetVariant,
  TrialEventType,
  Verdict,
} from '@affidavit/contracts';
import type { CaseStatus } from '../model/caseView.js';

// Shared contract for the trial terminal (L3-13): a dense, data-first view of one trial. The view
// is a pure function of the recorded events (plus exhibit content when a source has it). Fields
// marked "recorded" hold text from the record: untrusted, rendered as plain text only.

export type Tone = 'pos' | 'neg' | 'warn' | 'neutral';

/** The panels of the terminal. A bubble points at exactly one. */
export type PanelId =
  'stages' | 'evidence' | 'verify' | 'diff' | 'arguments' | 'jury' | 'cost' | 'tape' | 'verdict';

export interface StageCell {
  stage: CaseStage;
  state: 'pending' | 'active' | 'done';
  /** Stage the record says came next, when it has exited. */
  exitedTo?: CaseStage;
  /** Attempts charged to this stage (from cost events). 0 when none recorded. */
  attempts: number;
  /** Sum of recorded wall time for the stage, when any cost was charged. */
  wallMs?: number;
}

export interface RunCell {
  variant: TargetVariant;
  attempt: number;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
}

/** One exhibit and everything the Judge recorded about it. */
export interface EvidenceRow {
  /** Recorded id. */
  id: string;
  kind: 'witness' | 'counterexample' | 'patch';
  /** Who submitted it, from the submitting event's actor. */
  author: Role;
  /** `pending` means no Judge ruling is recorded, which is not a rejection. */
  state: 'pending' | 'admitted' | 'rejected';
  rejectedBy?: AdmissibilityRule;
  runs: RunCell[];
  /** The differential: behavior on the vulnerable code against the known-safe variant. */
  vulnPass?: boolean;
  /** Absent when there is no safe variant to compare against. */
  safeVariantFail?: boolean;
  egressAttempts?: number;
  /** One entry per member of the parameter family, in order. */
  family?: boolean[];
  durationMs?: number;
}

export type VerifyCheck = 'family-flipped' | 'suite-passed' | 'rescan-clean' | 'counterexamples';

/** One Judge patch check. Appeals produce one per round. */
export interface VerifyRow {
  seq: number;
  /** Recorded id. */
  patchExhibitId: string;
  /** False when the event is not the Judge's own check in the verify stage before the verdict. */
  counts: boolean;
  /** True only when it counts and every check passed. */
  accepted: boolean;
  checks: { check: VerifyCheck; ok: boolean }[];
  counterexamples: { exhibitId: string; survived: boolean }[];
  rejectedBy?: AdmissibilityRule;
}

export interface DiffLine {
  kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx';
  oldNo?: number;
  newNo?: number;
  /**
   * Recorded. For add, del and numbered ctx lines the leading `+`, `-` or space marker is
   * removed (`kind` carries it); file and hunk rows keep the whole line.
   */
  text: string;
}

/** The patch as submitted. Present only when a source served the exhibit content. */
export interface DiffView {
  /** Recorded id. */
  exhibitId: string;
  /** Recorded. */
  filesTouched: string[];
  linesChanged: number;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface CostRow {
  stage: CaseStage;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  wallMs: number;
}

export interface CostView {
  rows: CostRow[];
  total: { inputTokens: number; outputTokens: number; usd: number; wallMs: number };
  /** Budget left after the latest charge, as recorded. Absent before any charge. */
  remaining?: {
    inputTokens: number;
    outputTokens: number;
    usd: number;
    exhausted: boolean;
  };
}

export interface BallotRow {
  seq: number;
  /** Recorded. */
  jurorId: string;
  mandate: 'security' | 'maintainability' | 'blast-radius';
  /** Recorded. */
  model: string;
  question: 'severity' | 'fix-minimality' | 'merge-risk' | 'evidence-sufficiency';
  vote: string;
  confidence: number;
  /** Recorded ids. */
  citedExhibits: string[];
  /** Recorded. */
  inputVariant: string;
}

export interface TapeRow {
  seq: number;
  /** Recorded ISO time. */
  at: string;
  stage: CaseStage;
  actor: Role;
  type: TrialEventType;
  /** Static wording around recorded ids, same rules as the docket labels. */
  text: string;
  tone: Tone;
}

/**
 * An explanation pinned to a panel, spoken by one agent. `title` and `body` are static wording
 * built from structured fields. Free text from the record goes in `quote` and nowhere else.
 */
export interface Bubble {
  id: string;
  agent: Role;
  /** Extra label for jurors: their mandate. Enum values only. */
  agentDetail?: BallotRow['mandate'];
  anchor: PanelId;
  tone: Tone;
  title: string;
  body: string;
  /** Recorded: an objection claim, an escalation detail, a dismissal note. */
  quote?: string;
  /** Recorded exhibit ids this bubble is about. */
  cites: string[];
  seq: number;
}

export interface VerdictView {
  outcome: Verdict['outcome'];
  severity?: Verdict['severity'];
  /** Recorded. */
  bundleSha256?: string;
  /** Recorded: prompt id to model id and prompt version, only for prompts that ran. */
  models: { prompt: string; model?: string; version?: string }[];
  jurorCorrelation?: number;
  /** Recorded ids. */
  exhibits: string[];
}

export interface TerminalView {
  /** Recorded. */
  caseId: string;
  status: CaseStatus;
  /** True only when the case view earned the VERIFIED stamp. */
  verified: boolean;
  awaitingVerification: boolean;
  eventCount: number;
  lastSeq: number;
  /** All eleven stages in contract order. */
  stages: StageCell[];
  evidence: EvidenceRow[];
  verify: VerifyRow[];
  diff: DiffView | undefined;
  cost: CostView;
  ballots: BallotRow[];
  tape: TapeRow[];
  bubbles: Bubble[];
  verdict: VerdictView | undefined;
}
