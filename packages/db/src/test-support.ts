import { randomBytes } from 'node:crypto';
import { CaseFile, samples } from '@affidavit/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  APP_ROLE,
  WORKER_ROLE,
  applyMigrations,
  provisionTenant,
  setRolePassword,
} from './migrate.js';
import { openPool } from './tenant.js';

/** Superuser or owner URL of a throwaway Postgres server, e.g. the compose one. */
export const PG_ADMIN_URL = process.env.AFFIDAVIT_TEST_DATABASE_URL;

export const SKIP_REASON =
  'SKIPPED: set AFFIDAVIT_TEST_DATABASE_URL to the admin URL of a throwaway Postgres server ' +
  '(docker compose -f docker/compose.yaml up -d postgres) and run `pnpm --filter @affidavit/db test:pg`. ' +
  'CI does not run these tests until a Postgres service is added.';

/** `describe` that skips the whole suite, loudly, when there is no database to test against. */
export function describePg(name: string, fn: () => void): void {
  if (PG_ADMIN_URL) {
    describe(name, fn);
    return;
  }
  console.warn(`[@affidavit/db test:pg] ${name}: ${SKIP_REASON}`);
  describe.skip(`${name} (${SKIP_REASON})`, fn);
}

export interface TestDatabase {
  name: string;
  adminUrl: string;
  appUrl: string;
  /** Owner/superuser pool: for assertions about what exists, never for the code under test. */
  admin: pg.Pool;
  /** Pool for the non-owner application role. */
  app: pg.Pool;
  worker: pg.Pool;
  workerUrl: string;
  drop(): Promise<void>;
}

function withDb(url: string, name: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/** A fresh database on the test server, migrated, with the application role able to log in. */
export async function createTestDatabase(tenants: readonly string[] = []): Promise<TestDatabase> {
  if (!PG_ADMIN_URL) throw new Error(SKIP_REASON);
  const name = `affidavit_test_${randomBytes(6).toString('hex')}`;
  const root = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  const adminUrl = withDb(PG_ADMIN_URL, name);
  try {
    await applyMigrations(adminUrl);
  } catch (err) {
    const r = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
    await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await r.end();
    throw err;
  }
  for (const t of tenants) await provisionTenant(adminUrl, t);
  const appPassword = randomBytes(18).toString('hex');
  const workerPassword = randomBytes(18).toString('hex');
  await setRolePassword(adminUrl, APP_ROLE, appPassword);
  await setRolePassword(adminUrl, WORKER_ROLE, workerPassword);
  const appUrl = withDb(PG_ADMIN_URL, name, { name: APP_ROLE, password: appPassword });
  const workerUrl = withDb(PG_ADMIN_URL, name, { name: WORKER_ROLE, password: workerPassword });
  const admin = new pg.Pool({ connectionString: adminUrl });
  const app = await openPool(appUrl);
  const worker = await openPool(workerUrl);
  return {
    name,
    adminUrl,
    appUrl,
    admin,
    app,
    worker,
    workerUrl,
    async drop() {
      await app.end();
      await worker.end();
      await admin.end();
      const r = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
      await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await r.end();
    },
  };
}

/** Registers beforeAll/afterAll for a fresh database and returns an accessor for it. */
export function useTestDatabase(tenants: readonly string[] = []): () => TestDatabase {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase(tenants);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  return () => {
    if (!db) throw new Error('test database not ready');
    return db;
  };
}

let counter = 0;
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${randomBytes(3).toString('hex')}-${counter}`;
}

/** The contracts sample case file, re-keyed for a tenant. */
export function sampleCase(
  tenantId: string,
  overrides: { id?: string; score?: number; floor?: number } = {},
): CaseFile {
  const base = CaseFile.parse(samples.CaseFile);
  return CaseFile.parse({
    ...base,
    id: overrides.id ?? uniqueId('case'),
    tenantId,
    escalationFloor: overrides.floor ?? base.escalationFloor,
    candidate: { ...base.candidate, score: overrides.score ?? base.candidate.score },
  });
}

export const BUDGET = { maxInputTokens: 1_000_000, maxOutputTokens: 200_000, maxUsd: 5 };
