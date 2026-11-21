/**
 * FAKE stage work. Everything in this file is scripted and exists so the composition root can be
 * proven end to end before the real implementations land:
 *
 * - intake, map, arraign: stand-ins for Lane 1 L1-01, L1-05, L1-06 (not built yet). The fake
 *   arraign never dismisses, so it can never silently dismiss a high-score candidate.
 * - defense, prosecution, remedy, verify, jury: stand-ins for Lane 3's trial handlers.
 * - the Judge: `FakeJudge` from @affidavit/testing, scripted with the contracts sample result.
 *
 * Crash safety: events are emitted idempotently (`recordOnce`) BEFORE the case transition, and
 * the transition is the last write. A retry after a kill therefore re-emits nothing, and a kill
 * after the transition has nothing left to emit. (The fake flow never revisits a stage, so an
 * event is identified by type, stage and payload; real handlers that can revisit a stage need an
 * identity that includes the visit.)
 */
import { recordOnce, type StageCore, type StageEnv } from '@affidavit/db';
import {
  ExhibitResult,
  Verdict,
  Witness,
  samples,
  type CaseStage,
  type JudgePort,
} from '@affidavit/contracts';
import { FakeJudge } from '@affidavit/testing';

export function fakeJudge(): JudgePort {
  const witness = Witness.parse(samples.Witness);
  return new FakeJudge({
    witnessResults: { [witness.sha256]: ExhibitResult.parse(samples.ExhibitResult) },
  });
}

/** Exit event, entry event, then the transition last. */
async function moveTo(env: StageEnv, to: CaseStage): Promise<void> {
  const { job } = env;
  await recordOnce(env, job.caseId, job.stage, 'stenographer', {
    type: 'stage-exited',
    payload: { to },
  });
  await recordOnce(env, job.caseId, to, 'stenographer', {
    type: 'stage-entered',
    payload: { from: job.stage },
  });
  await env.checkpoint('after-events');
  await env.store.transition(job.caseId, to);
}

function passThrough(to: CaseStage): StageCore {
  return (env) => moveTo(env, to);
}

export const fakeIntakeCores: Partial<Record<CaseStage, StageCore>> = {
  intake: async (env) => {
    // Repairs a case that was opened but crashed before its first event was written.
    await recordOnce(env, env.job.caseId, 'intake', 'stenographer', {
      type: 'stage-entered',
      payload: {},
    });
    await moveTo(env, 'map');
  },
  map: passThrough('arraign'),
  arraign: passThrough('defense'),
};

async function finishWithVerdict(env: StageEnv): Promise<void> {
  const { job } = env;
  // Idempotent: a retry after a kill must not trip the append-only verdict.
  let verdict = await env.store.getVerdict(job.caseId);
  if (verdict === null) {
    verdict = Verdict.parse({
      ...(samples.Verdict as object),
      caseId: job.caseId,
      summary: '[fake] scripted verdict from the worker composition root',
    });
    await env.store.appendVerdict(verdict);
  }
  await env.checkpoint('after-verdict');
  await recordOnce(env, job.caseId, job.stage, 'stenographer', {
    type: 'verdict-written',
    payload: { verdict },
  });
  await moveTo(env, 'verdict');
}

export function fakeTrialCores(options: {
  judge: JudgePort;
  juryEnabled: boolean;
}): Partial<Record<CaseStage, StageCore>> {
  return {
    defense: async (env) => {
      const caseFile = await env.caseFiles.get(env.job.caseId);
      if (!caseFile) throw new Error(`no case file for ${env.job.caseId}`);
      const witness = Witness.parse({ ...(samples.Witness as object), caseId: caseFile.id });
      const result = await options.judge.runWitness(caseFile, witness, ['vulnerable', 'safe']);
      await env.checkpoint('after-judge');
      await recordOnce(env, caseFile.id, 'defense', 'defense', {
        type: 'exhibit-submitted',
        payload: { exhibitId: result.exhibitId, kind: 'witness' },
      });
      await recordOnce(env, caseFile.id, 'defense', 'judge', {
        type: 'exhibit-result',
        payload: { result },
      });
      await moveTo(env, 'prosecution');
    },
    prosecution: passThrough('remedy'),
    remedy: passThrough('verify'),
    verify: (env) => (options.juryEnabled ? moveTo(env, 'jury') : finishWithVerdict(env)),
    jury: finishWithVerdict,
  };
}
