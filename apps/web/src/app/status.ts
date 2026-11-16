import type { Escalation } from '@affidavit/contracts';
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
