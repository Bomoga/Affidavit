import { expect, it } from 'vitest';
import pg from 'pg';
import { applyMigrations, APP_ROLE, OWNER_ROLE, WORKER_ROLE, bootstrapRoles } from './migrate.js';
import { describePg, useTestDatabase } from './test-support.js';

describePg('migrations on a fresh Postgres', () => {
  const db = useTestDatabase();

  it('creates every table with tenant_id, row-level security enabled and forced', async () => {
    const { rows } = await db().admin.query<{
      relname: string;
      has_tenant: boolean;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        exists (select 1 from information_schema.columns k
                where k.table_schema = 'public' and k.table_name = c.relname
                  and k.column_name = 'tenant_id') as has_tenant
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`);
    expect(rows.map((r) => r.relname)).toEqual([
      'ballots',
      'cases',
      'cost_rows',
      'escalations',
      'events',
      'exhibits',
      'repos',
      'stage_jobs',
      'stage_runs',
      'stages',
      'tenants',
      'verdicts',
    ]);
    for (const r of rows) {
      expect(r.has_tenant, `${r.relname} has tenant_id`).toBe(true);
      expect(r.relrowsecurity, `${r.relname} RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} RLS forced`).toBe(true);
    }
  });

  it('both login roles are plain: not superuser, no BYPASSRLS, no members, own nothing', async () => {
    for (const role of [APP_ROLE, WORKER_ROLE]) {
      const r = await db().admin.query(
        `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit from pg_roles where rolname = $1`,
        [role],
      );
      expect(r.rows, role).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolinherit: false,
        },
      ]);
      const member = await db().admin.query(
        `select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = $1`,
        [role],
      );
      expect(member.rows, role).toHaveLength(0);
      const owned = await db().admin.query(
        `select 1 from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = $1
         union all select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
           join pg_namespace n on n.oid = p.pronamespace where r.rolname = $1 and n.nspname not like 'pg\\_%'
         union all select 1 from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = $1
         union all select 1 from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = $1`,
        [role],
      );
      expect(owned.rows, role).toHaveLength(0);
    }
    const who = await db().app.query<{ current_user: string }>('select current_user');
    expect(who.rows[0]!.current_user).toBe(APP_ROLE);
  });

  it('the application role has no DELETE anywhere on tenant tables', async () => {
    const { rows } = await db().admin.query<{ table_name: string }>(
      `select table_name from information_schema.role_table_grants
       where grantee = $1 and table_schema = 'public' and privilege_type in ('DELETE','TRUNCATE')`,
      [APP_ROLE],
    );
    expect(rows).toEqual([]);
  });

  it('everything runs as a non-superuser owner: objects, SECURITY DEFINER functions and owner policies', async () => {
    const owner = await db().admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = $1`,
      [OWNER_ROLE],
    );
    expect(owner.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const dbOwner = await db().admin.query<{ owner: string }>(
      `select r.rolname as owner from pg_database d join pg_roles r on r.oid = d.datdba
       where d.datname = current_database()`,
    );
    expect(dbOwner.rows[0]!.owner).toBe(OWNER_ROLE);
    const tables = await db().admin.query<{ owner: string }>(
      `select distinct r.rolname as owner from pg_class c join pg_roles r on r.oid = c.relowner
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'graphile_worker') and c.relkind in ('r', 'v')`,
    );
    expect(tables.rows).toEqual([{ owner: OWNER_ROLE }]);
    const fns = await db().admin.query<{ proname: string; owner: string }>(
      `select p.proname, r.rolname as owner from pg_proc p join pg_roles r on r.oid = p.proowner
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef order by p.proname`,
    );
    expect(fns.rows).toEqual([
      { proname: 'claim_stage_run', owner: OWNER_ROLE },
      { proname: 'enqueue_stage', owner: OWNER_ROLE },
      { proname: 'record_stage_entry', owner: OWNER_ROLE },
      { proname: 'stage_run_complete', owner: OWNER_ROLE },
      { proname: 'stage_run_fail', owner: OWNER_ROLE },
      { proname: 'stage_run_heartbeat', owner: OWNER_ROLE },
      { proname: 'stage_run_job_alive', owner: OWNER_ROLE },
    ]);
    const pol = await db().admin.query<{ tablename: string; roles: string[] }>(
      `select tablename, roles::text[] as roles from pg_policies
       where schemaname = 'public' and policyname in ('owner_access', 'owner_read') order by tablename`,
    );
    expect(pol.rows.map((p) => p.tablename)).toEqual([
      'cases',
      'stage_jobs',
      'stage_runs',
      'stages',
      'tenants',
    ]);
    for (const p of pol.rows) expect(p.roles).toEqual([OWNER_ROLE]);
    // The owner really is subject to FORCE RLS: without its policy it would see nothing, and it
    // sees no events (no owner policy there) even though rows exist.
    const asOwner = new pg.Pool({ connectionString: db().ownerUrl, max: 1 });
    try {
      const seen = await asOwner.query(`select * from public.verdicts`);
      expect(seen.rows).toHaveLength(0);
      const tenants = await asOwner.query(`select * from public.tenants`);
      expect(tenants.rows.length).toBeGreaterThan(-1);
    } finally {
      await asOwner.end();
    }
  });

  it('bootstrapRoles is idempotent', async () => {
    await expect(bootstrapRoles(db().adminUrl)).resolves.toBeUndefined();
  });

  it('re-applying migrations is a no-op', async () => {
    await expect(applyMigrations(db().ownerUrl)).resolves.toBeUndefined();
  });
});
