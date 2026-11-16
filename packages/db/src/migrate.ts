import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TenantId } from '@affidavit/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { runMigrations } from 'graphile-worker';
import pg from 'pg';

/** Tenant-facing login role: tenant tables under RLS, and enqueue_stage(). */
export const APP_ROLE = 'affidavit_app';
/** Queue-runner login role: the Graphile Worker schema only, no tenant tables. */
export const WORKER_ROLE = 'affidavit_worker';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Applies the Drizzle migrations and the Graphile Worker schema, then sets queue access for the
 * worker role only. Run as the database owner (an admin URL), never as an application role.
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
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await grantQueueAccess(admin);
  } finally {
    await admin.end();
  }
}

/**
 * The queue schema belongs to the worker role. The tenant-facing role gets nothing there; it
 * reaches the queue only through the SECURITY DEFINER enqueue_stage() wrapper. The worker gets
 * row access but no TRUNCATE, TRIGGER or REFERENCES, and may only read Graphile's migrations table.
 */
async function grantQueueAccess(admin: pg.Pool): Promise<void> {
  const s = 'graphile_worker';
  for (const stmt of [
    `REVOKE ALL ON SCHEMA ${s} FROM PUBLIC`,
    `REVOKE ALL ON SCHEMA ${s} FROM ${APP_ROLE}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC, ${APP_ROLE}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC, ${APP_ROLE}`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC, ${APP_ROLE}`,
    `GRANT USAGE ON SCHEMA ${s} TO ${WORKER_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${WORKER_ROLE}`,
    `REVOKE INSERT, UPDATE, DELETE ON ${s}.migrations FROM ${WORKER_ROLE}`,
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${WORKER_ROLE}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${WORKER_ROLE}`,
  ]) {
    await admin.query(stmt);
  }
  // Graphile Worker enables RLS on its own tables with no policy, which locks out every role but
  // the owner. Give the worker role a policy there. The application role has none.
  const { rows } = await admin.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind = 'r' and c.relrowsecurity`,
    [s],
  );
  for (const { relname } of rows) {
    const table = `${s}.${quoteIdent(relname)}`;
    await admin.query(`DROP POLICY IF EXISTS affidavit_queue_access ON ${table}`);
    await admin.query(
      `CREATE POLICY affidavit_queue_access ON ${table} FOR ALL TO ${WORKER_ROLE} USING (true) WITH CHECK (true)`,
    );
  }
}

/** Tenant creation is an owner operation: the application role cannot create tenants. */
export async function provisionTenant(
  adminUrl: string,
  tenantId: string,
  name?: string,
): Promise<void> {
  const id = TenantId.parse(tenantId);
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await pool.query(
      `insert into public.tenants (tenant_id, name) values ($1, $2) on conflict do nothing`,
      [id, name ?? null],
    );
  } finally {
    await pool.end();
  }
}

/**
 * A SCRAM-SHA-256 verifier, so the plaintext password never reaches the server or its logs.
 * Uses the password as given (no SASLprep), so keep provisioned passwords ASCII.
 */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Lets a role log in. Deployment concern: the password comes from the environment at
 * provisioning time and is never written to a migration or a committed file. The server receives
 * only a SCRAM verifier.
 */
export async function setRolePassword(
  adminUrl: string,
  role: typeof APP_ROLE | typeof WORKER_ROLE,
  password: string,
): Promise<void> {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ stmt: string }>(
      `select format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) as stmt`,
      [role, scramVerifier(password)],
    );
    await pool.query(rows[0]!.stmt);
  } finally {
    await pool.end();
  }
}

export function setAppRolePassword(adminUrl: string, password: string): Promise<void> {
  return setRolePassword(adminUrl, APP_ROLE, password);
}
