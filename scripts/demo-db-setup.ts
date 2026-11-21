// Demo wiring only: provisions a throwaway demo Postgres with the @affidavit/db functions, in the
// same order the CLI end-to-end test uses. Run by scripts/demo.mjs through tsx. Every URL and
// password arrives in process env and is never printed.
import {
  APP_ROLE,
  OWNER_ROLE,
  WORKER_ROLE,
  applyMigrations,
  bootstrapRoles,
  provisionTenant,
  setRolePassword,
} from '../packages/db/src/index.ts';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const adminUrl = need('DEMO_ADMIN_URL');
const ownerUrl = need('DEMO_OWNER_URL');
const tenant = need('DEMO_TENANT');

try {
  await bootstrapRoles(adminUrl);
  await setRolePassword(adminUrl, OWNER_ROLE, need('DEMO_OWNER_PW'));
  await applyMigrations(ownerUrl);
  await provisionTenant(ownerUrl, tenant);
  await setRolePassword(adminUrl, APP_ROLE, need('DEMO_APP_PW'));
  await setRolePassword(adminUrl, WORKER_ROLE, need('DEMO_WORKER_PW'));
  console.log(`[setup] roles, migrations and tenant ${tenant} ready`);
} catch (err) {
  const msg = err instanceof Error ? err.message : 'unknown error';
  console.error(`[setup] failed: ${msg.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')}`);
  process.exit(1);
}
