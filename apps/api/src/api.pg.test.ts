import { randomBytes } from 'node:crypto';
import { ApiRoutes, CaseId, type TrialEvent } from '@affidavit/contracts';
import {
  APP_ROLE,
  OWNER_ROLE,
  PgCaseStore,
  PgEventSink,
  applyMigrations,
  bootstrapRoles,
  openPool,
  provisionTenant,
  setRolePassword,
  type AppPool,
} from '@affidavit/db';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubTenantId } from './auth.js';
import { fixtureEvents } from './intake.js';
import { PgCaseBackend } from './pg-backend.js';
import { githubConfig, makeApp, parseSse, signIn, type Session } from './test-helpers.js';

/**
 * The API on real Postgres through the affidavit_app role (RLS on). Follows the packages/db
 * test:pg pattern: AFFIDAVIT_TEST_DATABASE_URL is the superuser URL of a THROWAWAY server; this
 * file creates and drops its own database. Without it the suite skips with a message.
 */
const ADMIN_URL = process.env.AFFIDAVIT_TEST_DATABASE_URL;
const SKIP =
  'SKIPPED: set AFFIDAVIT_TEST_DATABASE_URL to the superuser URL of a throwaway Postgres server and run `pnpm --filter @affidavit/api test:pg`.';
const describePg = ADMIN_URL
  ? describe
  : (name: string, fn: () => void) => {
      console.warn(`[@affidavit/api test:pg] ${name}: ${SKIP}`);
      describe.skip(`${name} (${SKIP})`, fn);
    };

function withDb(url: string, name: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

const A = 101;
const B = 202;
const UNPROVISIONED = 303;
const COMMIT = 'f'.repeat(40);

describePg('API over Postgres with RLS', () => {
  const dbName = `affidavit_api_test_${randomBytes(6).toString('hex')}`;
  let pool: AppPool;
  let app: FastifyInstance;
  let a: Session;
  let b: Session;
  let caseA: string;
  let expected: TrialEvent[];

  beforeAll(async () => {
    const root = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const adminUrl = withDb(ADMIN_URL!, dbName);
    const ownerPw = randomBytes(18).toString('hex');
    const appPw = randomBytes(18).toString('hex');
    await bootstrapRoles(adminUrl);
    await setRolePassword(adminUrl, OWNER_ROLE, ownerPw);
    const ownerUrl = withDb(ADMIN_URL!, dbName, { name: OWNER_ROLE, password: ownerPw });
    await applyMigrations(ownerUrl);
    await provisionTenant(ownerUrl, githubTenantId(A));
    await provisionTenant(ownerUrl, githubTenantId(B));
    await setRolePassword(adminUrl, APP_ROLE, appPw);
    pool = await openPool(
      withDb(ADMIN_URL!, dbName, { name: APP_ROLE, password: appPw }),
      APP_ROLE,
    );
    ({ app } = await makeApp(githubConfig(), { backend: new PgCaseBackend(pool) }));
    a = await signIn(app, A);
    b = await signIn(app, B);

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: a.cookies,
      headers: { 'x-csrf-token': a.csrf },
      payload: { repoUrl: 'https://github.com/OWASP/NodeGoat', commit: COMMIT },
    });
    expect(res.statusCode).toBe(201);
    caseA = ApiRoutes.createCase.response.parse(res.json()).caseId;

    // Stand in for the worker: write the fixture trial through the real store and sink.
    const tenant = githubTenantId(A);
    const store = new PgCaseStore(pool, tenant, { juryEnabled: false });
    const sink = new PgEventSink(pool, tenant);
    const id = CaseId.parse(caseA);
    for (const e of fixtureEvents('nodegoat-sqli-001', caseA).slice(1)) {
      expect(await store.nextSeq(id)).toBe(e.seq);
      await sink.emit(e);
      if (e.type === 'stage-exited') await store.transition(id, e.payload.to);
      if (e.type === 'verdict-written') await store.appendVerdict(e.payload.verdict);
    }
    expected = await sink.events(id);
    expect(expected).toHaveLength(19);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (ADMIN_URL) {
      const r = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
      await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await r.end();
    }
  }, 60_000);

  it('GET /cases/:id and /verdict validate against ApiRoutes', async () => {
    const c = await app.inject({ method: 'GET', url: `/cases/${caseA}`, cookies: a.cookies });
    const view = ApiRoutes.getCase.response.parse(c.json());
    expect(view.stage).toBe('verdict');
    expect(view.caseFile?.tenantId).toBe(githubTenantId(A));
    const v = await app.inject({
      method: 'GET',
      url: `/cases/${caseA}/verdict`,
      cookies: a.cookies,
    });
    expect(ApiRoutes.getVerdict.response.parse(v.json()).caseId).toBe(caseA);
  });

  it('streams the stored trial and resumes with Last-Event-ID and ?after', async () => {
    const full = await app.inject({
      method: 'GET',
      url: `/cases/${caseA}/events`,
      cookies: a.cookies,
    });
    const got = parseSse(full.body);
    expect(got.events).toEqual(expected);
    expect(got.ids).toEqual(expected.map((e) => String(e.seq)));
    const viaHeader = await app.inject({
      method: 'GET',
      url: `/cases/${caseA}/events`,
      headers: { 'last-event-id': '8' },
      cookies: a.cookies,
    });
    expect([...got.events.slice(0, 9), ...parseSse(viaHeader.body).events]).toEqual(expected);
    const viaQuery = await app.inject({
      method: 'GET',
      url: `/cases/${caseA}/events?after=15`,
      cookies: a.cookies,
    });
    expect(parseSse(viaQuery.body).events).toEqual(expected.slice(16));
  });

  it('tenant B gets the not-found body for A’s case on every route', async () => {
    for (const suffix of ['', '/events', '/verdict']) {
      const forbidden = await app.inject({
        method: 'GET',
        url: `/cases/${caseA}${suffix}`,
        cookies: b.cookies,
      });
      const missing = await app.inject({
        method: 'GET',
        url: `/cases/case-api-000000000000${suffix}`,
        cookies: b.cookies,
      });
      expect(forbidden.statusCode).toBe(404);
      expect(forbidden.body).toBe(missing.body);
      expect(forbidden.body).toBe('{"error":"not-found"}');
    }
  });

  it('a signed-in user whose tenant is not provisioned cannot open a case', async () => {
    const u = await signIn(app, UNPROVISIONED);
    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      cookies: u.cookies,
      headers: { 'x-csrf-token': u.csrf },
      payload: { repoUrl: 'https://github.com/x/y', commit: COMMIT },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'tenant-not-provisioned' });
  });
});
