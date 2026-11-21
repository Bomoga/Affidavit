/**
 * Test helper, not part of the package API: the real worker in its own process, so a test can
 * SIGKILL it. Configured by the normal AFFIDAVIT_* variables, plus:
 *
 * - CHILD_HANG_BEFORE=<stage>:<attempt>  never return from that attempt before its work
 * - CHILD_HANG_AFTER=<stage>:<attempt>   never return after the work and case transition, before
 *                                        the next stage job is enqueued
 * - CHILD_HANG_AT=<stage>:<attempt>:<checkpoint>  never return at a named point inside the work
 * - CHILD_START_CASE=<case file JSON>    do not run a worker: open that case, then hang before the
 *                                        first job is enqueued (a crash inside startCase)
 *
 * Prints one line per event on stdout: READY, STARTED <stage> <attempt>, HUNG <what>.
 */
import { openPool, startCase } from '@affidavit/db';
import { CaseFile } from '@affidavit/contracts';
import { loadConfig } from './config.js';
import { startWorker } from './worker.js';

const never = () => new Promise<void>(() => undefined);

async function main(): Promise<void> {
  const config = loadConfig();
  const caseJson = process.env.CHILD_START_CASE;
  if (caseJson) {
    const pool = await openPool(config.appDatabaseUrl, 'affidavit_app');
    await startCase(
      pool,
      CaseFile.parse(JSON.parse(caseJson)),
      { maxInputTokens: 1_000_000, maxOutputTokens: 200_000, maxUsd: 5 },
      {
        afterOpen: async () => {
          console.log('HUNG startCase');
          await never();
        },
      },
    );
    return;
  }
  const before = process.env.CHILD_HANG_BEFORE;
  const after = process.env.CHILD_HANG_AFTER;
  const at = process.env.CHILD_HANG_AT;
  await startWorker(config, {
    log: () => undefined,
    hooks: {
      beforeStageWork: async (job) => {
        console.log(`STARTED ${job.stage} ${job.attempt}`);
        if (before === `${job.stage}:${job.attempt}`) {
          console.log(`HUNG ${job.stage} ${job.attempt}`);
          await never();
        }
      },
      afterStageWork: async (job) => {
        if (after === `${job.stage}:${job.attempt}`) {
          console.log(`HUNG ${job.stage} ${job.attempt}`);
          await never();
        }
      },
      checkpoint: async (job, name) => {
        if (at === `${job.stage}:${job.attempt}:${name}`) {
          console.log(`HUNG ${job.stage} ${job.attempt} ${name}`);
          await never();
        }
      },
    },
  });
  console.log('READY');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
