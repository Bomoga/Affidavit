// Runs the containment suite (L2-01) with every probe executed as a witness in the witness jail
// (L2-03), and writes the table into docs/lanes/lane2/containment.md.
//
//   pnpm --filter @affidavit/judge containment
//   pnpm --filter @affidavit/judge containment --require-pass
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAndRecord } from '@affidavit/sandbox';
import { WitnessJailRunner } from './containment.js';
import { buildRunnerImage } from './harness.js';

const runnerImage = await buildRunnerImage();
const workRoot = await mkdtemp(join(tmpdir(), 'affidavit-witness-'));
try {
  const report = await runAndRecord(
    'witness',
    'pnpm --filter @affidavit/judge containment',
    (fx) =>
      new WitnessJailRunner({
        workRoot,
        runnerImage,
        sensitivePaths: [fx.credentialPath, fx.evidenceDir],
      }),
  );
  if (process.argv.includes('--require-pass') && !report.allPassed) process.exitCode = 1;
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
