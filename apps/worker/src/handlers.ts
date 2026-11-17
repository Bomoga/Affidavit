import type { CaseStage } from '@affidavit/contracts';
import {
  stageHandler,
  type AppPool,
  type StageCore,
  type StageHandler,
  type StageHooks,
} from '@affidavit/db';
import type { WorkerConfig } from './config.js';
import { fakeIntakeCores, fakeJudge, fakeTrialCores } from './fakes/stages.js';

/** Raised at startup for a `real` setting whose implementation has not landed. */
export class NotWiredError extends Error {
  constructor(what: string, pending: string) {
    super(`${what} is configured as "real" but is not wired yet (${pending})`);
    this.name = 'NotWiredError';
  }
}

/** The stage work for every non-terminal stage, chosen by config. Wiring only. */
export function selectCores(config: WorkerConfig): Partial<Record<CaseStage, StageCore>> {
  if (config.intake === 'real') {
    throw new NotWiredError('intake, map and arraign', 'Lane 1 L1-01, L1-05, L1-06');
  }
  if (config.trial === 'real') throw new NotWiredError('trial handlers', 'Lane 3');
  if (config.judge === 'real') throw new NotWiredError('the Judge', 'Lane 2');
  return {
    ...fakeIntakeCores,
    ...fakeTrialCores({ judge: fakeJudge(), juryEnabled: config.juryEnabled }),
  };
}

/** Queue handlers: each stage's work wrapped by the db package's `stageHandler`. */
export function buildHandlers(options: {
  appPool: AppPool;
  config: WorkerConfig;
  hooks?: StageHooks;
}): Partial<Record<CaseStage, StageHandler>> {
  const out: Partial<Record<CaseStage, StageHandler>> = {};
  for (const [stage, core] of Object.entries(selectCores(options.config))) {
    out[stage as CaseStage] = stageHandler(core, {
      appPool: options.appPool,
      juryEnabled: options.config.juryEnabled,
      hooks: options.hooks,
    });
  }
  return out;
}
