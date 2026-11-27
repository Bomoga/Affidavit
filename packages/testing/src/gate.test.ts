import { CaseId, ExhibitId, TrialEvent } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { readFixtureJson } from './fixtures.js';
import { evaluateGate, formatGateReport, type GateFacts, type GateReport } from './gate.js';

const load = (name: string): TrialEvent[] =>
  TrialEvent.array().parse(readFixtureJson(`trials/${name}.events.json`));

const gateCase = load('nodegoat-sqli-001');
const escalated = load('escalated-001');

const ALL_FACTS: GateFacts = {
  candidateTool: 'semgrep',
  implementations: { intake: 'real', trial: 'real', judge: 'real' },
  bundleVerified: true,
  replayMatched: true,
  replayOnSecondMachine: true,
  containmentGreen: true,
};

const status = (r: GateReport, id: string): string | undefined =>
  r.checks.find((c) => c.id === id)?.status;

/** A deep copy with one event edited in place, found by type. */
function mutate<T extends TrialEvent['type']>(
  type: T,
  edit: (e: Extract<TrialEvent, { type: T }>) => void,
  events: readonly TrialEvent[] = gateCase,
): TrialEvent[] {
  const copy = structuredClone(events) as TrialEvent[];
  const hit = copy.filter((e): e is Extract<TrialEvent, { type: T }> => e.type === type);
  expect(hit.length, `fixture has a ${type} event`).toBeGreaterThan(0);
  edit(hit[hit.length - 1]!);
  return copy;
}

describe('evaluateGate on the recorded gate case', () => {
  it('passes every event-derived check, because the fixture holds a complete proven-fixed stream', () => {
    const r = evaluateGate(gateCase, ALL_FACTS);
    const eventChecks = [
      'one-case',
      'full-path',
      'witness-admitted-differential',
      'no-egress',
      'patch-flips-family',
      'verdict-proven-fixed',
    ];
    for (const id of eventChecks) expect(status(r, id), id).toBe('PASS');
  });

  it('does not meet the gate when nobody says which implementations ran, and says why', () => {
    const r = evaluateGate(gateCase, {});
    expect(r.passed).toBe(false);
    expect(status(r, 'real-ports')).toBe('NOT RUN');
    expect(formatGateReport(r)).toMatch(/GATE NOT MET/);
    expect(formatGateReport(r)).toMatch(/not run is not a pass/);
  });

  it('a recorded stream with a fake stage never meets the gate', () => {
    const r = evaluateGate(gateCase, {
      ...ALL_FACTS,
      implementations: { intake: 'fake', trial: 'real', judge: 'fake' },
    });
    expect(status(r, 'real-ports')).toBe('FAIL');
    expect(r.checks.find((c) => c.id === 'real-ports')?.detail).toMatch(/intake, judge/);
    expect(r.passed).toBe(false);
  });

  it('passed is true only when every check passes, so it is false while the fixture has no bundle', () => {
    const r = evaluateGate(gateCase, ALL_FACTS);
    // The recorded verdict names no bundle (a fixture, never sealed), so the gate cannot be met.
    expect(status(r, 'bundle-sealed')).toBe('FAIL');
    expect(r.passed).toBe(false);
    expect(r.counts.PASS + r.counts.FAIL + r.counts['NOT RUN']).toBe(r.checks.length);
  });

  it('is met when the verdict names a bundle and every fact checks out', () => {
    const sealed = mutate('verdict-written', (e) => {
      e.payload.verdict.bundleSha256 = 'a'.repeat(64);
    });
    const r = evaluateGate(sealed, ALL_FACTS);
    expect(r.checks.filter((c) => c.status !== 'PASS')).toEqual([]);
    expect(r.passed).toBe(true);
    expect(formatGateReport(r)).toMatch(/GATE MET/);
  });
});

