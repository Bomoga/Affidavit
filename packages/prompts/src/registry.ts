import { DEFENSE } from './roles/defense.js';
import { DEFENSE_SECOND_ATTEMPT } from './roles/defense-second-attempt.js';
import { JUROR_BLAST_RADIUS, JUROR_MAINTAINABILITY, JUROR_SECURITY } from './roles/jurors.js';
import { PROSECUTION } from './roles/prosecution.js';
import { REMEDY } from './roles/remedy.js';
import type { PromptDefinition, PromptId } from './types.js';

export const PROMPTS: Readonly<Record<PromptId, PromptDefinition>> = {
  defense: DEFENSE,
  'defense-second-attempt': DEFENSE_SECOND_ATTEMPT,
  prosecution: PROSECUTION,
  remedy: REMEDY,
  'juror-security': JUROR_SECURITY,
  'juror-maintainability': JUROR_MAINTAINABILITY,
  'juror-blast-radius': JUROR_BLAST_RADIUS,
};

export const PROMPT_IDS = [
  'defense',
  'defense-second-attempt',
  'prosecution',
  'remedy',
  'juror-security',
  'juror-maintainability',
  'juror-blast-radius',
] as const satisfies readonly PromptId[];

export function getPrompt(id: PromptId): PromptDefinition {
  return PROMPTS[id];
}
