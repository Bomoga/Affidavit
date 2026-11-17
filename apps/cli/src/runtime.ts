import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Budget as BudgetSchema,
  CaseFile as CaseFileSchema,
  CaseId as CaseIdSchema,
  type Budget,
  type CaseFile,
  type CaseStage,
  type TrialEvent,
} from '@affidavit/contracts';
import {
  PgCaseStore,
  PgEventSink,
  openPool,
  startCase as dbStartCase,
  type AppPool,
} from '@affidavit/db';
import { CliError, ExitCode } from './exit.js';

type Env = Readonly<Record<string, string | undefined>>;

/** What the commands need from a case backend. Postgres in production, an in-memory fake in tests. */
export interface CasePort {
  startCase(file: CaseFile, budget: Budget): Promise<void>;
  stage(caseId: string): Promise<CaseStage>;
  /** Events with seq greater than `afterSeq`, in seq order. There is no push API, so callers poll (CR-9). */
  events(caseId: string, afterSeq: number): Promise<TrialEvent[]>;
  close(): Promise<void>;
}

export interface CliConfig {
  /** `affidavit_app` role URL. Secret: never printed. */
  databaseUrl: string;
  tenantId: string;
}

/** Fixed default budget for CLI-started cases. Limits, not measurements. */
export const DEFAULT_BUDGET: Budget = BudgetSchema.parse({
  maxInputTokens: 1_000_000,
  maxOutputTokens: 200_000,
  maxUsd: 5,
});

/** Reads the environment. Errors name variables, never values (a database URL carries a password). */
export function loadCliConfig(env: Env): CliConfig {
  const problems: string[] = [];
  const url = env.AFFIDAVIT_APP_DATABASE_URL ?? '';
  if (url === '') problems.push('AFFIDAVIT_APP_DATABASE_URL is required');
  else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
        problems.push('AFFIDAVIT_APP_DATABASE_URL must be a postgres:// URL');
      }
    } catch {
      problems.push('AFFIDAVIT_APP_DATABASE_URL is not a valid URL');
    }
  }
  const tenant = env.AFFIDAVIT_TENANT_ID ?? '';
  if (tenant === '') problems.push('AFFIDAVIT_TENANT_ID is required');
  else if (tenant.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(tenant)) {
    problems.push('AFFIDAVIT_TENANT_ID may only contain letters, digits, ". _ : -" (max 128)');
  }
  if (problems.length > 0) {
    throw new CliError(ExitCode.CONFIG, `invalid configuration: ${problems.join('; ')}`);
  }
  return { databaseUrl: url, tenantId: tenant };
}

/** Intake is fake in v0: scan refuses anything else. Returns normally only for `fake`. */
export function requireFakeIntake(env: Env): void {
  const impl = env.AFFIDAVIT_INTAKE_IMPL;
  if (impl === 'fake') return;
  if (impl === 'real') {
    throw new CliError(
      ExitCode.NOT_IMPLEMENTED,
      'real intake is not implemented yet (L1-01, L1-05, L1-06). Set AFFIDAVIT_INTAKE_IMPL=fake to scan with the recorded NodeGoat fixture.',
    );
  }
  throw new CliError(
    ExitCode.CONFIG,
    'scan only runs with fake intake in v0: set AFFIDAVIT_INTAKE_IMPL=fake.',
  );
}

const FIXTURE = new URL('../../../fixtures/casefiles/nodegoat-sqli-001.json', import.meta.url);

/**
 * The fake intake's case file: the recorded nodegoat-sqli-001 fixture with a fresh case id, the
 * caller's tenant and `target.repo` set from the scan argument.
 */
export function buildCaseFile(target: string, tenantId: string, fixture?: unknown): CaseFile {
  let raw = fixture;
  if (raw === undefined) {
    try {
      raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    } catch (err) {
      throw new CliError(ExitCode.INTERNAL, 'could not read the nodegoat-sqli-001 case fixture', {
        cause: err,
      });
    }
  }
  const base = CaseFileSchema.parse(raw);
  return CaseFileSchema.parse({
    ...base,
    id: `case-cli-${randomBytes(6).toString('hex')}`,
    tenantId,
    target: { ...base.target, repo: target },
  });
}

/** Postgres-backed port. Opens one `affidavit_app` pool; the role check is done by openPool. */
export async function openPgCasePort(config: CliConfig): Promise<CasePort> {
  const pool: AppPool = await openPool(config.databaseUrl, 'affidavit_app', () => undefined);
  const store = new PgCaseStore(pool, config.tenantId);
  const sink = new PgEventSink(pool, config.tenantId);
  return {
    startCase: (file, budget) => dbStartCase(pool, file, budget),
    stage: (id) => store.stage(CaseIdSchema.parse(id)),
    events: (id, afterSeq) => sink.events(CaseIdSchema.parse(id), afterSeq),
    close: () => pool.end(),
  };
}

/** The URL and the password inside it: both must be scrubbed from anything printed. */
export function secretsOf(databaseUrl: string): string[] {
  const out = [databaseUrl];
  try {
    const u = new URL(databaseUrl);
    if (u.password !== '') out.push(u.password, decodeURIComponent(u.password));
  } catch {
    // Not a URL: loadCliConfig has already rejected it.
  }
  return out;
}

/** Maps a thrown error to a CliError with a message that cannot hold a connection string. */
export function toCliError(err: unknown, secrets: readonly string[] = []): CliError {
  if (err instanceof CliError) return err;
  const raw = err instanceof Error ? err.message : 'unknown error';
  let msg = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]');
  for (const s of secrets) if (s.length > 0) msg = msg.split(s).join('[redacted]');
  msg = msg.slice(0, 300);
  const code = (err as { code?: unknown } | null)?.code;
  if (/^unknown case /.test(raw)) return new CliError(ExitCode.NOT_FOUND, msg, { cause: err });
  if (/^unknown tenant /.test(raw)) {
    return new CliError(ExitCode.CONFIG, `${msg} (provision it first)`, { cause: err });
  }
  if (
    typeof code === 'string' &&
    (/^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_|28|08|57P)/.test(code) || code === 'EPERM')
  ) {
    return new CliError(ExitCode.UNAVAILABLE, `database unavailable or refused: ${msg}`, {
      cause: err,
    });
  }
  if (/^(database|role|connect|password|no pg_hba|the database system)/i.test(raw)) {
    return new CliError(ExitCode.UNAVAILABLE, `database unavailable or refused: ${msg}`, {
      cause: err,
    });
  }
  return new CliError(ExitCode.INTERNAL, `unexpected error: ${msg}`, { cause: err });
}
