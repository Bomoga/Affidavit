/**
 * Regenerates the Phase 0 fixtures from the contract samples. Fixtures describe outcomes, not
 * attacks: witness code is a placeholder until a real Judge run records one.
 *
 * Run: pnpm --filter @affidavit/testing generate:fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AdmissibilityRule, samples, type TrialEvent } from '@affidavit/contracts';
import { FIXTURES_DIR } from '../src/fixtures.js';

function write(rel: string, value: unknown): void {
  const file = join(FIXTURES_DIR, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

const caseFile = samples['CaseFile'] as { id: string };
const result = samples['ExhibitResult'] as Record<string, unknown>;
const verify = samples['VerifyResult'] as Record<string, unknown>;

write('casefiles/nodegoat-sqli-001.json', caseFile);
write('exhibit-results/admissible.json', result);

for (const rule of AdmissibilityRule.options) {
  const differential = rule === 'differential';
  write(`exhibit-results/rejected-${rule}.json`, {
    ...result,
    admissible: false,
    rejectedBy: rule,
    vulnPass: differential,
    safeVariantFail: differential ? false : undefined,
    passed: false,
    familyResults: undefined,
    egressAttempts: rule === 'no-egress' ? 1 : 0,
  });
}

write('exhibit-results/verify-pass.json', verify);
write('exhibit-results/verify-fail.json', {
  ...verify,
  familyFlipped: false,
  counterexamples: [{ exhibitId: 'exhibit-counter-001', survived: true }],
  rejectedBy: 'literal-only-patch',
});

let seq = 0;
const at = (n: number): string => new Date(Date.UTC(2026, 10, 5, 12, 0, n)).toISOString();
function ev(
  stage: TrialEvent['stage'],
  actor: TrialEvent['actor'],
  type: TrialEvent['type'],
  payload: unknown,
): unknown {
  const n = seq++;
  return { schemaVersion: 1, caseId: caseFile.id, seq: n, stage, at: at(n), actor, type, payload };
}

const remaining = {
  remainingInputTokens: 900000,
  remainingOutputTokens: 90000,
  remainingUsd: 4.5,
  exhausted: false,
};
const cost = (stage: string): unknown => ({
  stage,
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  wallMs: 0,
  attempt: 1,
});

const verdict = samples['Verdict'] as Record<string, unknown>;
write('trials/nodegoat-sqli-001.events.json', [
  ev('intake', 'stenographer', 'stage-entered', {}),
  ev('intake', 'stenographer', 'stage-exited', { to: 'map' }),
  ev('map', 'stenographer', 'stage-entered', { from: 'intake' }),
  ev('map', 'stenographer', 'stage-exited', { to: 'arraign' }),
  ev('arraign', 'stenographer', 'stage-entered', { from: 'map' }),
  ev('arraign', 'stenographer', 'stage-exited', { to: 'defense' }),
  ev('defense', 'defense', 'stage-entered', { from: 'arraign' }),
  ev('defense', 'defense', 'exhibit-submitted', {
    exhibitId: 'exhibit-witness-001',
    kind: 'witness',
  }),
  ev('defense', 'judge', 'exhibit-result', { result }),
  ev('defense', 'defense', 'cost-charged', { cost: cost('defense'), remaining }),
  ev('defense', 'defense', 'stage-exited', { to: 'prosecution' }),
  ev('prosecution', 'prosecution', 'stage-entered', { from: 'defense' }),
  ev('prosecution', 'prosecution', 'stage-exited', { to: 'remedy' }),
  ev('remedy', 'remedy', 'stage-entered', { from: 'prosecution' }),
  ev('remedy', 'remedy', 'exhibit-submitted', { exhibitId: 'exhibit-patch-001', kind: 'patch' }),
  ev('remedy', 'remedy', 'stage-exited', { to: 'verify' }),
  ev('verify', 'judge', 'stage-entered', { from: 'remedy' }),
  ev('verify', 'judge', 'stage-exited', { to: 'verdict' }),
  ev('verdict', 'stenographer', 'verdict-written', { verdict }),
]);

seq = 0;
const escalation = samples['Escalation'];
write('trials/escalated-001.events.json', [
  ev('defense', 'defense', 'stage-entered', { from: 'arraign' }),
  ev('defense', 'defense', 'exhibit-submitted', {
    exhibitId: 'exhibit-witness-001',
    kind: 'witness',
  }),
  ev('defense', 'judge', 'exhibit-inadmissible', {
    exhibitId: 'exhibit-witness-001',
    rejectedBy: 'stable-3of3',
  }),
  ev('defense', 'defense', 'cost-charged', { cost: cost('defense'), remaining }),
  ev('defense', 'defense', 'exhibit-submitted', {
    exhibitId: 'exhibit-witness-002',
    kind: 'witness',
  }),
  ev('defense', 'judge', 'exhibit-inadmissible', {
    exhibitId: 'exhibit-witness-002',
    rejectedBy: 'differential',
  }),
  ev('defense', 'stenographer', 'escalated', { escalation }),
]);

console.log('fixtures written to', FIXTURES_DIR);
