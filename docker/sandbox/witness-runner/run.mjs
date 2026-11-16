// Affidavit witness runner (L2-05). Fixed code baked into the runner image; never edited per case.
//
// Runs the witness test file with Vitest, one test per parameter of the family, and writes the
// result artifact (packages/judge/src/artifact.ts) with one entry per parameter. The artifact is
// written only when every parameter index 0..n-1 was reported exactly once; anything else
// (syntax error, import failure, witness() not called or called twice) writes nothing, which the
// Judge rejects as `completes`.
import { readFileSync, writeFileSync } from 'node:fs';
import { startVitest } from 'vitest/node';

const WITNESS_DIR = '/runner/witness';
const RESULT = '/out/result.json';
const PARAM_TEST = /^affidavit param (0|[1-9]\d*)$/;

const input = JSON.parse(readFileSync(`${WITNESS_DIR}/input.json`, 'utf8'));
const size = input.params.reduce((n, p) => n * p.values.length, 1);

let results = null;
const artifactReporter = {
  onTestRunEnd(testModules) {
    const seen = new Map();
    for (const mod of testModules) {
      for (const test of mod.children.allTests()) {
        const m = PARAM_TEST.exec(test.name);
        if (m === null) continue;
        const index = Number(m[1]);
        if (seen.has(index) || index >= size) return;
        seen.set(index, test.result().state === 'passed');
      }
    }
    if (seen.size !== size) return;
    results = Array.from({ length: size }, (_, i) => seen.get(i) === true);
  },
};

const vitest = await startVitest(
  'test',
  [],
  {
    root: WITNESS_DIR,
    include: ['witness.test.ts'],
    config: false,
    watch: false,
    reporters: ['default', artifactReporter],
    disableConsoleIntercept: true,
    pool: 'forks',
    fileParallelism: false,
    testTimeout: input.testTimeoutMs,
    hookTimeout: input.testTimeoutMs,
    teardownTimeout: 1000,
    passWithNoTests: true,
    fsModuleCache: false,
    alias: { '@affidavit/witness': '/runner/witness-api.mjs' },
  },
  { cacheDir: '/scratch/vite', logLevel: 'error', configFile: false },
);
await vitest?.close();

if (results !== null) {
  writeFileSync(
    RESULT,
    JSON.stringify({
      schemaVersion: 1,
      results: results.map((passed, paramIndex) => ({ paramIndex, passed })),
    }),
  );
}
process.exit(results === null ? 3 : 0);
