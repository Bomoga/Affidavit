import { TenantId } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The two login roles the services may connect as. */
export type LoginRole = 'affidavit_app' | 'affidavit_worker';

/**
 * Creates an UNGUARDED pool (not exported: use openPool, which checks the role). An idle client erroring would otherwise crash the process, so errors are
 * reported to `onError` (default: one line on stderr, no connection details).
 */
function createPool(
  connectionString: string,
  onError: (err: Error) => void = (err) => {
    console.error(`[@affidavit/db] idle pool client error: ${err.message}`);
  },
): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on('error', onError);
  return pool;
}

export class UnsafeRoleError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`refusing to run as an unsafe database role: ${reasons.join('; ')}`);
    this.name = 'UnsafeRoleError';
  }
}

/** The search_path both login roles are given by the security migration. */
export const EXPECTED_SEARCH_PATH = 'pg_catalog, public, pg_temp';

/**
 * Connect-time guard. The role must not be a superuser, bypass RLS, create roles or databases, own
 * any relation, function, schema or the database, or be a member (directly or through other
 * roles) of a privileged role or a predefined pg_* role (pg_write_all_data and friends). Its
 * search_path must be the pinned one. A mistaken admin URL fails here, loudly.
 */
export async function assertSafeRole(pool: pg.Pool, expected: LoginRole): Promise<void> {
  const { rows } = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    any_membership: boolean;
    bad_settings: string | null;
    tenant_setting: string | null;
    owns_relation: boolean;
    owns_function: boolean;
    owns_schema: boolean;
    owns_database: boolean;
    bad_memberships: string | null;
    search_path: string;
  }>(`
    with recursive memb(oid) as (
      select r.oid from pg_roles r where r.rolname = current_user
      union
      select m.roleid from pg_auth_members m join memb on m.member = memb.oid
    )
    select me.rolname, me.rolsuper, me.rolbypassrls, me.rolcreaterole, me.rolcreatedb, me.rolreplication,
      exists (select 1 from pg_auth_members m where m.member = me.oid) as any_membership,
      (select string_agg(c, ', ') from pg_db_role_setting st, unnest(st.setconfig) c
        where st.setrole = me.oid
          and st.setdatabase in (0, (select oid from pg_database where datname = current_database()))
          and c not like 'search_path=%') as bad_settings,
      current_setting('app.tenant_id', true) as tenant_setting,
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relowner = me.oid and n.nspname <> 'information_schema'
                and n.nspname not like 'pg\\_%') as owns_relation,
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where p.proowner = me.oid and n.nspname <> 'information_schema'
                and n.nspname not like 'pg\\_%') as owns_function,
      exists (select 1 from pg_namespace n where n.nspowner = me.oid) as owns_schema,
      exists (select 1 from pg_database d where d.datdba = me.oid) as owns_database,
      (select string_agg(g.rolname, ', ') from memb join pg_roles g on g.oid = memb.oid
        where g.oid <> me.oid and (g.rolsuper or g.rolbypassrls or g.rolcreaterole
          or g.rolcreatedb or g.rolname like 'pg\\_%')) as bad_memberships,
      current_setting('search_path') as search_path
    from pg_roles me where me.rolname = current_user`);
  const r = rows[0];
  if (!r) throw new UnsafeRoleError(['current role not found']);
  const reasons: string[] = [];
  const n = r.rolname;
  if (n !== expected) reasons.push(`connected as ${n}, expected ${expected}`);
  if (r.rolreplication) reasons.push(`${n} has REPLICATION`);
  if (r.any_membership) reasons.push(`${n} is a member of another role`);
  if (r.bad_settings)
    reasons.push(`${n} has role-level settings besides search_path: ${r.bad_settings}`);
  if (r.tenant_setting) reasons.push(`${n} starts a session with app.tenant_id set`);
  if (r.rolsuper) reasons.push(`${n} is a superuser`);
  if (r.rolbypassrls) reasons.push(`${n} has BYPASSRLS`);
  if (r.rolcreaterole) reasons.push(`${n} can create roles`);
  if (r.rolcreatedb) reasons.push(`${n} can create databases`);
  if (r.owns_relation) reasons.push(`${n} owns tables or other relations`);
  if (r.owns_function) reasons.push(`${n} owns functions`);
  if (r.owns_schema) reasons.push(`${n} owns a schema`);
  if (r.owns_database) reasons.push(`${n} owns the database`);
  if (r.bad_memberships) reasons.push(`${n} is a member of privileged roles: ${r.bad_memberships}`);
  if (r.search_path !== EXPECTED_SEARCH_PATH) {
    reasons.push(`${n} has search_path "${r.search_path}", expected "${EXPECTED_SEARCH_PATH}"`);
  }
  if (reasons.length > 0) throw new UnsafeRoleError(reasons);
}

/** Creates a pool and refuses it unless the role is safe. Use this at process startup. */
export async function openPool(
  connectionString: string,
  expected: LoginRole,
  onError?: (err: Error) => void,
): Promise<pg.Pool> {
  const pool = createPool(connectionString, onError);
  try {
    await assertSafeRole(pool, expected);
  } catch (err) {
    await pool.end();
    throw err;
  }
  return pool;
}

/**
 * Runs `fn` in one transaction with `app.tenant_id` set for that transaction only
 * (`set_config(..., true)`), so a pooled connection never carries a tenant into the next
 * checkout. Every query on tenant tables must go through here; with no tenant set, row-level
 * security returns no rows. The connection is reset (DISCARD ALL) before it returns to the pool,
 * and dropped if that fails.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tenant = TenantId.parse(tenantId);
  const client = await pool.connect();
  try {
    return await drizzle(client, { schema }).transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
      return fn(tx);
    });
  } catch (err) {
    throw unwrapDriverError(err);
  } finally {
    try {
      await client.query('DISCARD ALL');
      client.release();
    } catch (err) {
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * Drizzle wraps driver errors in a "Failed query" message. Callers want the Postgres message and
 * code, so a wrapped driver error (one with a string `code`) is rethrown as itself.
 */
function unwrapDriverError(err: unknown): unknown {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && typeof (cause as { code?: unknown }).code === 'string')
    return cause;
  return err;
}

/** The Postgres error code behind a driver or Drizzle error, if any. */
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && typeof cur === 'object' && cur !== null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
