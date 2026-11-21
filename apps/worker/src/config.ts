/**
 * Worker configuration, read from process environment only. Nothing here comes from a file, and
 * no error or description ever contains a connection string, a source URL or a path's contents
 * (they can carry passwords). Errors name variables, never values.
 */
import type { Budget } from '@affidavit/contracts';

export type Impl = 'fake' | 'real';
export type ToolRunnerKind = 'docker' | 'gvisor';

/** `AFFIDAVIT_INTAKE_IMPL=real`: the real discovery pipeline behind intake, map and arraign. */
export interface IntakeSettings {
  /** Existing directory for per-run discovery workspaces. */
  workRoot: string;
  /** Repository id (`CaseFile.target.repo`) to clone URL or local path. Values are secret-ish. */
  sources: Readonly<Record<string, string>>;
  /** Local paths as sources (CLI and tests only). Default off: https clone URLs only. */
  allowLocalSource: boolean;
  /**
   * How scanners run, both through ToolRunnerPort: Lane 2's gVisor runner (the default) or plain
   * Docker. Plain Docker only when AFFIDAVIT_TOOLRUNNER=docker is set, and it logs a warning.
   */
  toolRunner: ToolRunnerKind;
  /** False when AFFIDAVIT_TOOLRUNNER was unset and gVisor is the default. */
  toolRunnerExplicit: boolean;
  /** Wall-clock cap per scanner run, gVisor runner only. */
  toolTimeoutMs: number;
}

/** `AFFIDAVIT_TRIAL_IMPL=real`: the trial orchestrator and handlers, on the real model port. */
export interface TrialSettings {
  /** `AFFIDAVIT_KILL_SWITCH=on` stops every stage and model call. */
  killSwitch: boolean;
  /** Also tripped while this file exists, so an operator can stop a running worker. */
  killSwitchFile: string | null;
  /** Charged in full before every agent turn. */
  turnBudget: Budget;
  maxAgentTurns: number;
  defenseIterations: number;
  prosecutionCounterexamples: number;
  remedyIterations: number;
}

/** `AFFIDAVIT_JUDGE_IMPL=real`: Lane 2's Judge on the gVisor witness jail. */
export interface JudgeSettings {
  /** Host directory for per-attempt witness directories. Never inside the evidence store. */
  workRoot: string;
  /** Witness runner image ID (`pnpm --filter @affidavit/judge runner-image`). */
  runnerImage: string;
  /** Evidence store directory (FsEvidenceStore). The witness jail never mounts it. */
  evidenceDir: string;
  /** The signer's unix socket. The worker holds no signing key. */
  signerSocket: string;
  /** Patch-apply image ID (`pnpm --filter @affidavit/judge patch-apply-image`). */
  applyImage: string;
  /** NodeGoat dependency bundle tar (PR #55), verified by the Judge against pins.json. */
  nodegoatBundle: string | null;
  /** The bundle store the tar must resolve inside; required with `nodegoatBundle`. */
  dependencyBundleRoot: string | null;
  /** Verified NodeGoat checkouts (`fetch-pinned.mjs nodegoat` and `nodegoat safe`). */
  nodegoatDir: string | null;
  nodegoatSafeDir: string | null;
  /** Startup sweep of case networks left by dead workers: off (default), on, or force. */
  sweepOrphans: boolean | 'force';
  /** Worker lease directory shared by every worker on the host (default `<workRoot>/leases`). */
  leaseDir: string | null;
}

export interface WorkerConfig {
  /** `affidavit_app` role URL. Secret. */
  appDatabaseUrl: string;
  /** `affidavit_worker` role URL. Secret. */
  workerDatabaseUrl: string;
  /** Lane 1 intake, map and arraign handlers. */
  intake: Impl;
  /** Lane 3 trial handlers (defense to jury). */
  trial: Impl;
  /** Lane 2 Judge as the JudgePort. */
  judge: Impl;
  leaseSeconds: number;
  staleLockSeconds: number;
  reconcileIntervalMs: number;
  pollIntervalMs: number;
  concurrency: number;
  /** Total attempts of one stage, the first included, before a human has to look. */
  maxStageAttempts: number;
  juryEnabled: boolean;
  /** Set when intake is real. */
  intakeSettings: IntakeSettings | null;
  /** Set when trial is real. */
  trialSettings: TrialSettings | null;
  /** Set when the Judge is real. */
  judgeSettings: JudgeSettings | null;
  /** Budget a case is opened with (`open-case`). */
  caseBudget: Budget;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `invalid worker configuration: ${problems.join('; ')} (see docs/lanes/lane1/real-wiring.md)`,
    );
    this.name = 'ConfigError';
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

