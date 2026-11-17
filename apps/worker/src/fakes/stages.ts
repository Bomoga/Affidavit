/**
 * FAKE stage work. Everything in this file is scripted and exists so the composition root can be
 * proven end to end before the real implementations land:
 *
 * - intake, map, arraign: stand-ins for Lane 1 L1-01, L1-05, L1-06 (not built yet). The fake
 *   arraign never dismisses, so it can never silently dismiss a high-score candidate.
 * - defense, prosecution, remedy, verify, jury: stand-ins for Lane 3's trial handlers.
 * - the Judge: `FakeJudge` from @affidavit/testing, scripted with the contracts sample result.
 *
 * Events are emitted by the stage that EXITS (exited, then entered for the next stage) and only
 * after the case transition, so an attempt killed before its transition leaves no event behind
 * and a retry cannot duplicate one.
 */
import {
  ExhibitResult,
  Verdict,
  Witness,
  samples,
  type CaseStage,
  type JudgePort,
} from '@affidavit/contracts';
import { FakeJudge } from '@affidavit/testing';
import { record, type StageCore, type StageEnv } from '../stage.js';

export function fakeJudge(): JudgePort {
  const witness = Witness.parse(samples.Witness);
  return new FakeJudge({
    witnessResults: { [witness.sha256]: ExhibitResult.parse(samples.ExhibitResult) },
  });
}

async function moveTo(env: StageEnv, to: CaseStage): Promise<void> {
  const { job } = env;
  await env.store.transition(job.caseId, to);
  await record(env, job.caseId, job.stage, 'stenographer', {
    type: 'stage-exited',
    payload: { to },
  });
  await record(env, job.caseId, to, 'stenographer', {
    type: 'stage-entered',
    payload: { from: job.stage },
  });
}

function passThrough(to: CaseStage): StageCore {
  return (env) => moveTo(env, to);
}

export const fakeIntakeCores: Partial<Record<CaseStage, StageCore>> = {
  intake: passThrough('map'),
  map: passThrough('arraign'),
  arraign: passThrough('defense'),
};

async function finishWithVerdict(env: StageEnv): Promise<void> {
  const { job } = env;
  // Idempotent: a retry after a kill must not trip the append-only verdict.
  if ((await env.store.getVerdict(job.caseId)) === null) {
    const verdict = Verdict.parse({
      ...(samples.Verdict as object),
      caseId: job.caseId,
      summary: '[fake] scripted verdict from the worker composition root',
    });
    await env.store.appendVerdict(verdict);
    await record(env, job.caseId, job.stage, 'stenographer', {
      type: 'verdict-written',
      payload: { verdict },
    });
  }
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
      if (env.signal.aborted) throw new Error('lease lost');
      await record(env, caseFile.id, 'defense', 'defense', {
        type: 'exhibit-submitted',
        payload: { exhibitId: result.exhibitId, kind: 'witness' },
      });
      await record(env, caseFile.id, 'defense', 'judge', {
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
