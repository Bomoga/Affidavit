/**
 * Opens one case for the real wiring: runs the same discovery pipeline the real intake stages run
 * (same settings, same tool runner) on a repository named in AFFIDAVIT_REPO_SOURCES, and if it
 * produces a case file, opens the case with the AFFIDAVIT_CASE_MAX_* budget and enqueues intake.
 * Wiring only. Prints the case id, or why no case was opened; never a source URL.
 *
 *   pnpm --filter @affidavit/worker open-case -- --tenant <id> --repo <id> --commit <40 hex>
 *     [--candidate <candidate id>] [--case-id <id>]
 *
 * Needs AFFIDAVIT_INTAKE_IMPL=real and its settings (docs/lanes/lane1/real-wiring.md).
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CaseId, RepoId, TenantId } from '@affidavit/contracts';
import { openPool, startCase } from '@affidavit/db';
import { loadConfig } from './config.js';
import { buildDiscover } from './real/components.js';
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
  // Intake prerequisites only; the trial and Judge are the worker's.
  await checkPrerequisites({ ...config, trialSettings: null, judgeSettings: null });
  const discover = buildDiscover(s, process.env);
  const outcome = await discover({
    caseId: CaseId.parse(values['case-id'] ?? `case-${randomUUID()}`),
    tenantId: TenantId.parse(tenant),
    repo: RepoId.parse(repo),
    source,
    commit,
    ...(values.candidate ? { candidateId: values.candidate } : {}),
  });
  if (outcome.kind !== 'case-file') {
    // Fixed fields only: the outcome kind and discovery's own reason codes.
    const why =
      outcome.kind === 'unsupported'
        ? `${outcome.reason}: ${outcome.detail}`
        : outcome.kind === 'incomplete'
          ? `${outcome.reason}, ${outcome.coverageLosses} coverage loss(es)`
          : outcome.kind === 'review'
            ? `candidate ${outcome.candidateId} is held for review (F3), not dismissed`
            : outcome.kind === 'dismissed'
              ? 'the candidate was dismissed by arraignment with a recorded reason'
              : 'no candidate to try';
    console.error(`no case opened (${outcome.kind}): ${why}`);
    return 1;
  }
  const pool = await openPool(config.appDatabaseUrl, 'affidavit_app');
  try {
    await startCase(pool, outcome.caseFile, config.caseBudget);
  } finally {
    await pool.end();
  }
  console.log(
    JSON.stringify({
      caseId: outcome.caseFile.id,
      candidate: outcome.caseFile.candidate.id,
      scanPartial: outcome.scanPartial,
      withheld: outcome.withheld.length,
    }),
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('[open-case] fatal:', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  },
);
