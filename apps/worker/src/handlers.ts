import { existsSync } from 'node:fs';
import type { CaseStage, JudgePort, ModelPort } from '@affidavit/contracts';
import {
  stageHandler,
  type AppPool,
  type StageCore,
  type StageHandler,
  type StageHooks,
} from '@affidavit/db';
import type { RealJudge, RealJudgeHostProbe } from '@affidavit/judge';
import { ModelConfigError, resolveModelTable, type ModelTable } from '@affidavit/trial';
import {
  ConfigError,
  startupWarnings,
  type Env,
  type JudgeSettings,
  type WorkerConfig,
} from './config.js';
import { fakeIntakeCores, fakeJudge, fakeTrialCores } from './fakes/stages.js';
import { buildDiscover, buildJudge, buildModel } from './real/components.js';
import { realIntakeCores, type Discover } from './real/intake.js';
import {
  PrerequisiteError,
  checkPrerequisites,
  realHostProbe,
  type HostProbe,
} from './real/prereqs.js';
import { realTrialCores } from './real/trial.js';

export type Cores = Partial<Record<CaseStage, StageCore>>;

export interface PreparedCores {
  cores: Cores;
  /** Releases what the real components hold (the Judge's booted targets and lease). */
  close(): Promise<void>;
}

/**
 * Seams for the real wiring. Anything injected here replaces the component built from config,
 * and the host prerequisites of a replaced component are not checked. Tests inject fakes through
 * these same seams; production passes nothing.
 */
export interface Components {
  env?: Env;
  probe?: HostProbe;
  /** Host facts for Lane 2's real Judge check (createRealJudge). */
  judgeProbe?: RealJudgeHostProbe;
  /** Replaces the discovery pipeline (and its tool runner) for AFFIDAVIT_INTAKE_IMPL=real. */
  discover?: Discover;
  /** Replaces createModelPortFromEnv for AFFIDAVIT_TRIAL_IMPL=real. */
  model?: ModelPort;
  modelTable?: ModelTable;
  /** Replaces the jail Judge for AFFIDAVIT_JUDGE_IMPL=real (its host checks are then skipped). */
  judge?: JudgePort;
  /**
   * Replaces `createRealJudge` itself, keeping the host checks: for tests of the build order and
   * of closing the Judge when a later step fails.
   */
  realJudgeFactory?: (s: JudgeSettings, probe?: RealJudgeHostProbe) => Promise<RealJudge>;
  log?: (message: string) => void;
}

const API_KEY_VAR = 'ANTHROPIC_API_KEY';

/**
 * A problem from building a component from the environment. Only the validators' own messages
 * (they name variables, never values); anything else is named by component and error class.
 */
function problemOf(what: string, err: unknown): string {
  if (err instanceof ModelConfigError || err instanceof RangeError || err instanceof ConfigError) {
    return `${what}: ${err.message}`;
  }
  return `${what} could not be built (${err instanceof Error ? err.name : 'unknown error'})`;
}

/**
 * The stage work for every non-terminal stage, chosen by config. Wiring only. In order:
 * (1) every host prerequisite and every environment-derived component (discovery's arraignment
 * config and tool runner, the model port, the model table) is checked or built, and ALL problems
 * are thrown together as one PrerequisiteError; (2) only then the real Judge is built, last,
 * because it starts things (its lease, its orphan sweep); (3) the cores are assembled, and if
 * that throws the Judge is closed before the error goes up. Nothing is left running on a refusal.
 */
