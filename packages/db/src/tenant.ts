import { TenantId } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const dbs = new WeakMap<pg.Pool, Db>();

function dbFor(pool: pg.Pool): Db {
  let db = dbs.get(pool);
  if (!db) {
    db = drizzle(pool, { schema });
    dbs.set(pool, db);
  }
  return db;
}

/** Creates a pool. The application URL must name the non-owner `affidavit_app` login role. */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/**
 * Runs `fn` in one transaction with `app.tenant_id` set for that transaction only
 * (`set_config(..., true)`), so a pooled connection never carries a tenant into the next
 * checkout. Every query on tenant tables must go through here; with no tenant set, row-level
 * security returns no rows.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tenant = TenantId.parse(tenantId);
  return dbFor(pool).transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
    return fn(tx);
  });
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
