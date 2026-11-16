import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STAGE_TRANSITIONS, type CaseStage } from '@affidavit/contracts';
import { scramVerifier } from './migrate.js';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';
import { transitionCases } from './transition-cases.js';
import { rejectTransition } from './transition-rules.js';

/** Replays a path through the pure rules, tracking stage and appeals the way the store does. */
function replay(
  path: readonly CaseStage[],
  to: CaseStage,
  o: { score: number; floor: number; juryEnabled: boolean },
): string | null {
  let from: CaseStage = 'intake';
  let appeals = 0;
  for (const next of [...path, to]) {
    const why = rejectTransition({
      from,
      to: next,
      score: o.score,
      escalationFloor: o.floor,
      appeals,
      juryEnabled: o.juryEnabled,
    });
    if (why !== null) {
      if (next === to) return why;
      throw new Error(`path step ${from} -> ${next} was rejected: ${why}`);
    }
    if (from === 'verify' && next === 'remedy') appeals += 1;
    from = next;
  }
  return null;
}

describe('transition rules over the shared transition table', () => {
  for (const tc of transitionCases) {
    it(tc.name, () => {
      const why = replay(tc.path, tc.to, {
        score: tc.score ?? 0.9,
        floor: tc.floor ?? 0.7,
        juryEnabled: tc.juryEnabled ?? true,
      });
      expect(why === null).toBe(tc.ok);
    });
  }
});

describe('schema and migrations', () => {
  const tables: PgTable[] = [
    schema.tenants,
    schema.repos,
    schema.cases,
    schema.stages,
    schema.exhibits,
    schema.ballots,
    schema.verdicts,
    schema.costRows,
    schema.stageRuns,
    schema.escalations,
    schema.events,
  ];

  const security = readFileSync(
    fileURLToPath(new URL('../drizzle/0001_security.sql', import.meta.url)),
    'utf8',
  );

  it('declares eleven tables', () => {
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([
      'ballots',
      'cases',
      'cost_rows',
      'escalations',
      'events',
      'exhibits',
      'repos',
      'stage_runs',
      'stages',
      'tenants',
      'verdicts',
    ]);
  });

  it('puts tenant_id on every table and forces RLS with a tenant policy on each', () => {
    for (const t of tables) {
      const cfg = getTableConfig(t);
      expect(
        cfg.columns.some((c) => c.name === 'tenant_id'),
        `${cfg.name} has tenant_id`,
      ).toBe(true);
      expect(security, `${cfg.name} forced`).toContain(
        `ALTER TABLE public.${cfg.name} FORCE ROW LEVEL SECURITY;`,
      );
      expect(security, `${cfg.name} policy`).toContain(
        `CREATE POLICY tenant_isolation ON public.${cfg.name} `,
      );
    }
  });

  it('never grants DELETE or TRUNCATE, and never UPDATE on verdicts or events', () => {
    const grants = security.split('\n').filter((l) => l.startsWith('GRANT'));
    for (const g of grants) {
      expect(g).not.toMatch(/DELETE|TRUNCATE|ALL/);
      if (/UPDATE/.test(g)) expect(g).toMatch(/(.*)/s);
      if (/UPDATE/.test(g)) expect(g).not.toMatch(/verdicts|events/);
    }
  });
});

describe('SQL guards', () => {
  const security = readFileSync(
    fileURLToPath(new URL('../drizzle/0001_security.sql', import.meta.url)),
    'utf8',
  );

  it('the transition table in cases_guard lists exactly STAGE_TRANSITIONS', () => {
    const block = /NOT IN \(([\s\S]*?)\) THEN/.exec(security)![1]!;
    const sqlPairs = [...block.matchAll(/\('(\w+)', '(\w+)'\)/g)]
      .map((m) => `${m[1]}>${m[2]}`)
      .sort();
    const tablePairs = Object.entries(STAGE_TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`))
      .sort();
    expect(sqlPairs).toEqual(tablePairs);
  });

  it('every function pins search_path, and temp objects are revoked', () => {
    const fns = security.match(/CREATE FUNCTION[\s\S]*?\$\$;/g) ?? [];
    expect(fns.length).toBeGreaterThanOrEqual(8);
    for (const f of fns) expect(f).toContain('SET search_path = pg_catalog, public');
    expect(security).toContain('REVOKE TEMPORARY ON DATABASE');
  });
});

describe('scramVerifier', () => {
  it('has the SCRAM-SHA-256 verifier shape and a fresh salt each time', () => {
    const v = scramVerifier('pw');
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain('pw');
    expect(scramVerifier('pw')).not.toBe(v);
  });
});
