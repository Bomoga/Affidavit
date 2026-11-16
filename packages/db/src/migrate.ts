import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { runMigrations } from 'graphile-worker';
import pg from 'pg';

/** The login role the application connects as. Created NOLOGIN by the security migration. */
export const APP_ROLE = 'affidavit_app';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Applies the Drizzle migrations and the Graphile Worker schema, then lets the application role
 * use the queue. Run as the database owner (an admin URL), never as the application role.
 * Safe to run repeatedly.
 */
export async function applyMigrations(adminUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
  await runMigrations({ connectionString: adminUrl });
  const grants = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (const stmt of [
      `GRANT USAGE ON SCHEMA graphile_worker TO ${APP_ROLE}`,
      `GRANT ALL ON ALL TABLES IN SCHEMA graphile_worker TO ${APP_ROLE}`,
      `GRANT ALL ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${APP_ROLE}`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${APP_ROLE}`,
    ]) {
      await grants.query(stmt);
    }
    // Graphile Worker enables RLS on its own tables with no policies, which locks out every
    // role but the owner. The queue holds only ids (tenant, case, stage, attempt), is not a
    // tenant data table, and is used by the worker process, so give the application role a
    // blanket policy there. Tenant tables stay governed by the tenant policies.
    const { rows } = await grants.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'graphile_worker' and c.relkind = 'r' and c.relrowsecurity`,
    );
    for (const { relname } of rows) {
      await grants.query(
        `DROP POLICY IF EXISTS affidavit_queue_access ON graphile_worker.${quoteIdent(relname)}`,
      );
      await grants.query(
        `CREATE POLICY affidavit_queue_access ON graphile_worker.${quoteIdent(relname)} ` +
          `FOR ALL TO ${APP_ROLE} USING (true) WITH CHECK (true)`,
      );
    }
  } finally {
    await grants.end();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Gives the application role a login password. Deployment concern: the password comes from the
 * environment at provisioning time and is never written to a migration or a committed file.
 */
export async function setAppRolePassword(adminUrl: string, password: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ stmt: string }>(
      `select format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) as stmt`,
      [APP_ROLE, password],
    );
    await pool.query(rows[0]!.stmt);
  } finally {
    await pool.end();
  }
}
