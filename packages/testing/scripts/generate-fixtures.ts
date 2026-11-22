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
import { sha256Hex } from '../src/hash.js';

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
  // v1.1 (CR-1): the Judge's passing check of the patch. No counterexample was admitted in this
  // trial, so the result lists none (a result naming one would not count as a complete check).
  ev('verify', 'judge', 'verify-result', { result: { ...verify, counterexamples: [] } }),
  ev('verify', 'judge', 'stage-exited', { to: 'verdict' }),
  ev('verdict', 'stenographer', 'verdict-written', { verdict }),
]);

// Exhibit content for the gate trial, same ids as its events. The event stream carries only ids,
// so a client needs this to show the patch. Synthetic: the witness code is a placeholder and the
// diff is a short illustrative patch, not one recorded from a run. sha256 is of `code`.
const witnessCode = '/* witness recorded from run [id] */';
const patchCode = '/* patch recorded from run [id] */';
const patchDiff = [
  'diff --git a/app/data/allocations-dao.js b/app/data/allocations-dao.js',
  '--- a/app/data/allocations-dao.js',
  '+++ b/app/data/allocations-dao.js',
  '@@ -12,6 +12,6 @@ function AllocationsDAO(db) {',
  '   // Synthetic fixture patch [id], not recorded from a run.',
  '   this.getByUserId = (userId, threshold, callback) => {',
  '-    const sql = "SELECT * FROM allocations WHERE userId = " + userId + " AND stocks > " + threshold;',
  '-    db.query(sql, callback);',
  '+    const sql = "SELECT * FROM allocations WHERE userId = ? AND stocks > ?";',
  '+    db.query(sql, [userId, threshold], callback);',
  '   };',
  ' }',
  '',
].join('\n');
write('exhibits/nodegoat-sqli-001.exhibits.json', [
  {
    schemaVersion: 1,
    id: 'exhibit-witness-001',
    caseId: caseFile.id,
    author: 'defense',
    code: witnessCode,
    sha256: sha256Hex(witnessCode),
    kind: 'witness',
  },
  {
    schemaVersion: 1,
    id: 'exhibit-patch-001',
    caseId: caseFile.id,
    author: 'remedy',
    code: patchCode,
    sha256: sha256Hex(patchCode),
    kind: 'patch',
    diff: patchDiff,
    filesTouched: ['app/data/allocations-dao.js'],
    linesChanged: 4,
  },
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
