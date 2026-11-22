import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  AdmissibilityRule,
  CaseFile,
  CaseStage,
  ExhibitResult,
  HaltReason,
  ModelRecording,
  ReleaseRejectedError,
  ScannerCoverage,
  type BudgetState,
  type CaseId,
  type CaseStore,
  type StageCost,
  MAX_APPEALS,
  STAGE_TRANSITIONS,
  TERMINAL_STAGES,
  TrialEvent,
  TrialEventType,
  isLegalTransition,
  schemaRegistry,
} from './index.js';
import { samples, trialEventSamples } from './samples.js';

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

  describe('verify-result event (v1.1, CR-1)', () => {
    const e = trialEventSamples['verify-result'] as Record<string, unknown> & {
      payload: { result: Record<string, unknown> };
    };

    it('follows every v1.0 member, so v1.0 members keep their positions', () => {
      // Last in v1.1; v1.2 appends after it without moving it.
      expect(TrialEventType.options.indexOf('verify-result')).toBe(13);
      expect(TrialEventType.options.indexOf('verdict-written')).toBe(12);
    });

    it('parses a valid sample carrying the Judge VerifyResult', () => {
      const parsed = TrialEvent.safeParse(e);
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.data.type === 'verify-result') {
        expect(parsed.data.payload.result).toEqual(samples['VerifyResult']);
      }
    });

    it('rejects a payload with no result, or a result that is not a VerifyResult', () => {
      expect(TrialEvent.safeParse({ ...e, payload: {} }).success).toBe(false);
      expect(
        TrialEvent.safeParse({ ...e, payload: { result: samples['ExhibitResult'] } }).success,
      ).toBe(false);
      const noSuite = { ...e.payload.result };
      delete noSuite['suitePassed'];
      expect(TrialEvent.safeParse({ ...e, payload: { result: noSuite } }).success).toBe(false);
      expect(
        TrialEvent.safeParse({
          ...e,
          payload: { result: { ...e.payload.result, rejectedBy: 'not-a-rule' } },
        }).success,
      ).toBe(false);
    });

    it('rejects a VerifyResult payload under another event type', () => {
      expect(TrialEvent.safeParse({ ...e, type: 'exhibit-result' }).success).toBe(false);
    });
  });

  describe('cost-released event (v1.2, CR-T1)', () => {
    const e = trialEventSamples['cost-released'] as Record<string, unknown> & {
      payload: Record<string, unknown>;
    };

    it('parses a valid sample', () => {
      expect(TrialEvent.safeParse(e).success).toBe(true);
    });

    it('rejects a missing or bad reservation seq, a bad reason, or a negative refund', () => {
      const noSeq = { ...e.payload };
      delete noSeq['reservationSeq'];
      expect(TrialEvent.safeParse({ ...e, payload: noSeq }).success).toBe(false);
      for (const bad of [
        { reservationSeq: -1 },
        { reservationSeq: 1.5 },
        { reason: 'refund' },
        { reason: undefined },
        { cost: { ...(e.payload['cost'] as object), usd: -0.01 } },
        { remaining: undefined },
      ]) {
        expect(TrialEvent.safeParse({ ...e, payload: { ...e.payload, ...bad } }).success).toBe(
          false,
        );
      }
    });

    it('rejects a cost-charged payload under cost-released', () => {
      const charged = { cost: e.payload['cost'], remaining: e.payload['remaining'] };
      expect(TrialEvent.safeParse({ ...e, payload: charged }).success).toBe(false);
    });
  });

  describe('halted event (v1.2, CR-T12)', () => {
    const e = trialEventSamples['halted'] as Record<string, unknown> & {
      payload: Record<string, unknown>;
    };

    it('parses every halt reason', () => {
      expect(HaltReason.options).toEqual([
        'kill-switch',
        'model-unconfigured',
        'model-refusal',
        'budget-exhausted',
      ]);
      for (const reason of HaltReason.options) {
        expect(TrialEvent.safeParse({ ...e, payload: { reason } }).success).toBe(true);
      }
    });

    it('is legal from every stage, because a halt moves no stage', () => {
      for (const stage of CaseStage.options) {
        expect(TrialEvent.safeParse({ ...e, stage }).success).toBe(true);
      }
      expect(CaseStage.options).not.toContain('halted');
      for (const exits of Object.values(STAGE_TRANSITIONS)) expect(exits).not.toContain('halted');
    });

    it('rejects an unknown or missing reason, and a refusal category on another reason', () => {
      expect(TrialEvent.safeParse({ ...e, payload: { reason: 'tired' } }).success).toBe(false);
      expect(TrialEvent.safeParse({ ...e, payload: {} }).success).toBe(false);
      expect(
        TrialEvent.safeParse({ ...e, payload: { reason: 'kill-switch', refusalCategory: 'cyber' } })
          .success,
      ).toBe(false);
      expect(
        TrialEvent.safeParse({
          ...e,
          payload: { reason: 'model-refusal', refusalCategory: 'weather' },
        }).success,
      ).toBe(false);
    });
  });

  it('v1.2 event types are appended after every v1.1 member, each with a sample', () => {
    expect(TrialEventType.options.slice(-3)).toEqual(['verify-result', 'cost-released', 'halted']);
    expect(TrialEventType.options.indexOf('verdict-written')).toBe(12);
    for (const type of TrialEventType.options.slice(13)) {
      expect(trialEventSamples[type], `no sample for ${type}`).toBeDefined();
      expect(TrialEvent.safeParse(trialEventSamples[type]).success).toBe(true);
    }
  });

  describe('scanner coverage on the case file (v1.2, CR-14)', () => {
    const cf = samples['CaseFile'] as Record<string, unknown>;
    const osv = samples['ScannerCoverage'] as Record<string, unknown>;
    const semgrep = { tool: 'semgrep', ran: true, ref: `sha256:${'c'.repeat(64)}` };

    it('is optional, and a case file may say which scanners did not run', () => {
      expect(CaseFile.safeParse(cf).success).toBe(true);
      expect(CaseFile.safeParse({ ...cf, scanners: [] }).success).toBe(true);
      const parsed = CaseFile.parse({ ...cf, scanners: [semgrep, osv] });
      expect(parsed.scanners?.find((s) => s.tool === 'osv')?.ran).toBe(false);
    });

    it('rejects a skipped scanner with no reason, a run scanner with one, and duplicates', () => {
      expect(ScannerCoverage.safeParse({ tool: 'osv', ran: false }).success).toBe(false);
      expect(ScannerCoverage.safeParse({ ...semgrep, reason: 'not-configured' }).success).toBe(
        false,
      );
      expect(ScannerCoverage.safeParse({ ...osv, reason: 'lazy' }).success).toBe(false);
      expect(ScannerCoverage.safeParse({ ...osv, tool: 'grep' }).success).toBe(false);
      expect(CaseFile.safeParse({ ...cf, scanners: [osv, osv] }).success).toBe(false);
      expect(CaseFile.safeParse({ ...cf, scanners: 'osv' }).success).toBe(false);
    });

    it('keeps schemaVersion 1', () => {
      expect(CaseFile.safeParse({ ...cf, schemaVersion: 2, scanners: [semgrep] }).success).toBe(
        false,
      );
    });
  });

  describe('model recordings (v1.2, CR-T11)', () => {
    const r = samples['ModelRecording'] as Record<string, unknown> & {
      result: Record<string, unknown>;
    };

    it('parses a recording without a submission, and a redacted one', () => {
      const noSubmission: Record<string, unknown> = { ...r.result, outcome: 'no-submission' };
      delete noSubmission['submission'];
      expect(ModelRecording.safeParse({ ...r, result: noSubmission }).success).toBe(true);
      expect(ModelRecording.safeParse({ ...r, redacted: true }).success).toBe(true);
    });

    it('rejects a bad prompt id, hash, version, outcome or cost', () => {
      for (const bad of [
        { promptId: 'defender' },
        { inputSha256: 'ABC' },
        { userSha256: 'f'.repeat(63) },
        { schemaVersion: 2 },
        { result: { ...r.result, outcome: 'refused' } },
        { result: { ...r.result, cost: { stage: 'defense' } } },
        { result: { outcome: 'submitted' } },
      ]) {
        expect(ModelRecording.safeParse({ ...r, ...bad }).success).toBe(false);
      }
    });
  });

  it('a verdict summary field is required and prompt versions are keyed by prompt id', () => {
    const v = samples['Verdict'] as Record<string, unknown>;
    expect(
      schemaFor('Verdict').safeParse({ ...v, promptVersions: { defender: 'v1' } }).success,
    ).toBe(false);
  });
});

