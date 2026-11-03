// INTERIM types for the web app. Shapes follow packages/trial/src/interim/types.ts and
// docs/lanes/lane3/contracts-draft.md. Replace with @affidavit/contracts when v1.0 lands.

export type Stage =
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

export interface TrialEvent {
  caseId: string;
  seq: number;
  stage: Stage;
  at: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
}

export type Outcome = 'proven-fixed' | 'proven-unfixed' | 'not-proven' | 'dismissed' | 'escalated';

export interface VerdictView {
  caseId: string;
  outcome: Outcome;
  severity?: string;
  exhibits: string[];
  summary: string;
}