function intVar(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) {
    problems.push(`${name} must be an integer`);
    return fallback;
  }
  const n = Number(raw);
  if (n < min || n > max) {
    problems.push(`${name} must be between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

function usdVar(env: Env, name: string, fallback: number, max: number, problems: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,6}(\.[0-9]{1,6})?$/.test(raw) || Number(raw) <= 0 || Number(raw) > max) {
    problems.push(`${name} must be a number of dollars above 0 and at most ${max}`);
    return fallback;
  }
  return Number(raw);
}

function implVar(env: Env, name: string, problems: string[]): Impl {
  const raw = env[name];
  if (raw === undefined || raw === '') return 'fake';
  if (raw === 'fake' || raw === 'real') return raw;
  problems.push(`${name} must be "fake" or "real"`);
  return 'fake';
}

function boolVar(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} must be "true" or "false"`);
  return fallback;
}

function urlVar(env: Env, name: string, problems: string[]): string {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    problems.push(`${name} is required`);
    return '';
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
      problems.push(`${name} must be a postgres:// URL`);
    }
  } catch {
    // Never echo the value: it is a connection string.
    problems.push(`${name} is not a valid URL`);
  }
  return raw;
}

/** A required absolute path. The path itself is checked on the host at startup, not here. */
function pathVar(env: Env, name: string, why: string, problems: string[]): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    problems.push(`${name} is required (${why})`);
    return '';
  }
  if (!/^(\/|[A-Za-z]:[\\/])/.test(raw)) problems.push(`${name} must be an absolute path`);
  return raw;
}

function optionalPathVar(env: Env, name: string, problems: string[]): string | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (!/^(\/|[A-Za-z]:[\\/])/.test(raw)) problems.push(`${name} must be an absolute path`);
  return raw;
}

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function sourcesVar(env: Env, problems: string[]): Record<string, string> {
  const name = 'AFFIDAVIT_REPO_SOURCES';
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    problems.push(
      `${name} is required (a JSON object from repository id to clone URL or local path)`,
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the value: a URL may carry a credential.
    problems.push(`${name} is not valid JSON`);
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push(`${name} must be a JSON object`);
    return {};
  }
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!REPO_ID.test(k) || typeof v !== 'string' || v.trim() === '') {
      problems.push(`${name} must map repository ids to non-empty strings`);
      return {};
    }
    out[k] = v;
  }
  if (Object.keys(out).length === 0) problems.push(`${name} names no repository`);
  return out;
}

function intakeSettings(env: Env, problems: string[]): IntakeSettings {
  // gVisor unless plain Docker is asked for by name: repository content is untrusted.
  const runner = env['AFFIDAVIT_TOOLRUNNER'];
  const toolRunnerExplicit = runner !== undefined && runner !== '';
  let toolRunner: ToolRunnerKind = 'gvisor';
  if (runner === 'docker') toolRunner = 'docker';
  else if (toolRunnerExplicit && runner !== 'gvisor') {
    problems.push('AFFIDAVIT_TOOLRUNNER must be "docker" or "gvisor"');
  }
  return {
    workRoot: pathVar(env, 'AFFIDAVIT_INTAKE_WORK_ROOT', 'discovery workspaces', problems),
    sources: sourcesVar(env, problems),
    allowLocalSource: boolVar(env, 'AFFIDAVIT_INTAKE_ALLOW_LOCAL_SOURCE', false, problems),
    toolRunner,
    toolRunnerExplicit,
    toolTimeoutMs: intVar(env, 'AFFIDAVIT_TOOL_TIMEOUT_MS', 600_000, 10_000, 3_600_000, problems),
  };
}