describe('back-compat with stored v1.0 and v1.1 objects (v1.2)', () => {
  const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures');
  const read = (rel: string): unknown => JSON.parse(readFileSync(join(fixtures, rel), 'utf8'));

  it.each(readdirSync(join(fixtures, 'casefiles')))('casefiles/%s parses unchanged', (f) => {
    const raw = read(`casefiles/${f}`) as Record<string, unknown>;
    expect(raw['scanners']).toBeUndefined();
    expect(CaseFile.parse(raw)).toEqual(raw);
  });

  it.each(readdirSync(join(fixtures, 'trials')))('trials/%s parses unchanged', (f) => {
    const raw = read(`trials/${f}`) as unknown[];
    expect(TrialEvent.array().parse(raw)).toEqual(raw);
  });
});

describe('CaseStore.releaseCharge (v1.2, CR-T1) types', () => {
  it('is optional, so a store written against v1.1 still satisfies CaseStore', () => {
    type V11Store = Omit<CaseStore, 'releaseCharge'>;
    expectTypeOf<V11Store>().toExtend<CaseStore>();
    expectTypeOf<NonNullable<CaseStore['releaseCharge']>>().toEqualTypeOf<
      (caseId: CaseId, refund: StageCost, reservationSeq: number) => Promise<BudgetState>
    >();
  });

  it('ReleaseRejectedError names the case and reservation', () => {
    const err = new ReleaseRejectedError('case-1' as CaseId, 9, 'refund exceeds the charge');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReleaseRejectedError');
    expect(err.reservationSeq).toBe(9);
    expect(err.message).toContain('reservation 9');
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
