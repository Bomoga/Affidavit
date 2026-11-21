import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Budget as BudgetSchema,
  CaseFile as CaseFileSchema,
  TrialEvent as TrialEventSchema,
  type Budget,
  type CaseFile,
  type TrialEvent,
} from '@affidavit/contracts';

const FIXTURES = new URL('../../../fixtures/', import.meta.url);

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, FIXTURES), 'utf8')) as unknown;
}

/** Fixed default budget for API-started cases, the same as the CLI's. Limits, not measurements. */
export const DEFAULT_BUDGET: Budget = BudgetSchema.parse({
  maxInputTokens: 1_000_000,
  maxOutputTokens: 200_000,
  maxUsd: 5,
});

export function newCaseId(): string {
  return `case-api-${randomBytes(6).toString('hex')}`;
}

/**
 * FAKE INTAKE, as in the CLI (v0): the case file is the recorded nodegoat-sqli-001 fixture with
 * a fresh case id, the caller's tenant and `target.repo` set from the request. The requested
 * commit is validated but not used until real intake (L1-01) exists.
 */
export function buildFakeCaseFile(repo: string, tenantId: string, caseId = newCaseId()): CaseFile {
  const base = CaseFileSchema.parse(readJson('casefiles/nodegoat-sqli-001.json'));
  return CaseFileSchema.parse({
    ...base,
    id: caseId,
    tenantId,
    target: { ...base.target, repo },
  });
}

/** Deep-replaces one case id string with another, so a fixture can be re-keyed. */
function rekey(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((v) => rekey(v, from, to));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rekey(v, from, to)]),
    );
  }
  return value;
}

export type TrialFixture = 'nodegoat-sqli-001' | 'escalated-001';

/** A recorded trial stream from fixtures/trials, re-keyed to `caseId` and validated. */
export function fixtureEvents(name: TrialFixture, caseId: string): TrialEvent[] {
  const raw = readJson(`trials/${name}.events.json`);
  if (!Array.isArray(raw)) throw new Error(`fixture ${name} is not an array`);
  return raw.map((e) => {
    const from = (e as { caseId?: unknown }).caseId;
    return TrialEventSchema.parse(typeof from === 'string' ? rekey(e, from, caseId) : e);
  });
}