function trialSettings(env: Env, problems: string[]): TrialSettings {
  const kill = env['AFFIDAVIT_KILL_SWITCH'];
  if (kill !== undefined && kill !== '' && kill !== 'on' && kill !== 'off') {
    problems.push('AFFIDAVIT_KILL_SWITCH must be "on" or "off"');
  }
  return {
    killSwitch: kill === 'on',
    killSwitchFile: optionalPathVar(env, 'AFFIDAVIT_KILL_SWITCH_FILE', problems),
    // Conservative starting caps, not measured ones; raise them deliberately.
    turnBudget: {
      maxInputTokens: intVar(
        env,
        'AFFIDAVIT_TURN_MAX_INPUT_TOKENS',
        100_000,
        1,
        2_000_000,
        problems,
      ),
      maxOutputTokens: intVar(env, 'AFFIDAVIT_TURN_MAX_OUTPUT_TOKENS', 8_000, 1, 200_000, problems),
      maxUsd: usdVar(env, 'AFFIDAVIT_TURN_MAX_USD', 1, 100, problems),
    },
    maxAgentTurns: intVar(env, 'AFFIDAVIT_AGENT_MAX_TURNS', 6, 1, 50, problems),
    defenseIterations: intVar(env, 'AFFIDAVIT_DEFENSE_ITERATIONS', 2, 1, 10, problems),
    prosecutionCounterexamples: intVar(
      env,
      'AFFIDAVIT_PROSECUTION_COUNTEREXAMPLES',
      2,
      1,
      10,
      problems,
    ),
    remedyIterations: intVar(env, 'AFFIDAVIT_REMEDY_ITERATIONS', 2, 1, 10, problems),
  };
}

function judgeSettings(env: Env, problems: string[]): JudgeSettings {
  const runnerImage = env['AFFIDAVIT_WITNESS_RUNNER_IMAGE'];
  if (runnerImage === undefined || runnerImage === '') {
    problems.push(
      'AFFIDAVIT_WITNESS_RUNNER_IMAGE is required (the image ID printed by `pnpm --filter @affidavit/judge runner-image`)',
    );
  } else if (!/^sha256:[0-9a-f]{64}$/.test(runnerImage)) {
    problems.push('AFFIDAVIT_WITNESS_RUNNER_IMAGE must be a local image ID (sha256:<64 hex>)');
  }
  const nodegoatBundle = optionalPathVar(env, 'AFFIDAVIT_NODEGOAT_BUNDLE', problems);
  const dependencyBundleRoot = optionalPathVar(env, 'AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT', problems);
  if (nodegoatBundle !== null && dependencyBundleRoot === null) {
    problems.push(
      'AFFIDAVIT_NODEGOAT_BUNDLE needs AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT (the bundle store it must resolve inside)',
    );
  }
  return {
    workRoot: pathVar(env, 'AFFIDAVIT_JUDGE_WORK_ROOT', 'witness attempt directories', problems),
    runnerImage: runnerImage ?? '',
    evidenceDir: pathVar(env, 'AFFIDAVIT_EVIDENCE_DIR', 'the evidence store directory', problems),
    signerSocket: pathVar(env, 'AFFIDAVIT_SIGNER_SOCKET', 'the signer service socket', problems),
    applyImage: imageIdVar(
      env,
      'AFFIDAVIT_PATCH_APPLY_IMAGE',
      '`pnpm --filter @affidavit/judge patch-apply-image`',
      problems,
    ),
    nodegoatBundle,
    dependencyBundleRoot,
    nodegoatDir: optionalPathVar(env, 'AFFIDAVIT_NODEGOAT_DIR', problems),
    nodegoatSafeDir: optionalPathVar(env, 'AFFIDAVIT_NODEGOAT_SAFE_DIR', problems),
    sweepOrphans: sweepVar(env, problems),
    leaseDir: optionalPathVar(env, 'AFFIDAVIT_JUDGE_LEASE_DIR', problems),
  };
}

function imageIdVar(env: Env, name: string, how: string, problems: string[]): string {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    problems.push(`${name} is required (the image ID printed by ${how})`);
    return '';
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(raw)) {
    problems.push(`${name} must be a local image ID (sha256:<64 hex>)`);
  }
  return raw;
}

function sweepVar(env: Env, problems: string[]): boolean | 'force' {
  const raw = env['AFFIDAVIT_SWEEP_ORPHANS'];
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw === '1') return true;
  if (raw === 'force') return 'force';
  problems.push('AFFIDAVIT_SWEEP_ORPHANS must be unset, "0", "1" or "force"');
  return false;
}

