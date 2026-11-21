/**
 * Opens cases for the real wiring: runs the same discovery pipeline the real intake stages run
 * (same settings, same tool runner) on a repository named in AFFIDAVIT_REPO_SOURCES. A trial
 * candidate is opened with the AFFIDAVIT_CASE_MAX_* budget and intake is enqueued; every F3 hold
 * of the scan is opened as its own case and flagged for a person (review flag `f3-hold`, never
 * queued, never dismissed; see real/open.ts). Wiring only. Prints the case ids, or why no trial
 * case was opened; never a source URL.
 *
 *   pnpm --filter @affidavit/worker open-case -- --tenant <id> --repo <id> --commit <40 hex>
 *     [--candidate <candidate id>] [--case-id <id>]
 *
 * Needs AFFIDAVIT_INTAKE_IMPL=real and its settings (docs/lanes/lane1/real-wiring.md).
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CaseId, RepoId, TenantId } from '@affidavit/contracts';
import { openHeldCase, openPool, startCase } from '@affidavit/db';
import { loadConfig, startupWarnings } from './config.js';
import { sealSecrets } from './real/child-env.js';
import { buildDiscover } from './real/components.js';
import { openCaseFromDiscovery } from './real/open.js';
import { checkPrerequisites } from './real/prereqs.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      repo: { type: 'string' },
      commit: { type: 'string' },
      candidate: { type: 'string' },
      'case-id': { type: 'string' },
    },
  });
  const { tenant, repo, commit } = values;
  if (!tenant || !repo || !commit) {
    console.error('usage: open-case --tenant <id> --repo <id> --commit <sha> [--candidate <id>]');
    return 2;
  }
  const config = loadConfig();
  const s = config.intakeSettings;
  if (config.intake !== 'real' || s === null) {
    console.error('open-case needs AFFIDAVIT_INTAKE_IMPL=real and its settings');
    return 2;
  }
  const source = Object.prototype.hasOwnProperty.call(s.sources, repo)
    ? s.sources[repo]
    : undefined;
  if (source === undefined) {
    console.error(`AFFIDAVIT_REPO_SOURCES has no source for repository ${repo}`);
    return 2;
  }
  // From here on no child process can inherit a credential: the wiring reads the snapshot.
  const env = sealSecrets();
  for (const w of startupWarnings(config)) console.error(`[open-case] warning: ${w}`);
  // Intake prerequisites only; the trial and Judge are the worker's.
  await checkPrerequisites({ ...config, trialSettings: null, judgeSettings: null });
  const discover = buildDiscover(s, env);
  const pool = await openPool(config.appDatabaseUrl, 'affidavit_app');
  let result;
  try {
    result = await openCaseFromDiscovery(
      {
        discover,
        startCase: (cf) => startCase(pool, cf, config.caseBudget),
        openHeldCase: (cf, detail) => openHeldCase(pool, cf, config.caseBudget, detail),
      },
      {
        caseId: CaseId.parse(values['case-id'] ?? `case-${randomUUID()}`),
        tenantId: TenantId.parse(tenant),
        repo: RepoId.parse(repo),
        source,
        commit,
        ...(values.candidate ? { candidateId: values.candidate } : {}),
      },
    );
  } finally {
    await pool.end();
  }
  for (const h of result.held) {
    console.error(
      `F3 hold recorded for a person: case ${h.caseId}, candidate ${h.candidate}, route ${h.route}`,
    );
  }
  if (result.why !== null) console.error(`no trial case opened (${result.why})`);
  console.log(JSON.stringify({ opened: result.opened, held: result.held }));
  // Success when something was recorded: a trial case, or at least one hold for a person.
  return result.opened !== null || result.held.length > 0 ? 0 : 1;
}
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('[open-case] fatal:', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  },
);
