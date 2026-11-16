import type { AdmissibilityRule, Escalation } from '@affidavit/contracts';
import type { CaseStatus } from '../model/caseView.js';

export const STATUS_STAMP: Record<
  CaseStatus,
  { text: string; tone: 'verified' | 'warn' | 'plain' }
> = {
  verified: { text: 'VERIFIED', tone: 'verified' },
  unverified: { text: 'UNVERIFIED', tone: 'warn' },
  'human-review': { text: 'HUMAN REVIEW', tone: 'warn' },
  unfixed: { text: 'NOT FIXED', tone: 'plain' },
  'not-proven': { text: 'NOT PROVEN', tone: 'plain' },
  closed: { text: 'CLOSED', tone: 'plain' },
  'in-progress': { text: 'IN PROGRESS', tone: 'plain' },
};

export const REVIEW_REASON: Record<Escalation['reason'], string> = {
  'no-admissible-witness-above-floor':
    'The Court found a strong candidate but could not produce a test the Judge would admit as proof.',
  'split-jury': 'The jury was split on a question only a person can settle.',
  'budget-exhausted': 'The trial ran out of its budget before it could reach a conclusion.',
};

/** Plain-language reasons for each Judge admissibility rule. Static text, never from content. */
export const RULE_TEXT: Record<AdmissibilityRule, string> = {
  schema: 'The submission did not match the required format.',
  completes: 'The test did not run to completion.',
  'stable-3of3': 'The test did not give the same result on all three repeat runs.',
  'no-egress': 'The test tried to reach the network, which is not allowed.',
  'time-budget': 'The test ran longer than its time budget.',
  differential:
    'The test did not behave differently on the vulnerable code and the known-safe variant.',
  'literal-only-patch': 'The patch only special-cased the test input instead of fixing the cause.',
  'diff-too-large': 'The patch changed more code than the Judge allows.',
  'suite-fails': 'The existing test suite failed with the patch applied.',
  'counterexample-survives': 'A counterexample still worked against the patched code.',
};
