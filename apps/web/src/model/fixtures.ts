// PLACEHOLDER fixtures. Move to fixtures/trials/*.events.json once P0-05 lands, and keep
// them in step with contracts v1.0. Witness and patch bodies are placeholders, not attacks.

import type { TrialEvent } from './types.js';

const T0 = Date.parse('2026-11-03T12:00:00Z');
let n = 0;
const ev = (
  caseId: string,
  stage: TrialEvent['stage'],
  type: string,
  actor: string,
  payload: Record<string, unknown> = {},
): TrialEvent => ({
  caseId,
  seq: ++n,
  stage,
  at: new Date(T0 + n * 1000).toISOString(),
  actor,
  type,
  payload,
});

function gateCase(): TrialEvent[] {
  n = 0;
  const id = 'nodegoat-sqli-001';
  return [
    ev(id, 'defense', 'stage-entered', 'defense', { attempt: 1 }),
    ev(id, 'defense', 'exhibit-submitted', 'defense', { kind: 'witness', exhibitId: 'ex_w1' }),
    ev(id, 'defense', 'exhibit-result', 'judge', {
      exhibitId: 'ex_w1',
      admissible: true,
      passed: true,
      rejectedBy: null,
      runs: [
        {
          variant: 'vulnerable',
          attempt: 1,
          passed: true,
          log: '/* run log recorded from run [metric] */',
        },
        {
          variant: 'safe',
          attempt: 1,
          passed: false,
          log: '/* run log recorded from run [metric] */',
        },
      ],
    }),
    ev(id, 'remedy', 'stage-entered', 'remedy', { attempt: 1 }),
    ev(id, 'remedy', 'patch-submitted', 'remedy', {
      exhibitId: 'ex_p1',
      filesTouched: ['routes/a.js'],
    }),
    ev(id, 'remedy', 'patch-verified', 'judge', { accepted: true, exhibitId: 'ex_p1' }),
    ev(id, 'verify', 'verdict-written', 'judge', {
      outcome: 'proven-fixed',
      verdict: {
        caseId: id,
        outcome: 'proven-fixed',
        exhibits: ['ex_w1', 'ex_p1'],
        summary:
          'Case nodegoat-sqli-001: A security weakness was proven with an exploit that can be replayed, and a fix was shown to stop it. Evidence cited: ex_w1, ex_p1.',
      },
    }),
  ];
}

function escalatedCase(): TrialEvent[] {
  n = 0;
  const id = 'escalated-001';
  return [
    ev(id, 'defense', 'stage-entered', 'defense', { attempt: 1 }),
    ev(id, 'defense', 'exhibit-inadmissible', 'defense', { rule: 'schema', schemaRef: 'Witness' }),
    ev(id, 'defense', 'escalated', 'judge', {
      reason: 'no-admissible-witness-above-floor',
      detail: 'two Defense attempts produced no admissible witness',
    }),
  ];
}

export const GATE_CASE_EVENTS: readonly TrialEvent[] = gateCase();
export const ESCALATED_CASE_EVENTS: readonly TrialEvent[] = escalatedCase();
