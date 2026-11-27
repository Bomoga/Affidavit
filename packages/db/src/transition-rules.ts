import { MAX_APPEALS, isLegalTransition, type CaseStage } from '@affidavit/contracts';

export interface TransitionState {
  from: CaseStage;
  to: CaseStage;
  score: number;
  escalationFloor: number;
  appeals: number;
  juryEnabled: boolean;
}

/**
 * Returns why the transition is illegal, or null when it is allowed. Same rules, in the same
 * order, as FakeCaseStore in packages/testing: the table, then F3, then appeals, then jury.
 */
export function rejectTransition(s: TransitionState): string | null {
  if (!isLegalTransition(s.from, s.to)) return 'not in the transition table';
  // F3 applies to every way into `dismissed` (CR-3), not only defense.
  if (s.to === 'dismissed' && s.score >= s.escalationFloor) {
    return 'score is at or above the escalation floor, so the case cannot be dismissed (F3)';
  }
  if (s.from === 'verify' && s.to === 'remedy' && s.appeals >= MAX_APPEALS) {
    return `appeal limit of ${MAX_APPEALS} reached`;
  }
  if (s.from === 'verify' && s.to === 'jury' && !s.juryEnabled) return 'jury is disabled';
  // With the jury enabled every verdict passes through it, appeals exhausted or not (CR-3).
  if (s.from === 'verify' && s.to === 'verdict' && s.juryEnabled) {
    return 'jury is enabled; verify must go to jury, remedy, or escalated';
  }
  return null;
}
