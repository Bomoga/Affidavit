import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

// Static checks on the v1.2 (CR-T1) release ledger. The Postgres suite (cost-releases.pg.test.ts)
// checks the same properties against a live database.
const security = readFileSync(
  fileURLToPath(new URL('../drizzle/0009_cost_releases_security.sql', import.meta.url)),
  'utf8',
);

describe('cost_releases migration', () => {
  it('is a tenant table keyed by (tenant, case, reservation seq), referencing its charge event', () => {
    const cfg = getTableConfig(schema.costReleases);
    expect(cfg.name).toBe('cost_releases');
    expect(cfg.columns.some((c) => c.name === 'tenant_id')).toBe(true);
    expect(cfg.primaryKeys[0]!.columns.map((c) => c.name)).toEqual([
      'tenant_id',
      'case_id',
      'reservation_seq',
    ]);
    const fks = cfg.foreignKeys.map((f) => f.reference().columns.map((c) => c.name));
    expect(fks).toContainEqual(['tenant_id', 'case_id']);
    expect(fks).toContainEqual(['tenant_id', 'case_id', 'reservation_seq']);
  });

  it('forces RLS, has a tenant policy, and grants the app role SELECT and INSERT only', () => {
    expect(security).toContain('ALTER TABLE public.cost_releases FORCE ROW LEVEL SECURITY;');
    expect(security).toContain('CREATE POLICY tenant_isolation ON public.cost_releases ');
    const grants = security
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.replace(/^(?:--[^\n]*\n|\s)+/, ''))
      .filter((s) => /^GRANT\b/.test(s));
    expect(grants).toContain('GRANT SELECT, INSERT ON public.cost_releases TO affidavit_app');
    for (const g of grants) expect(g, g).not.toMatch(/UPDATE|DELETE|TRUNCATE|\bALL\b/);
  });

  it('is append-only and guards inserts', () => {
    expect(security).toMatch(
      /CREATE TRIGGER cost_releases_append_only BEFORE UPDATE OR DELETE ON public\.cost_releases/,
    );
    expect(security).toMatch(/CREATE TRIGGER cost_releases_no_truncate BEFORE TRUNCATE/);
    expect(security).toMatch(/CREATE TRIGGER cost_releases_insert_guard BEFORE INSERT/);
    // The guard locks the case row so the case-wide check is serialised.
    expect(security).toMatch(/FROM public\.cases c[\s\S]*?FOR UPDATE;/);
  });

  it('never changes cost_rows or credits the gross budget columns on cases', () => {
    expect(security).not.toMatch(/UPDATE public\.(cost_rows|cases)\b/i);
    expect(security).not.toMatch(/DELETE FROM/i);
    // No existing guard (cases_guard among them) is replaced or dropped.
    expect(security).not.toMatch(/CREATE OR REPLACE|DROP /i);
  });

  it('reads views as the invoker, so the caller row-level security applies', () => {
    for (const v of ['case_budgets', 'case_cost_ledger']) {
      expect(security).toContain(`CREATE VIEW public.${v} WITH (security_invoker = true)`);
    }
  });
});
