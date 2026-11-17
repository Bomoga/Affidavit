import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../tools/index.js';
import type { CorpusLite, Expectations } from './corpus-regression.js';

export const rulesRoot = (): string => join(repoRoot(), 'packages', 'discovery', 'rules');

export const corpusDataDir = (): string =>
  join(repoRoot(), 'packages', 'corpus', 'data', 'nodegoat');

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

/** The labels, safe variants and negative controls of the NodeGoat corpus entry, as plain data. */
export function loadCorpusLite(): CorpusLite {
  const app = readJson(join(corpusDataDir(), 'app.json')) as CorpusLite;
  return {
    labels: app.labels,
    safeVariants: app.safeVariants,
    negativeControls: app.negativeControls,
  };
}

export function loadExpectations(): Expectations {
  return readJson(join(rulesRoot(), 'corpus-expectations.json')) as Expectations;
}

/**
 * What the last passing corpus regression ran against. Written only by the Docker test (with
 * AFFIDAVIT_RULES_STAMP=write), read by the plain unit test that fails when the rules changed
 * without a new run. Scalars only, so Prettier leaves the file as written.
 */
export interface RegressionStamp {
  rulesSha256: string;
  semgrepImage: string;
  nodegoatCommit: string;
  ranOn: string;
}

const stampFile = (): string => join(rulesRoot(), 'regression-stamp.json');

export function readStamp(): RegressionStamp {
  return readJson(stampFile()) as RegressionStamp;
}

export function writeStamp(stamp: RegressionStamp): void {
  writeFileSync(stampFile(), JSON.stringify(stamp, null, 2) + '\n');
}