export async function prepareCores(
  config: WorkerConfig,
  components: Components = {},
): Promise<PreparedCores> {
  const env = components.env ?? process.env;
  const log = components.log ?? ((m: string) => console.error(`[worker] ${m}`));
  const problems: string[] = [];
  const attempt = <T>(what: string, build: () => T): T | undefined => {
    try {
      return build();
    } catch (err) {
      problems.push(problemOf(what, err));
      return undefined;
    }
  };

  // (1) Everything that can fail on its own, collected into one list.
  try {
    await checkPrerequisites(
      {
        ...config,
        intakeSettings: components.discover ? null : config.intakeSettings,
        judgeSettings: components.judge ? null : config.judgeSettings,
      },
      components.probe ?? realHostProbe,
      components.judgeProbe,
    );
  } catch (err) {
    if (!(err instanceof PrerequisiteError)) throw err;
    problems.push(...err.problems);
  }

  let discover: Discover | undefined;
  if (config.intake === 'real') {
    const s = requireSettings(config.intakeSettings, 'intake');
    discover = components.discover ?? attempt('discovery', () => buildDiscover(s, env));
  }

  let trialParts:
    { model: ModelPort; modelTable: ModelTable; killSwitch: () => boolean } | null | undefined =
    null;
  if (config.trial === 'real') {
    const s = requireSettings(config.trialSettings, 'trial');
    const file = s.killSwitchFile;
    const killSwitch = () => s.killSwitch || (file !== null && existsSync(file));
    const model = components.model ?? attempt('the model port', () => buildModel(env, killSwitch));
    const modelTable =
      components.modelTable ?? attempt('the model table', () => resolveModelTable(env));
    trialParts =
      model === undefined || modelTable === undefined
        ? undefined
        : { model, modelTable, killSwitch };
  }
  if (problems.length > 0) throw new PrerequisiteError(problems);

  for (const w of startupWarnings(config)) log(`warning: ${w}`);
  if (trialParts && components.model === undefined && (env[API_KEY_VAR] ?? '') === '') {
    // Named, never valued. The port reads the key on every call, so it can be supplied later;
    // until then every trial stage halts without a charge.
    log(`${API_KEY_VAR} is not set: trial stages will halt (model-unconfigured) until it is`);
  }

  // (2) The real Judge, last: it takes a lease and may sweep, so nothing may fail after it
  // without releasing it.
  let judge: JudgePort = fakeJudge();
  let realJudge: RealJudge | null = null;
  if (config.judge === 'real') {
    if (components.judge) judge = components.judge;
    else {
      const build = components.realJudgeFactory ?? buildJudge;
      realJudge = await build(
        requireSettings(config.judgeSettings, 'judge'),
        components.judgeProbe,
      );
      judge = realJudge.judge;
    }
  }
  const held = realJudge;

  // (3) Assembly. A throw here closes the Judge (its lease and timers) before it goes up.
  try {
    for (const note of held?.notes ?? []) log(`real Judge: ${note}`);
    // A case that reaches a terminal stage gives its booted targets back.
    const caseEnded = held ? (caseId: string) => held.release(caseId) : () => Promise.resolve();

    let intake: Cores = fakeIntakeCores;
    if (config.intake === 'real' && discover) {
      const s = requireSettings(config.intakeSettings, 'intake');
      intake = realIntakeCores({
        discover,
        sources: s.sources,
        trialEntersDefense: config.trial === 'real',
      });
    }

    let trial: Cores;
    if (trialParts) {
      trial = realTrialCores({
        model: trialParts.model,
        judge,
        modelTable: trialParts.modelTable,
        settings: requireSettings(config.trialSettings, 'trial'),
        maxStageAttempts: config.maxStageAttempts,
        killSwitch: trialParts.killSwitch,
        caseEnded,
      });
    } else {
      trial = fakeTrialCores({ judge, juryEnabled: config.juryEnabled });
    }
    return {
      cores: { ...intake, ...trial },
      close: () => (held ? held.close() : Promise.resolve()),
    };
  } catch (err) {
    if (held) {
      // The original error is the one that matters; a failed close is only logged.
      await held.close().catch((e: unknown) => {
        log(`real Judge close failed (${e instanceof Error ? e.name : 'unknown error'})`);
      });
    }
    throw err;
  }
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
