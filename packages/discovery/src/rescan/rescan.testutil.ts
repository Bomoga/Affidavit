// Helpers shared by the re-scan tests. Not part of the API (left out of the build).
import { cpSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CaseFile } from '@affidavit/contracts';
import { repoRoot } from '../tools/index.js';

export const NORMALIZE = join(repoRoot(), 'fixtures', 'corpus', 'normalize');
export const RESCAN = join(repoRoot(), 'fixtures', 'corpus', 'rescan');
/** The test-only Semgrep rules the recorded SARIF was produced with. */
export const RULES = join(NORMALIZE, 'rules', 'semgrep');

export const NOSQL_WHERE = 'affidavit.normalize.nosql-where';
export const SQL_CONCAT = 'affidavit.normalize.sql-concat';

/**
 * The trees the recorded SARIF comes from: `vulnerable` is the normalizer repo; `patched` has the
 * `$where` sink fixed; `shifted` moves every line down by two and fixes nothing.
 */
export type Variant = 'vulnerable' | 'patched' | 'shifted';

function dropFixtureSuffix(dir: string): void {
  for (const entry of readdirSync(dir)) {
    let p = join(dir, entry);
    const name = entry.replace(/\.fixture$/, '');
    if (name !== entry) {
      renameSync(p, join(dir, name));
      p = join(dir, name);
    }
    if (statSync(p).isDirectory()) dropFixtureSuffix(p);
  }
}

/** Writes the variant's source tree into `dir` (which must not exist yet). */
export function buildTree(variant: Variant, dir: string): string {
  cpSync(join(NORMALIZE, 'repo'), dir, { recursive: true });
  dropFixtureSuffix(dir);
  if (variant !== 'vulnerable') {
    cpSync(join(RESCAN, variant, 'src', 'routes.js.fixture'), join(dir, 'src', 'routes.js'));
  }
  return dir;
}

/**
 * Semgrep SARIF for that tree. `vulnerable` is the real recording of the normalizer repo; the
 * other two are derived from it by hand (see fixtures/corpus/rescan/README.md).
 */
export function sarifFor(variant: Variant): string {
  const path =
    variant === 'vulnerable'
      ? join(NORMALIZE, 'recorded', 'semgrep.sarif.fixture')
      : join(RESCAN, 'derived', `semgrep-${variant}.sarif.fixture`);
  return readFileSync(path, 'utf8');
}

/** A contract-valid case file whose candidate is `ruleId` at `line` of `file`. */
export function caseFileFor(
  ruleId: string,
  file: string,
  line: number,
  tool: CaseFile['candidate']['tool'] = 'semgrep',
): CaseFile {
  const base = CaseFile.parse(
    JSON.parse(
      readFileSync(
        join(repoRoot(), 'fixtures', 'casefiles', 'nodegoat-nosqli-where-001.json'),
        'utf8',
      ),
    ),
  );
  return CaseFile.parse({
    ...base,
    candidate: {
      ...base.candidate,
      tool,
      ruleId,
      file,
      range: { startLine: line, endLine: line },
    },
  });
}
