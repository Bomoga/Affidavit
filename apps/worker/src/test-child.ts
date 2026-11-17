/**
 * Test helper, not part of the package API: the real worker in its own process, so a test can
 * SIGKILL it. Configured by the normal AFFIDAVIT_* variables, plus:
 *
 * - CHILD_HANG_BEFORE=<stage>:<attempt>  never return from that attempt before its work
 * - CHILD_HANG_AFTER=<stage>:<attempt>   never return after the work and case transition, before
 *                                        the next stage job is enqueued
 *
 * Prints one line per event on stdout: READY, STARTED <stage> <attempt>, HUNG <stage> <attempt>.
 */
import { loadConfig } from './config.js';
import { startWorker } from './worker.js';

const never = () => new Promise<void>(() => undefined);

async function main(): Promise<void> {
  const before = process.env.CHILD_HANG_BEFORE;
  const after = process.env.CHILD_HANG_AFTER;
  await startWorker(loadConfig(), {
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
    },
  });
  console.log('READY');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