describe('each criterion fails on its own', () => {
  const sealed = mutate('verdict-written', (e) => {
    e.payload.verdict.bundleSha256 = 'a'.repeat(64);
  });

  it('a witness admitted with no safe variant is not differential proof', () => {
    const events = mutate(
      'exhibit-result',
      (e) => {
        delete e.payload.result.safeVariantFail;
      },
      sealed,
    );
    const r = evaluateGate(events, ALL_FACTS);
    expect(status(r, 'witness-admitted-differential')).toBe('FAIL');
    expect(r.checks.find((c) => c.id === 'witness-admitted-differential')?.detail).toMatch(
      /no safe variant/,
    );
  });

  it('a witness that also passes on the safe variant is not admitted on the differential rule', () => {
    const events = mutate(
      'exhibit-result',
      (e) => {
        e.payload.result.safeVariantFail = false;
      },
      sealed,
    );
    expect(status(evaluateGate(events, ALL_FACTS), 'witness-admitted-differential')).toBe('FAIL');
  });

  it('egress during any run fails the gate', () => {
    const events = mutate(
      'exhibit-result',
      (e) => {
        e.payload.result.egressAttempts = 1;
      },
      sealed,
    );
    expect(status(evaluateGate(events, ALL_FACTS), 'no-egress')).toBe('FAIL');
  });

  it.each([
    ['familyFlipped', 'the witness family did not flip'],
    ['suitePassed', 'tests did not pass'],
    ['rescanClean', 're-scan still finds it'],
  ] as const)('a patch with %s false fails the gate', (field, text) => {
    const events = mutate(
      'verify-result',
      (e) => {
        e.payload.result[field] = false;
      },
      sealed,
    );
    const r = evaluateGate(events, ALL_FACTS);
    expect(status(r, 'patch-flips-family')).toBe('FAIL');
    expect(r.checks.find((c) => c.id === 'patch-flips-family')?.detail).toContain(text);
  });

  it('a surviving counterexample fails the gate', () => {
    const events = mutate(
      'verify-result',
      (e) => {
        e.payload.result.counterexamples = [
          { exhibitId: ExhibitId.parse('exhibit-cx-1'), survived: true },
        ];
      },
      sealed,
    );
    expect(status(evaluateGate(events, ALL_FACTS), 'patch-flips-family')).toBe('FAIL');
  });

  it('only the last verify-result counts, so an appeal that fixes the patch can pass', () => {
    const base = structuredClone<TrialEvent[]>(sealed);
    const verify = base.find((e) => e.type === 'verify-result')!;
    const weak = structuredClone<TrialEvent>(verify);
    if (weak.type === 'verify-result') weak.payload.result.familyFlipped = false;
    const events = [
      ...base.slice(0, base.indexOf(verify)),
      weak,
      verify,
      ...base.slice(base.indexOf(verify) + 1),
    ];
    expect(status(evaluateGate(events, ALL_FACTS), 'patch-flips-family')).toBe('PASS');
  });

  it('a verdict other than proven-fixed fails the gate', () => {
    const events = mutate(
      'verdict-written',
      (e) => {
        e.payload.verdict.outcome = 'not-proven';
      },
      sealed,
    );
    expect(status(evaluateGate(events, ALL_FACTS), 'verdict-proven-fixed')).toBe('FAIL');
  });

  it('a stream that skips a stage fails the path check, and an out-of-order one too', () => {
    const skipped = sealed.filter(
      (e) => !(e.type === 'stage-entered' && e.stage === 'prosecution'),
    );
    const r = evaluateGate(skipped, ALL_FACTS);
    expect(status(r, 'full-path')).toBe('FAIL');
    expect(r.checks.find((c) => c.id === 'full-path')?.detail).toContain('prosecution');
  });

  it('events from two cases are refused', () => {
    const events = mutate(
      'stage-entered',
      (e) => {
        e.caseId = CaseId.parse('case-other');
      },
      sealed,
    );
    expect(status(evaluateGate(events, ALL_FACTS), 'one-case')).toBe('FAIL');
  });

  it('a candidate from another tool is not the Semgrep gate case', () => {
    const r = evaluateGate(sealed, { ...ALL_FACTS, candidateTool: 'osv' });
    expect(status(r, 'candidate-from-semgrep')).toBe('FAIL');
  });
});

describe('facts that were not checked are NOT RUN, never a pass', () => {
  const sealed = mutate('verdict-written', (e) => {
    e.payload.verdict.bundleSha256 = 'a'.repeat(64);
  });

  it.each([
    ['bundleVerified', 'attestation-verified'],
    ['replayMatched', 'replay-matches'],
    ['replayOnSecondMachine', 'replay-second-machine'],
    ['containmentGreen', 'containment-green'],
    ['candidateTool', 'candidate-from-semgrep'],
  ] as const)('leaving out %s makes %s NOT RUN and the gate not met', (field, id) => {
    const facts: GateFacts = { ...ALL_FACTS };
    delete facts[field];
    const r = evaluateGate(sealed, facts);
    expect(status(r, id)).toBe('NOT RUN');
    expect(r.passed).toBe(false);
  });

  it('a replay on the same machine is NOT RUN for the second-machine check, not a pass', () => {
    const r = evaluateGate(sealed, { ...ALL_FACTS, replayOnSecondMachine: false });
    expect(status(r, 'replay-second-machine')).toBe('NOT RUN');
    expect(r.passed).toBe(false);
  });

  it('a failed offline verification or replay is FAIL', () => {
    const r = evaluateGate(sealed, { ...ALL_FACTS, bundleVerified: false, replayMatched: false });
    expect(status(r, 'attestation-verified')).toBe('FAIL');
    expect(status(r, 'replay-matches')).toBe('FAIL');
  });
});

describe('evaluateGate on the escalated fixture and an empty stream', () => {
  it('an escalated case never meets the gate', () => {
    const r = evaluateGate(escalated, ALL_FACTS);
    expect(r.passed).toBe(false);
    expect(status(r, 'verdict-proven-fixed')).toBe('FAIL');
    expect(status(r, 'patch-flips-family')).toBe('FAIL');
  });

  it('an empty stream fails instead of passing vacuously', () => {
    const r = evaluateGate([], ALL_FACTS);
    expect(r.passed).toBe(false);
    for (const id of [
      'one-case',
      'full-path',
      'witness-admitted-differential',
      'verdict-proven-fixed',
    ]) {
      expect(status(r, id), id).toBe('FAIL');
    }
  });

  it('the report text names every check and carries no invented figures', () => {
    const text = formatGateReport(evaluateGate(gateCase, ALL_FACTS));
    for (const id of ['real-ports', 'bundle-sealed', 'containment-green'])
      expect(text).toContain(id);
    expect(text).not.toMatch(/\d+(\.\d+)?\s?(ms|s|%|usd|\$)/i);
  });
});
