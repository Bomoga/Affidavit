import { recordOnce, type StageEnv } from '@affidavit/db';
import type { CaseStage } from '@affidavit/contracts';

/**
 * Exit event, entry event, then the transition last: a retry after a kill repeats no event, and a
 * kill after the transition has nothing left to emit. Shared by the fake and the real Lane 1
 * stage work.
 */
export async function moveTo(
  env: StageEnv,
  to: CaseStage,
  options: { enterNext?: boolean } = {},
): Promise<void> {
  const { job } = env;
  await recordOnce(env, job.caseId, job.stage, 'stenographer', {
    type: 'stage-exited',
    payload: { to },
  });
  // `enterNext: false` when the next stage's work emits its own entry inside its visit (the real
  // trial orchestrator does), so the case does not get two.
  if (options.enterNext !== false) {
    await recordOnce(env, job.caseId, to, 'stenographer', {
      type: 'stage-entered',
      payload: { from: job.stage },
    });
  }
  await env.checkpoint('after-events');
  await env.store.transition(job.caseId, to);
}

/** Repairs a case that was opened but crashed before its first event was written. */
export async function repairIntakeEntry(env: StageEnv): Promise<void> {
  await recordOnce(env, env.job.caseId, 'intake', 'stenographer', {
    type: 'stage-entered',
    payload: {},
  });
}
