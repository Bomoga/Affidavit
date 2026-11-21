import { existsSync } from 'node:fs';
import type { CaseStage, JudgePort, ModelPort } from '@affidavit/contracts';
import {
  stageHandler,
  type AppPool,
  type StageCore,
  type StageHandler,
  type StageHooks,
} from '@affidavit/db';
import { resolveModelTable, type ModelTable } from '@affidavit/trial';
import type { Env, WorkerConfig } from './config.js';
import { fakeIntakeCores, fakeJudge, fakeTrialCores } from './fakes/stages.js';
import { buildDiscover, buildJudge, buildModel } from './real/components.js';
import { realIntakeCores, type Discover } from './real/intake.js';
import { checkPrerequisites, realHostProbe, type HostProbe } from './real/prereqs.js';
import { realTrialCores } from './real/trial.js';

export type Cores = Partial<Record<CaseStage, StageCore>>;

/**
 * Seams for the real wiring. Anything injected here replaces the component built from config,
 * and the host prerequisites of a replaced component are not checked. Tests inject fakes through
 * these same seams; production passes nothing.
 */
export interface Components {
  env?: Env;
  probe?: HostProbe;
  /** Replaces the discovery pipeline (and its tool runner) for AFFIDAVIT_INTAKE_IMPL=real. */
  discover?: Discover;
  /** Replaces createModelPortFromEnv for AFFIDAVIT_TRIAL_IMPL=real. */
  model?: ModelPort;
  modelTable?: ModelTable;
  /** Replaces the jail Judge for AFFIDAVIT_JUDGE_IMPL=real. */
  judge?: JudgePort;
  log?: (message: string) => void;
}

const API_KEY_VAR = 'ANTHROPIC_API_KEY';

/**
 * The stage work for every non-terminal stage, chosen by config. Wiring only. Every real setting
 * is built, and every host prerequisite checked, before this returns: a missing piece throws
 * (ConfigError at load, PrerequisiteError here) and nothing is started.
 */
export async function prepareCores(
  config: WorkerConfig,
  components: Components = {},
): Promise<Cores> {
  const env = components.env ?? process.env;
  const log = components.log ?? ((m: string) => console.error(`[worker] ${m}`));

  await checkPrerequisites(
    {
      ...config,
      intakeSettings: components.discover ? null : config.intakeSettings,
      judgeSettings: components.judge ? null : config.judgeSettings,
    },
    components.probe ?? realHostProbe,
  );

  let judge: JudgePort;
  if (config.judge === 'real') {
    judge = components.judge ?? buildJudge(requireSettings(config.judgeSettings, 'judge')).judge;
  } else {
    judge = fakeJudge();
  }

  let intake: Cores = fakeIntakeCores;
  if (config.intake === 'real') {
    const s = requireSettings(config.intakeSettings, 'intake');
    intake = realIntakeCores({
      discover: components.discover ?? buildDiscover(s, env),
      sources: s.sources,
      trialEntersDefense: config.trial === 'real',
    });
  }

  let trial: Cores;
  if (config.trial === 'real') {
    const s = requireSettings(config.trialSettings, 'trial');
    const file = s.killSwitchFile;
    const killSwitch = () => s.killSwitch || (file !== null && existsSync(file));
    const model = components.model ?? buildModel(env, killSwitch);
    if (components.model === undefined && (env[API_KEY_VAR] ?? '') === '') {
      // Named, never valued. The port reads the key on every call, so it can be supplied later;
      // until then every trial stage halts without a charge.
      log(`${API_KEY_VAR} is not set: trial stages will halt (model-unconfigured) until it is`);
    }
    trial = realTrialCores({
      model,
      judge,
      modelTable: components.modelTable ?? resolveModelTable(env),
      settings: s,
      maxStageAttempts: config.maxStageAttempts,
      killSwitch,
    });
  } else {
    trial = fakeTrialCores({ judge, juryEnabled: config.juryEnabled });
  }
  return { ...intake, ...trial };
}

function requireSettings<T>(settings: T | null, what: string): T {
  // loadConfig fills the settings of every real implementation; a hand-built config may not.
  if (settings === null) throw new Error(`the ${what} settings are missing for a real ${what}`);
  return settings;
}

/** Queue handlers: each stage's work wrapped by the db package's `stageHandler`. */
export function buildHandlers(options: {
  appPool: AppPool;
  config: WorkerConfig;
  cores: Cores;
  hooks?: StageHooks;
}): Partial<Record<CaseStage, StageHandler>> {
  const out: Partial<Record<CaseStage, StageHandler>> = {};
  for (const [stage, core] of Object.entries(options.cores)) {
    out[stage as CaseStage] = stageHandler(core, {
      appPool: options.appPool,
      juryEnabled: options.config.juryEnabled,
      hooks: options.hooks,
    });
  }
  return out;
}
