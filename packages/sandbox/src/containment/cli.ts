// Runs the containment suite (L2-01) and writes the result table into
// docs/lanes/lane2/containment.md between that runner's generated markers.
//
//   pnpm --filter @affidavit/sandbox containment                    gVisor runner (L2-02), report only
//   pnpm --filter @affidavit/sandbox containment --runner plain     plain Docker baseline
//   pnpm --filter @affidavit/sandbox containment --require-pass     exit 1 unless every probe passes
//
// The witness jail (L2-03) runs the same suite from packages/judge: `pnpm --filter
// @affidavit/judge containment`.
import { GvisorRunner } from '../gvisor/runner.js';
import { PlainDockerRunner } from './plain-docker.js';
import { runAndRecord } from './record.js';

const RUNNERS = ['gvisor', 'plain'] as const;
type RunnerKind = (typeof RUNNERS)[number];

function runnerKind(argv: readonly string[]): RunnerKind {
  const i = argv.indexOf('--runner');
  const value = i < 0 ? 'gvisor' : argv[i + 1];
  if (!RUNNERS.includes(value as RunnerKind)) {
    throw new Error(`--runner must be one of ${RUNNERS.join(', ')}`);
  }
  return value as RunnerKind;
}

const kind = runnerKind(process.argv);
const report = await runAndRecord(kind, 'pnpm --filter @affidavit/sandbox containment', (fx) =>
  kind === 'plain'
    ? new PlainDockerRunner()
    : new GvisorRunner({ sensitivePaths: [fx.credentialPath, fx.evidenceDir] }),
);
if (process.argv.includes('--require-pass') && !report.allPassed) process.exit(1);