/** Validates the environment. Throws ConfigError listing every problem, none of them a secret. */
export function loadConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];
  const leaseSeconds = intVar(env, 'AFFIDAVIT_LEASE_SECONDS', 300, 1, 3600, problems);
  const intake = implVar(env, 'AFFIDAVIT_INTAKE_IMPL', problems);
  const trial = implVar(env, 'AFFIDAVIT_TRIAL_IMPL', problems);
  const judge = implVar(env, 'AFFIDAVIT_JUDGE_IMPL', problems);
  const juryEnabled = boolVar(env, 'AFFIDAVIT_JURY_ENABLED', true, problems);
  if (trial === 'real' && juryEnabled) {
    // @affidavit/trial has no jury handler yet (L3-11); its verify handler writes the verdict and
    // needs the store's jury setting off, or verify to verdict is refused.
    problems.push(
      'AFFIDAVIT_TRIAL_IMPL=real needs AFFIDAVIT_JURY_ENABLED=false (the trial package has no jury handler yet)',
    );
  }
  const config: WorkerConfig = {
    appDatabaseUrl: urlVar(env, 'AFFIDAVIT_APP_DATABASE_URL', problems),
    workerDatabaseUrl: urlVar(env, 'AFFIDAVIT_WORKER_DATABASE_URL', problems),
    intake,
    trial,
    judge,
    leaseSeconds,
    // Default: the lease plus a margin, so a live attempt is never called dead.
    staleLockSeconds: intVar(
      env,
      'AFFIDAVIT_STALE_LOCK_SECONDS',
      leaseSeconds + 60,
      1,
      86_400,
      problems,
    ),
    reconcileIntervalMs: intVar(
      env,
      'AFFIDAVIT_RECONCILE_INTERVAL_MS',
      30_000,
      250,
      3_600_000,
      problems,
    ),
    pollIntervalMs: intVar(env, 'AFFIDAVIT_POLL_INTERVAL_MS', 1000, 50, 60_000, problems),
    concurrency: intVar(env, 'AFFIDAVIT_CONCURRENCY', 4, 1, 64, problems),
    maxStageAttempts: intVar(env, 'AFFIDAVIT_MAX_STAGE_ATTEMPTS', 3, 1, 10, problems),
    juryEnabled,
    intakeSettings: intake === 'real' ? intakeSettings(env, problems) : null,
    trialSettings: trial === 'real' ? trialSettings(env, problems) : null,
    judgeSettings: judge === 'real' ? judgeSettings(env, problems) : null,
    caseBudget: {
      maxInputTokens: intVar(
        env,
        'AFFIDAVIT_CASE_MAX_INPUT_TOKENS',
        1_000_000,
        1,
        100_000_000,
        problems,
      ),
      maxOutputTokens: intVar(
        env,
        'AFFIDAVIT_CASE_MAX_OUTPUT_TOKENS',
        100_000,
        1,
        10_000_000,
        problems,
      ),
      maxUsd: usdVar(env, 'AFFIDAVIT_CASE_MAX_USD', 10, 10_000, problems),
    },
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * Settings that start but weaken a guarantee, to log once at startup. Names only, never values.
 */
export function startupWarnings(config: WorkerConfig): string[] {
  const out: string[] = [];
  if (config.intakeSettings?.toolRunner === 'docker') {
    out.push(
      'AFFIDAVIT_TOOLRUNNER=docker: scanners run on untrusted repository content under plain Docker (runc), without gVisor isolation; unset it or use gvisor on a Linux sandbox host (docs/lanes/lane1/real-wiring.md)',
    );
  }
  return out;
}

/** The non-secret part of the configuration, safe to log. Source URLs are not listed. */
export function describeConfig(config: WorkerConfig): Record<string, unknown> {
  return {
    intake: config.intake,
    trial: config.trial,
    judge: config.judge,
    leaseSeconds: config.leaseSeconds,
    staleLockSeconds: config.staleLockSeconds,
    reconcileIntervalMs: config.reconcileIntervalMs,
    pollIntervalMs: config.pollIntervalMs,
    concurrency: config.concurrency,
    maxStageAttempts: config.maxStageAttempts,
    juryEnabled: config.juryEnabled,
    caseBudget: config.caseBudget,
    ...(config.intakeSettings
      ? {
          intakeToolRunner: config.intakeSettings.toolRunner,
          intakeRepos: Object.keys(config.intakeSettings.sources).sort(),
          intakeAllowLocalSource: config.intakeSettings.allowLocalSource,
        }
      : {}),
    ...(config.trialSettings
      ? {
          killSwitch: config.trialSettings.killSwitch,
          killSwitchFile: config.trialSettings.killSwitchFile !== null,
          turnBudget: config.trialSettings.turnBudget,
          maxAgentTurns: config.trialSettings.maxAgentTurns,
        }
      : {}),
    ...(config.judgeSettings
      ? {
          nodegoatBundle: config.judgeSettings.nodegoatBundle !== null,
          nodegoatTrees: config.judgeSettings.nodegoatDir !== null,
          sweepOrphans: config.judgeSettings.sweepOrphans,
        }
      : {}),
  };
}
