import { TrialEvent, type VerifyResult } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { withProsecution } from '../testing/prosecution.js';
import { withVerify, withoutVerify } from '../testing/verify.js';
import { buildCaseView } from './caseView.js';

const GATE = TrialEvent.array().parse(readFixtureJson('trials/nodegoat-sqli-001.events.json'));
const PATCH_ID = 'exhibit-patch-001';
const CX = 'exhibit-counterexample-001';
const EM_DASH = '—';
type Id = VerifyResult['patchExhibitId'];

function verifyResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    schemaVersion: 1,
    patchExhibitId: PATCH_ID as Id,
    familyFlipped: true,
    suitePassed: true,
    rescanClean: true,
    counterexamples: [],
    ...overrides,
  };
}

const cx = (id: string, survived: boolean) => ({ exhibitId: id as Id, survived });

describe('prosecution on the docket', () => {
  const WITH_CX = withProsecution(GATE, { counterexampleId: CX });

  it('labels counterexamples and objections in plain language and cites the exhibit', () => {
    const view = buildCaseView(WITH_CX);
    const entries = view.docket.filter((d) => d.entry);
    expect(entries.map((d) => [d.entry, d.label])).toEqual([
      ['counterexample', `Counterexample ${CX} filed by prosecution`],
      ['counterexample', `The Judge admitted ${CX}`],
      ['objection', `The Prosecution objected, citing ${CX}`],
    ]);
    expect(entries.every((d) => d.exhibitId === CX)).toBe(true);
    expect(entries[2]?.detail).toContain('counterexample family');
    expect(view.exhibits.find((x) => x.id === CX)).toMatchObject({
      kind: 'counterexample',
      admitted: true,
    });
  });

  it('keeps one docket entry per event', () => {
    expect(buildCaseView(WITH_CX).docket.map((d) => d.seq)).toEqual(WITH_CX.map((e) => e.seq));
  });

  it('gives an appeal its own entry kind and invents no text for it', () => {
    const appeal = {
      ...WITH_CX[0],
      seq: WITH_CX.length,
      type: 'appeal',
      actor: 'remedy',
      payload: { round: 1, counterexampleId: CX },
    } as unknown as TrialEvent;
    const entry = buildCaseView([...WITH_CX, appeal]).docket.at(-1);
    expect(entry).toMatchObject({ entry: 'appeal', label: 'Appeal round 1', exhibitId: CX });
    expect(entry?.detail).toBeUndefined();
  });

  it('writes no em dashes', () => {
    expect(JSON.stringify(buildCaseView(WITH_CX))).not.toContain(EM_DASH);
  });
});

describe('patch acceptance matches trial', () => {
  const WITH_CX = withProsecution(GATE, { counterexampleId: CX });
  const stamp = (events: readonly TrialEvent[], r: VerifyResult) =>
    buildCaseView(withVerify(events, [r])).stamp;

  it('accepts when every admitted counterexample has exactly one result and none survived', () => {
    expect(stamp(WITH_CX, verifyResult({ counterexamples: [cx(CX, false)] }))).toBe('VERIFIED');
  });

  it.each([
    ['no result for the counterexample', []],
    ['a duplicate result', [cx(CX, false), cx(CX, false)]],
    ['a surviving counterexample', [cx(CX, true)]],
    ['a result for an exhibit that was never admitted', [cx('exhibit-invented', false)]],
    ['an extra result beside the real one', [cx(CX, false), cx('exhibit-invented', false)]],
  ])('withholds the stamp for %s', (_name, counterexamples) => {
    expect(stamp(WITH_CX, verifyResult({ counterexamples }))).toBeNull();
  });

  it('does not require a result for a counterexample the Judge did not admit', () => {
    const rejected = withProsecution(GATE, { counterexampleId: CX, admissible: false });
    expect(stamp(rejected, verifyResult())).toBe('VERIFIED');
    expect(stamp(rejected, verifyResult({ counterexamples: [cx(CX, false)] }))).toBeNull();
  });

  it('still withholds the stamp when a counterexample exists and no result is supplied', () => {
    expect(buildCaseView(withoutVerify(WITH_CX)).stamp).toBeNull();
    // The recorded check predates the counterexample, so it does not cover it.
    expect(buildCaseView(WITH_CX).stamp).toBeNull();
  });

  it('keeps the gate fixture UNVERIFIED without a verify-result event (CR-1)', () => {
    const view = buildCaseView(withoutVerify(GATE));
    expect(view.status).toBe('unverified');
    expect(view.stamp).toBeNull();
  });

  it('stamps the gate fixture VERIFIED from its recorded Judge verify-result (CR-1)', () => {
    expect(buildCaseView(GATE).stamp).toBe('VERIFIED');
  });
});
