import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AdmissibilityRule,
  CaseStage,
  ExhibitResult,
  MAX_APPEALS,
  STAGE_TRANSITIONS,
  TERMINAL_STAGES,
  TrialEvent,
  isLegalTransition,
  schemaRegistry,
} from './index.js';
import { samples } from './samples.js';

const names = Object.keys(schemaRegistry);

function schemaFor(name: string): z.ZodType {
  const s = schemaRegistry[name];
  if (!s) throw new Error(`no schema ${name}`);
  return s;
}

describe('schema registry', () => {
  it('has a sample for every schema and no stray samples', () => {
    expect(Object.keys(samples).sort()).toEqual([...names].sort());
  });

  it.each(names)('%s parses its valid sample', (name) => {
    expect(schemaFor(name).safeParse(samples[name]).success).toBe(true);
  });

  it.each(names)('%s exports to JSON Schema', (name) => {
    const json = z.toJSONSchema(schemaFor(name), { target: 'draft-2020-12' });
    expect(json).toBeTypeOf('object');
  });

  // For every required top-level field, removing it must be rejected.
  const cases = names.flatMap((name) => {
    const json = z.toJSONSchema(schemaFor(name), { target: 'draft-2020-12' }) as {
      required?: string[];
    };
    return (json.required ?? []).map((field) => [name, field] as const);
  });

  it.each(cases)('%s rejects a sample missing required field %s', (name, field) => {
    const sample = { ...(samples[name] as Record<string, unknown>) };
    delete sample[field];
    expect(schemaFor(name).safeParse(sample).success).toBe(false);
  });
});

describe('invariants encoded in the schemas', () => {
  const base = samples['ExhibitResult'] as Record<string, unknown>;

  it('an inadmissible result must name its rejecting rule', () => {
    expect(ExhibitResult.safeParse({ ...base, admissible: false }).success).toBe(false);
    expect(
      ExhibitResult.safeParse({ ...base, admissible: false, rejectedBy: 'differential' }).success,
    ).toBe(true);
  });

  it('an admissible result cannot carry a rejecting rule', () => {
    expect(ExhibitResult.safeParse({ ...base, rejectedBy: 'schema' }).success).toBe(false);
  });

  it('a ballot must cite at least one exhibit and cannot ask a mechanical question', () => {
    const ballot = schemaFor('Ballot');
    const sample = samples['Ballot'] as Record<string, unknown>;
    expect(ballot.safeParse({ ...sample, citedExhibits: [] }).success).toBe(false);
    expect(ballot.safeParse({ ...sample, question: 'did-test-pass', vote: 'yes' }).success).toBe(
      false,
    );
    expect(ballot.safeParse({ ...sample, vote: 'minimal' }).success).toBe(false);
  });

  it('a case file refuses an uppercase or short commit', () => {
    const caseFile = samples['CaseFile'] as { target: Record<string, unknown> };
    const bad = { ...caseFile, target: { ...caseFile.target, commit: 'ABC' } };
    expect(schemaFor('CaseFile').safeParse(bad).success).toBe(false);
  });

  it('boot hints accept only synthetic env values', () => {
    const hints = samples['BootHints'] as Record<string, unknown>;
    expect(
      schemaFor('BootHints').safeParse({ ...hints, env: { SECRET: 'real-value' } }).success,
    ).toBe(false);
  });

  it('a trial event rejects a payload that does not match its type', () => {
    const e = samples['TrialEvent'] as Record<string, unknown>;
    expect(TrialEvent.safeParse({ ...e, type: 'stage-exited', payload: {} }).success).toBe(false);
    expect(TrialEvent.safeParse({ ...e, type: 'not-a-type' }).success).toBe(false);
  });

  it('a verdict summary field is required and prompt versions are keyed by prompt id', () => {
    const v = samples['Verdict'] as Record<string, unknown>;
    expect(
      schemaFor('Verdict').safeParse({ ...v, promptVersions: { defender: 'v1' } }).success,
    ).toBe(false);
  });
});

describe('stage transitions', () => {
  it('covers every stage and only names real stages', () => {
    for (const stage of CaseStage.options) {
      expect(STAGE_TRANSITIONS[stage]).toBeDefined();
      for (const to of STAGE_TRANSITIONS[stage]) expect(CaseStage.options).toContain(to);
    }
  });

  it('terminal stages have no exits', () => {
    for (const stage of TERMINAL_STAGES) expect(STAGE_TRANSITIONS[stage]).toEqual([]);
  });

  it('allows the happy path and rejects skipping or going backwards', () => {
    expect(isLegalTransition('intake', 'map')).toBe(true);
    expect(isLegalTransition('verify', 'remedy')).toBe(true);
    expect(isLegalTransition('intake', 'defense')).toBe(false);
    expect(isLegalTransition('verdict', 'intake')).toBe(false);
    expect(MAX_APPEALS).toBe(2);
  });

  it('admissibility rules match the implementation plan', () => {
    expect(AdmissibilityRule.options).toHaveLength(10);
  });
});
