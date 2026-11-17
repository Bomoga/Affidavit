/**
 * Worker configuration, read from process environment only. Nothing here comes from a file, and
 * no error or description ever contains a connection string (they carry passwords).
 */

export type Impl = 'fake' | 'real';

export interface WorkerConfig {
  /** `affidavit_app` role URL. Secret. */
  appDatabaseUrl: string;
  /** `affidavit_worker` role URL. Secret. */
  workerDatabaseUrl: string;
  /** Lane 1 intake, map and arraign handlers. `real` is not wired yet (L1-01, L1-05, L1-06). */
  intake: Impl;
  /** Lane 3 trial handlers (defense to jury). `real` is not wired yet. */
  trial: Impl;
  /** Lane 2 Judge as the JudgePort. `real` is not wired yet. */
  judge: Impl;
  leaseSeconds: number;
  staleLockSeconds: number;
  reconcileIntervalMs: number;
  pollIntervalMs: number;
  concurrency: number;
  /** Total attempts of one stage, the first included, before a human has to look. */
  maxStageAttempts: number;
  juryEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid worker configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

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

/** Validates the environment. Throws ConfigError listing every problem, none of them a secret. */
export function loadConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];
  const config: WorkerConfig = {
    appDatabaseUrl: urlVar(env, 'AFFIDAVIT_APP_DATABASE_URL', problems),
    workerDatabaseUrl: urlVar(env, 'AFFIDAVIT_WORKER_DATABASE_URL', problems),
    intake: implVar(env, 'AFFIDAVIT_INTAKE_IMPL', problems),
    trial: implVar(env, 'AFFIDAVIT_TRIAL_IMPL', problems),
    judge: implVar(env, 'AFFIDAVIT_JUDGE_IMPL', problems),
    leaseSeconds: intVar(env, 'AFFIDAVIT_LEASE_SECONDS', 300, 1, 3600, problems),
    staleLockSeconds: intVar(env, 'AFFIDAVIT_STALE_LOCK_SECONDS', 600, 1, 86_400, problems),
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
    juryEnabled: boolVar(env, 'AFFIDAVIT_JURY_ENABLED', true, problems),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The non-secret part of the configuration, safe to log. */
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
  };
}
