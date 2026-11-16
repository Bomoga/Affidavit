import { Verdict, samples } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { openPool, UnsafeRoleError, withTenant } from './tenant.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const T = 'tenant-s';

describePg('session and role hardening', () => {
  const db = useTestDatabase([T]);

  it('the application role cannot create temp tables, so it cannot shadow a tenant table', async () => {
    const c = await db().app.connect();
    try {
      await expect(c.query(`create temp table events (x int)`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(c.query(`create temporary table pg_temp.verdicts (x int)`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      c.release();
    }
  });

  it('the worker role cannot create temp tables either, and temp is revoked from PUBLIC', async () => {
    await expect(db().worker.query(`create temp table x (y int)`)).rejects.toThrow(
      /permission denied/,
    );
    const { rows } = await db().admin.query<{ acl: string }>(
      `select coalesce(datacl::text, '') as acl from pg_database where datname = current_database()`,
    );
    // A PUBLIC entry looks like '=Tc/owner'; after the revoke it has no T (temporary).
    expect(rows[0]!.acl).not.toMatch(/(^|[{,])=[A-Za-z]*T/);
  });

  it('login roles have a pinned search_path with pg_temp last', async () => {
    const { rows } = await db().app.query<{ search_path: string }>('show search_path');
    expect(rows[0]!.search_path).toBe('pg_catalog, public, pg_temp');
  });

  it('every function in public pins its search_path', async () => {
    const { rows } = await db().admin.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proconfig is null or not exists (
        select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`);
    expect(rows).toEqual([]);
  });

  it('session state does not survive on a pooled connection', async () => {
    const pool = new pg.Pool({ connectionString: db().appUrl, max: 1 });
    try {
      await withTenant(pool, T, (tx) =>
        tx.execute(sql`select set_config('leak.value', 'secret', false)`),
      );
      const seen = await withTenant(pool, T, async (tx) => {
        const r = await tx.execute(sql`select current_setting('leak.value', true) as v`);
        return (r.rows[0] as { v: string | null }).v;
      });
      expect(seen === null || seen === '').toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('a pooled connection never keeps the tenant of the previous call', async () => {
    const pool = new pg.Pool({ connectionString: db().appUrl, max: 1 });
    try {
      const store = new PgCaseStore(pool, T);
      const file = sampleCase(T);
      await store.open(file, BUDGET);
      await store.appendVerdict(Verdict.parse({ ...(samples.Verdict as object), caseId: file.id }));
      const { rows } = await pool.query('select * from verdicts');
      expect(rows).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  it('startup refuses a superuser, an owner, and a role with BYPASSRLS', async () => {
    await expect(openPool(db().adminUrl)).rejects.toBeInstanceOf(UnsafeRoleError);
    await expect(openPool(db().adminUrl)).rejects.toThrow(/superuser/);
    const roleName = 'affidavit_probe_bypass';
    await db().admin.query(`drop role if exists ${roleName}`);
    await db().admin.query(`create role ${roleName} login password 'probe-pw' bypassrls`);
    try {
      const u = new URL(db().adminUrl);
      u.username = roleName;
      u.password = 'probe-pw';
      await expect(openPool(u.toString())).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await db().admin.query(`drop role ${roleName}`);
    }
    const ownerRole = 'affidavit_probe_owner';
    await db().admin.query(`drop role if exists ${ownerRole}`);
    await db().admin.query(`create role ${ownerRole} login password 'probe-pw'`);
    await db().admin.query(`create table public.probe_owned (x int)`);
    await db().admin.query(`alter table public.probe_owned owner to ${ownerRole}`);
    try {
      const u = new URL(db().adminUrl);
      u.username = ownerRole;
      u.password = 'probe-pw';
      await expect(openPool(u.toString())).rejects.toThrow(/owns tables/);
    } finally {
      await db().admin.query(`drop table public.probe_owned`);
      await db().admin.query(`drop role ${ownerRole}`);
    }
  });

  it('startup accepts the application and worker roles', async () => {
    await expect(openPool(db().appUrl).then((p) => p.end())).resolves.toBeUndefined();
    await expect(openPool(db().workerUrl).then((p) => p.end())).resolves.toBeUndefined();
  });
});
