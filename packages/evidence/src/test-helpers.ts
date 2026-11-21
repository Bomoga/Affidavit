import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CaseFile,
  ExhibitResult,
  VerifyResult,
  Verdict,
  samples,
  type Exhibit,
  type JudgePort,
  type PatchExhibit,
  type TargetVariant,
  type Witness,
} from '@affidavit/contracts';
import type { BundleInput, ExhibitRecord } from './bundle.js';

// Test-only helpers. Not exported from index.ts.

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const fixture = (rel: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8')) as unknown;

export const VULN_DIGEST = `sha256:${'a'.repeat(64)}`;
export const SAFE_DIGEST = `sha256:${'b'.repeat(64)}`;

export const caseFile = (pinned = true): CaseFile => {
  const cf = CaseFile.parse(fixture('casefiles/nodegoat-sqli-001.json'));
  if (!pinned) return cf;
  return {
    ...cf,
    target: { ...cf.target, imageDigest: VULN_DIGEST },
    safeVariant: { ...cf.safeVariant!, imageDigest: SAFE_DIGEST },
  };
};

export const WITNESS = {
  schemaVersion: 1,
  id: 'witness-sqli-001',
  caseId: 'case-nodegoat-sqli-001',
  cls: 'injection',
  template: '/* hand-written gate witness stand-in */',
  params: [{ name: 'payload', values: ["'", "1' OR '1'='1"] }],
  author: 'defense',
  sha256: '1'.repeat(64),
};

export const COUNTEREXAMPLE = {
  schemaVersion: 1,
  id: 'submitted-counter-id',
  caseId: 'case-nodegoat-sqli-001',
  author: 'prosecution',
  kind: 'counterexample',
  code: '/* counterexample */',
  sha256: '2'.repeat(64),
};

export const PATCH = {
  schemaVersion: 1,
  id: 'submitted-patch-id',
  caseId: 'case-nodegoat-sqli-001',
  author: 'remedy',
  kind: 'patch',
  code: 'diff',
  sha256: '3'.repeat(64),
  diff: 'diff --git a/app/data/allocations-dao.js b/app/data/allocations-dao.js\n',
  filesTouched: ['app/data/allocations-dao.js'],
  linesChanged: 3,
};

export const witnessResult = (): ExhibitResult =>
  ExhibitResult.parse(fixture('exhibit-results/admissible.json'));

export const counterResult = (): ExhibitResult => ({
  ...witnessResult(),
  exhibitId: 'exhibit-counter-001' as ExhibitResult['exhibitId'],
});

export const verifyResult = (): VerifyResult =>
  VerifyResult.parse(fixture('exhibit-results/verify-pass.json'));

export const records = (): ExhibitRecord[] => [
  { schemaVersion: 1, kind: 'witness', witness: WITNESS, result: witnessResult() },
  {
    schemaVersion: 1,
    kind: 'counterexample',
    witnessExhibitId: 'exhibit-witness-001' as ExhibitResult['exhibitId'],
    counterexample: COUNTEREXAMPLE,
    result: counterResult(),
  },
  {
    schemaVersion: 1,
    kind: 'patch',
    witnessExhibitId: 'exhibit-witness-001' as ExhibitResult['exhibitId'],
    counterexampleExhibitIds: ['exhibit-counter-001' as ExhibitResult['exhibitId']],
    patch: PATCH,
    result: verifyResult(),
  },
];

export const verdict = (): Verdict => Verdict.parse(samples['Verdict']);

export const bundleInput = (over: Partial<BundleInput> = {}): BundleInput => ({
  caseFile: caseFile(),
  verdict: verdict(),
  exhibits: records(),
  toolVersions: { 'witness-runner': 'sha256:' + 'c'.repeat(64), judge: '0.0.0' },
  createdAt: '2026-11-17T12:00:00.000Z',
  ...over,
});

export interface JudgeCall {
  method: 'runWitness' | 'runCounterexample' | 'verifyPatch';
  caseFile: CaseFile;
  args: unknown[];
}

/**
 * A Judge that answers with the recorded results, so a replay matches unless a test changes one.
 * `override` lets a test return a different result or throw for one method.
 */
export class ScriptedJudge implements JudgePort {
  readonly calls: JudgeCall[] = [];

  constructor(
    private readonly override: Partial<{
      runWitness: () => ExhibitResult;
      runCounterexample: () => ExhibitResult;
      verifyPatch: () => VerifyResult;
    }> = {},
  ) {}

  runWitness(cf: CaseFile, w: Witness, variants: readonly TargetVariant[]): Promise<ExhibitResult> {
    this.calls.push({ method: 'runWitness', caseFile: cf, args: [w, variants] });
    return Promise.resolve().then(() => (this.override.runWitness ?? witnessResult)());
  }

  runCounterexample(cf: CaseFile, w: Witness, c: Exhibit): Promise<ExhibitResult> {
    this.calls.push({ method: 'runCounterexample', caseFile: cf, args: [w, c] });
    return Promise.resolve().then(() => (this.override.runCounterexample ?? counterResult)());
  }

  verifyPatch(
    cf: CaseFile,
    p: PatchExhibit,
    w: Witness,
    cs: readonly Exhibit[],
  ): Promise<VerifyResult> {
    this.calls.push({ method: 'verifyPatch', caseFile: cf, args: [p, w, cs] });
    return Promise.resolve().then(() => (this.override.verifyPatch ?? verifyResult)());
  }
}
