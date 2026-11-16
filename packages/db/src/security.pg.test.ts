import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Verdict, samples } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { openPool, UnsafeRoleError, withTenant, type AppPool } from './tenant.js';
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
    const pool = new pg.Pool({ connectionString: db().appUrl, max: 1 }) as unknown as AppPool;
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
    const pool = new pg.Pool({ connectionString: db().appUrl, max: 1 }) as unknown as AppPool;
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
    await expect(openPool(db().adminUrl, 'affidavit_app')).rejects.toBeInstanceOf(UnsafeRoleError);
    await expect(openPool(db().adminUrl, 'affidavit_app')).rejects.toThrow(/superuser/);
    const roleName = 'affidavit_probe_bypass';
    await db().admin.query(`drop role if exists ${roleName}`);
    await db().admin.query(`create role ${roleName} login password 'probe-pw' bypassrls`);
    try {
      const u = new URL(db().adminUrl);
      u.username = roleName;
      u.password = 'probe-pw';
      await expect(openPool(u.toString(), 'affidavit_app')).rejects.toThrow(/BYPASSRLS/);
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
      await expect(openPool(u.toString(), 'affidavit_app')).rejects.toThrow(/owns tables/);
    } finally {
      await db().admin.query(`drop table public.probe_owned`);
      await db().admin.query(`drop role ${ownerRole}`);
    }
  });

  it('startup refuses inherited privilege, owned functions or schemas or database, and a wrong search_path', async () => {
    const probe = async (
      name: string,
      setup: string[],
      teardown: string[],
      expected: RegExp,
      pinPath = true,
    ) => {
      await db().admin.query(`drop role if exists ${name}`);
      await db().admin.query(`create role ${name} login password 'probe-pw'`);
      if (pinPath) {
        await db().admin.query(
          `alter role ${name} in database ${db().name} set search_path = pg_catalog, public, pg_temp`,
        );
      }
      try {
        for (const s of setup) await db().admin.query(s);
        const u = new URL(db().adminUrl);
        u.username = name;
        u.password = 'probe-pw';
        await expect(openPool(u.toString(), 'affidavit_app'), name).rejects.toThrow(expected);
      } finally {
        for (const s of teardown) await db().admin.query(s);
        await db().admin.query(`drop owned by ${name}`);
        await db().admin.query(`drop role ${name}`);
      }
    };
    await probe('probe_pgdata', ['grant pg_read_all_data to probe_pgdata'], [], /pg_read_all_data/);
    await probe(
      'probe_chain',
      [
        'create role probe_mid nologin',
        'grant pg_write_all_data to probe_mid',
        'grant probe_mid to probe_chain',
      ],
      ['drop role probe_mid'],
      /pg_write_all_data/,
    );
    await probe(
      'probe_func',
      [
        'create function public.probe_fn() returns int language sql as $$ select 1 $$',
        'alter function public.probe_fn() owner to probe_func',
      ],
      [],
      /owns functions/,
    );
    await probe(
      'probe_schema',
      ['create schema probe_s authorization probe_schema'],
      [],
      /owns a schema/,
    );
    await probe('probe_path', [], [], /search_path/, false);
    const dbOwner = 'probe_dbowner';
    await db().admin.query(`drop role if exists ${dbOwner}`);
    await db().admin.query(`create role ${dbOwner} login password 'probe-pw'`);
    await db().admin.query(
      `alter role ${dbOwner} in database ${db().name} set search_path = pg_catalog, public, pg_temp`,
    );
    const root = new URL(db().adminUrl);
    root.pathname = '/postgres';
    const rootPool = new pg.Pool({ connectionString: root.toString(), max: 1 });
    const owned = `affidavit_owned_${Date.now()}`;
    try {
      await rootPool.query(`create database ${owned} owner ${dbOwner}`);
      await rootPool.query(
        `alter role ${dbOwner} in database ${owned} set search_path = pg_catalog, public, pg_temp`,
      );
      const u = new URL(db().adminUrl);
      u.pathname = `/${owned}`;
      u.username = dbOwner;
      u.password = 'probe-pw';
      await expect(openPool(u.toString(), 'affidavit_app')).rejects.toThrow(/owns the database/);
    } finally {
      await rootPool.query(`drop database if exists ${owned} with (force)`);
      await rootPool.end();
      await db().admin.query(`drop role ${dbOwner}`);
    }
  });

  it('startup refuses any membership, REPLICATION, a role-level setting such as app.tenant_id, and the wrong role', async () => {
    const attempt = async (name: string, setup: string[], expected: RegExp) => {
      await db().admin.query(`drop role if exists ${name}`);
      await db().admin.query(`create role ${name} login password 'probe-pw'`);
      await db().admin.query(
        `alter role ${name} in database ${db().name} set search_path = pg_catalog, public, pg_temp`,
      );
      try {
        for (const s of setup) await db().admin.query(s);
        const u = new URL(db().adminUrl);
        u.username = name;
        u.password = 'probe-pw';
        await expect(openPool(u.toString(), 'affidavit_app'), name).rejects.toThrow(expected);
      } finally {
        await db().admin.query(`drop owned by ${name}`);
        await db().admin.query(`drop role ${name}`);
      }
    };
    await attempt(
      'probe_member',
      ['create role probe_plain nologin', 'grant probe_plain to probe_member'],
      /member of another role/,
    );
    await db().admin.query(`drop role probe_plain`);
    await attempt('probe_repl', ['alter role probe_repl replication'], /REPLICATION/);
    await attempt(
      'probe_setting',
      [`alter role probe_setting set app.tenant_id = 'tenant-b'`],
      /role-level settings besides search_path: app.tenant_id/,
    );
    await attempt('probe_other', [], /connected as probe_other, expected affidavit_app/);
    // The real worker role is not the application role.
    await expect(openPool(db().workerUrl, 'affidavit_app')).rejects.toThrow(
      /expected affidavit_app/,
    );
  });

  it('the tenant setting is transaction-local (pinned in the source)', async () => {
    const src = readFileSync(fileURLToPath(new URL('./tenant.ts', import.meta.url)), 'utf8');
    // A mutation to set_config(..., false) would make the tenant stick to the pooled connection
    // and rely on DISCARD ALL alone. Keep the third argument true.
    expect(src).toMatch(/set_config\('app\.tenant_id', \$\{tenant\}, true\)/);
    expect(src).not.toMatch(/set_config\('app\.tenant_id', \$\{tenant\}, false\)/);
    // And behaviourally: inside one transaction the setting is visible, after it it is gone, even
    // on a connection that never went through withTenant's DISCARD ALL.
    const c = await db().app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [T]);
      await c.query('commit');
      const { rows } = await c.query<{ v: string | null }>(
        `select nullif(current_setting('app.tenant_id', true), '') as v`,
      );
      expect(rows[0]!.v).toBeNull();
    } finally {
      c.release();
    }
  });

  it('startup accepts the application and worker roles', async () => {
    await expect(
      openPool(db().appUrl, 'affidavit_app').then((p) => p.end()),
    ).resolves.toBeUndefined();
    await expect(
      openPool(db().workerUrl, 'affidavit_worker').then((p) => p.end()),
    ).resolves.toBeUndefined();
  });
});
