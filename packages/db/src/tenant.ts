import { TenantId } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Creates a pool. The URL must name a non-owner login role (`affidavit_app` or
 * `affidavit_worker`). An idle client erroring would otherwise crash the process, so errors are
 * reported to `onError` (default: one line on stderr, no connection details).
 */
export function createPool(
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

/**
 * Connect-time guard: the role must not be a superuser, must not bypass RLS, must not be able to
 * create roles or databases, must not own any table or function in the schemas we use, and must
 * not inherit from a role that does any of that. A mistaken admin URL fails here, loudly.
 */
export async function assertSafeRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    owns: boolean;
    via_membership: boolean;
  }>(`
    select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relowner = r.oid and n.nspname in ('public', 'graphile_worker')) as owns,
      exists (select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid
              where m.member = r.oid
                and (g.rolsuper or g.rolbypassrls or g.rolcreaterole or g.rolcreatedb)) as via_membership
    from pg_roles r where r.rolname = current_user`);
  const r = rows[0];
  if (!r) throw new UnsafeRoleError(['current role not found']);
  const reasons: string[] = [];
  if (r.rolsuper) reasons.push(`${r.rolname} is a superuser`);
  if (r.rolbypassrls) reasons.push(`${r.rolname} has BYPASSRLS`);
  if (r.rolcreaterole) reasons.push(`${r.rolname} can create roles`);
  if (r.rolcreatedb) reasons.push(`${r.rolname} can create databases`);
  if (r.owns) reasons.push(`${r.rolname} owns tables`);
  if (r.via_membership) reasons.push(`${r.rolname} is a member of a privileged role`);
  if (reasons.length > 0) throw new UnsafeRoleError(reasons);
}

/** Creates a pool and refuses it unless the role is safe. Use this at process startup. */
export async function openPool(
  connectionString: string,
  onError?: (err: Error) => void,
): Promise<pg.Pool> {
  const pool = createPool(connectionString, onError);
  try {
    await assertSafeRole(pool);
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
  } finally {
    try {
      await client.query('DISCARD ALL');
      client.release();
    } catch (err) {
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  }
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
