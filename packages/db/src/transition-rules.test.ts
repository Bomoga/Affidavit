import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_APPEALS, STAGE_TRANSITIONS, type CaseStage } from '@affidavit/contracts';
import { scramVerifier } from './migrate.js';
import { decideResume } from './stage-runs.js';
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
    schema.stageJobs,
    schema.escalations,
    schema.events,
  ];

  const security = readFileSync(
    fileURLToPath(new URL('../drizzle/0001_security.sql', import.meta.url)),
    'utf8',
  );

  it('declares twelve tables', () => {
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([
      'ballots',
      'cases',
      'cost_rows',
      'escalations',
      'events',
      'exhibits',
      'repos',
      'stage_jobs',
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
    // Statements end at a semicolon, so multi-line GRANTs are parsed whole.
    const grants = security
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.replace(/^(?:--[^\n]*\n|\s)+/, ''))
      .filter((s) => /^GRANT\b/.test(s));
    expect(grants.length).toBeGreaterThanOrEqual(8);
    for (const g of grants) {
      if (/\bON (?:public\.)?[a-z_]/.test(g) && !/FUNCTION|SCHEMA/.test(g)) {
        expect(g, g).not.toMatch(/DELETE|TRUNCATE|\bALL\b|REFERENCES|TRIGGER/);
      }
      if (/UPDATE/.test(g)) {
        // Only column-level UPDATE grants, and never on append-only tables.
        expect(g, g).toMatch(/UPDATE\s*\(/);
        expect(g, g).not.toMatch(
          /verdicts|events|ballots|stages\b|cost_rows|escalations|stage_jobs/,
        );
      }
    }
  });

  it('inserts into the lifecycle tables are not granted to the application role', () => {
    expect(security).not.toMatch(/GRANT[^;]*INSERT[^;]*stage_runs/);
    expect(security).not.toMatch(/GRANT[^;]*INSERT[^;]*stage_jobs/);
    expect(security).not.toMatch(/GRANT[^;]*INSERT[^;]*public\.stages\b/);
    expect(security).not.toMatch(/GRANT[^;]*UPDATE[^;]*stage_runs/);
    expect(security).not.toMatch(/GRANT[^;]*INSERT[^;]*tenants/);
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

  it('SECURITY DEFINER functions put pg_temp last in their search_path', () => {
    const fns = (security.match(/CREATE FUNCTION[\s\S]*?\$\$;/g) ?? []).filter((f) =>
      f.includes('SECURITY DEFINER'),
    );
    expect(fns.length).toBeGreaterThanOrEqual(7);
    for (const f of fns) expect(f).toContain('SET search_path = pg_catalog, public, pg_temp');
  });

  it('every function pins search_path, and temp objects are revoked', () => {
    const fns = security.match(/CREATE FUNCTION[\s\S]*?\$\$;/g) ?? [];
    expect(fns.length).toBeGreaterThanOrEqual(8);
    for (const f of fns) expect(f).toContain('SET search_path = pg_catalog, public');
    expect(security).toContain('REVOKE TEMPORARY ON DATABASE');
  });
});

describe('SQL appeal limit and shared table coverage', () => {
  const security = readFileSync(
    fileURLToPath(new URL('../drizzle/0001_security.sql', import.meta.url)),
    'utf8',
  );

  it('the SQL appeal limit is MAX_APPEALS', () => {
    const m = /OLD\.appeals >= (\d+)/.exec(security);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(MAX_APPEALS);
  });

  it('the shared table has an accepting case for every pair in STAGE_TRANSITIONS', () => {
    for (const [from, tos] of Object.entries(STAGE_TRANSITIONS)) {
      for (const to of tos) {
        const hit = transitionCases.some(
          (c) => c.ok && c.to === to && c.name.startsWith(`${from} -> ${to}`),
        );
        expect(hit, `${from} -> ${to}`).toBe(true);
      }
    }
  });
});

describe('decideResume', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const future = new Date(now.getTime() + 60_000);
  const past = new Date(now.getTime() - 60_000);
  const run = (state: 'running' | 'completed' | 'failed', leaseExpiresAt: Date) => ({
    state,
    leaseExpiresAt,
  });
  type Job = Parameters<typeof decideResume>[0]['job'];
  const d = (
    r: ReturnType<typeof run> | null,
    caseStage: string,
    over: { job?: Job; caseVisit?: number } = {},
  ) =>
    decideResume({
      run: r,
      job: over.job ?? 'none',
      caseStage,
      caseVisit: over.caseVisit ?? 4,
      jobStage: 'defense',
      jobVisit: 4,
      now,
    });

  it('starts an unclaimed attempt only while the case is still at the visit and no job is in flight', () => {
    expect(d(null, 'defense')).toBe('start');
    expect(d(null, 'defense', { job: 'queued' })).toBe('wait');
    expect(d(null, 'defense', { job: 'running' })).toBe('wait');
    expect(d(null, 'prosecution')).toBe('adopt-complete');
    // A queue job that can still run is never adopted from under it: claim refuses it and it fails.
    expect(d(null, 'prosecution', { job: 'queued' })).toBe('wait');
    expect(d(null, 'prosecution', { job: 'running' })).toBe('wait');
  });
  it('an unclaimed attempt whose job failed or went stale before claiming means the next attempt', () => {
    expect(d(null, 'defense', { job: 'failed' })).toBe('next-attempt');
    expect(d(null, 'defense', { job: 'stale' })).toBe('next-attempt');
  });
  it('waits for a live lease, and moves on once it has expired', () => {
    expect(d(run('running', future), 'defense')).toBe('wait');
    expect(d(run('running', past), 'defense')).toBe('next-attempt');
  });
  it('a live lease means wait even if the case has already moved on', () => {
    expect(d(run('running', future), 'prosecution')).toBe('wait');
  });
  it('a failed attempt at the same visit means the next attempt', () => {
    expect(d(run('failed', future), 'defense')).toBe('next-attempt');
  });
  it('an attempt whose case left the stage counts as complete once the lease is gone', () => {
    expect(d(run('running', past), 'prosecution')).toBe('adopt-complete');
    expect(d(run('failed', past), 'prosecution')).toBe('done');
  });
  it('a return to the same stage is a new visit, so the old attempt is adopted, not re-run', () => {
    // verify (visit 4), remedy (5), verify again (6): the old verify attempt is for visit 4.
    expect(d(run('running', past), 'defense', { caseVisit: 6 })).toBe('adopt-complete');
    expect(d(run('running', future), 'defense', { caseVisit: 6 })).toBe('wait');
  });
  it('a completed attempt is done', () => {
    expect(d(run('completed', past), 'defense')).toBe('done');
    expect(d(run('completed', past), 'prosecution')).toBe('done');
  });
});

describe('scramVerifier', () => {
  it('has the SCRAM-SHA-256 verifier shape and a fresh salt each time', () => {
    const v = scramVerifier('correct-horse-battery-staple');
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain('correct-horse');
    expect(scramVerifier('correct-horse-battery-staple')).not.toBe(v);
  });
});
