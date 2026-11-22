import { CaseStage, Exhibit, TrialEvent, type Role } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { getCaseExhibits } from '../app/data.js';
import { buildCaseView } from '../model/caseView.js';
import { IMG, JS_URL, PAYLOAD, poisonPayloads, SCRIPT, STYLE_PAYLOAD } from '../testing/poison.js';
import { withProsecution } from '../testing/prosecution.js';
import { verifyResult, withVerify, withoutVerify } from '../testing/verify.js';
import { MAX_QUOTE_LENGTH, buildTerminalView } from './model.js';
import type { TerminalView } from './types.js';

const EM_DASH = '—';

function loadTrial(name: string): TrialEvent[] {
  return TrialEvent.array().parse(readFixtureJson(`trials/${name}.events.json`));
}

const GATE = loadTrial('nodegoat-sqli-001');
const ESCALATED = loadTrial('escalated-001');
const GATE_CONTENT = Exhibit.array().parse(
  readFixtureJson('exhibits/nodegoat-sqli-001.exhibits.json'),
);
const WITNESS_ID = 'exhibit-witness-001';
const PATCH_ID = 'exhibit-patch-001';
const COUNTER_ID = 'exhibit-counter-001';

/** Every static string the model wrote: titles, bodies, tape text. */
function staticText(v: TerminalView): string[] {
  return [...v.bubbles.flatMap((b) => [b.title, b.body]), ...v.tape.map((t) => t.text)];
}

function afterVerdict(events: readonly TrialEvent[]): TrialEvent[] {
  // Moves the trial's verify-result after the verdict, renumbering seq.
  const verify = events.filter((e) => e.type === 'verify-result');
  const rest = events.filter((e) => e.type !== 'verify-result');
  return [...rest, ...verify].map((e, seq) => ({ ...e, seq }));
}

describe('buildTerminalView: totality', () => {
  it('builds a view from an empty stream', () => {
    const v = buildTerminalView([]);
    expect(v.eventCount).toBe(0);
    expect(v.lastSeq).toBe(-1);
    expect(v.status).toBe('in-progress');
    expect(v.verified).toBe(false);
    expect(v.stages.map((s) => s.stage)).toEqual(CaseStage.options);
    expect(v.stages.every((s) => s.state === 'pending')).toBe(true);
    expect(v.diff).toBeUndefined();
    expect(v.verdict).toBeUndefined();
    expect(v.cost.remaining).toBeUndefined();
    expect(v.bubbles).toEqual([]);
  });

  for (const [name, events] of [
    ['gate', GATE],
    ['escalated', ESCALATED],
  ] as const) {
    it(`replays the ${name} fixture prefix by prefix into a valid view`, () => {
      for (let n = 0; n <= events.length; n += 1) {
        const prefix = events.slice(0, n);
        const v = buildTerminalView(prefix, GATE_CONTENT);
        expect(v.eventCount).toBe(n);
        expect(v.lastSeq).toBe(n === 0 ? -1 : prefix.at(-1)?.seq);
        expect(v.tape).toHaveLength(n);
        expect(v.stages.map((s) => s.stage)).toEqual(CaseStage.options);
        expect(v.stages.filter((s) => s.state === 'active').length).toBeLessThanOrEqual(1);
        const last = prefix.at(-1);
        const active = v.stages.find((s) => s.state === 'active');
        if (v.status === 'in-progress' && last && last.type !== 'stage-exited')
          expect(active?.stage).toBe(last.stage);
        else expect(active).toBeUndefined();
        // Every stage the record shows exited is done, with the recorded next stage.
        for (const e of prefix)
          if (e.type === 'stage-exited') {
            const cell = v.stages.find((s) => s.stage === e.stage);
            expect(cell?.exitedTo).toBe(e.payload.to);
            expect(cell?.state).toBe('done');
          }
        // Stages the record never touched stay pending.
        const touched = new Set(prefix.map((e) => e.stage));
        for (const s of v.stages)
          if (!touched.has(s.stage) && !['verdict', 'escalated', 'dismissed'].includes(s.stage))
            expect(s.state).toBe('pending');
        const cv = buildCaseView(prefix);
        expect(v.status).toBe(cv.status);
        expect(v.verified).toBe(cv.stamp === 'VERIFIED');
        expect(v.awaitingVerification).toBe(cv.awaitingVerification);
        for (const b of v.bubbles) {
          expect(b.title.length).toBeGreaterThan(0);
          expect(b.body.length).toBeGreaterThan(0);
        }
        expect(buildTerminalView(prefix, GATE_CONTENT)).toEqual(v);
      }
    });
  }

  it('marks the gate trial verified with every stage it passed through done', () => {
    const v = buildTerminalView(GATE, GATE_CONTENT);
    expect(v.status).toBe('verified');
    expect(v.verified).toBe(true);
    const state = Object.fromEntries(v.stages.map((s) => [s.stage, s.state]));
    for (const s of ['intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'])
      expect(state[s]).toBe('done');
    expect(state['verdict']).toBe('done');
    expect(state['jury']).toBe('pending');
    expect(state['escalated']).toBe('pending');
    expect(v.stages.find((s) => s.stage === 'defense')).toMatchObject({ attempts: 1, wallMs: 0 });
    expect(v.stages.find((s) => s.stage === 'remedy')).toMatchObject({ attempts: 0 });
    expect(v.stages.find((s) => s.stage === 'remedy')?.wallMs).toBeUndefined();
  });

  it('shows the escalated trial in human review with no active stage', () => {
    const v = buildTerminalView(ESCALATED);
    expect(v.status).toBe('human-review');
    expect(v.stages.find((s) => s.stage === 'defense')?.state).toBe('done');
    expect(v.stages.find((s) => s.stage === 'escalated')?.state).toBe('done');
    expect(v.evidence.map((x) => [x.id, x.state, x.rejectedBy])).toEqual([
      ['exhibit-witness-001', 'rejected', 'stable-3of3'],
      ['exhibit-witness-002', 'rejected', 'differential'],
    ]);
    const esc = v.bubbles.find((b) => b.title === 'Escalated to human review');
    expect(esc).toMatchObject({ agent: 'stenographer', anchor: 'verdict', tone: 'warn' });
    expect(esc?.quote).toBe('second Defense attempt produced no admissible witness');
  });

  it('ignores events for another case and repeated seqs, as the case view does', () => {
    const other = { ...GATE[3], caseId: 'case-other', seq: 99 } as TrialEvent;
    const dup = { ...GATE[2], seq: 1 } as TrialEvent;
    const v = buildTerminalView([...GATE, other, dup]);
    expect(v.eventCount).toBe(GATE.length);
    expect(v).toEqual(buildTerminalView(GATE));
  });
});

describe('buildTerminalView: evidence', () => {
  it('copies the Judge result for the witness', () => {
    const v = buildTerminalView(GATE);
    const w = v.evidence.find((x) => x.id === WITNESS_ID);
    expect(w).toMatchObject({
      kind: 'witness',
      author: 'defense',
      state: 'admitted',
      vulnPass: true,
      safeVariantFail: true,
      egressAttempts: 0,
      family: [true, true, true],
      durationMs: 2600,
    });
    expect(w?.runs).toHaveLength(3);
    expect(w?.runs.every((r) => r.variant === 'vulnerable' && r.passed)).toBe(true);
  });

  it('shows an exhibit with no Judge ruling as pending, not rejected', () => {
    const upToSubmission = GATE.slice(
      0,
      GATE.findIndex((e) => e.type === 'exhibit-result'),
    );
    const w = buildTerminalView(upToSubmission).evidence.find((x) => x.id === WITNESS_ID);
    expect(w?.state).toBe('pending');
    expect(w?.runs).toEqual([]);
    expect(w?.vulnPass).toBeUndefined();
    const p = buildTerminalView(withoutVerify(GATE)).evidence.find((x) => x.id === PATCH_ID);
    expect(p).toMatchObject({ kind: 'patch', author: 'remedy', state: 'pending' });
  });
});

describe('buildTerminalView: verify honesty', () => {
  it('counts and accepts the Judge check in the gate trial', () => {
    const v = buildTerminalView(GATE);
    expect(v.verify).toHaveLength(1);
    expect(v.verify[0]).toMatchObject({ patchExhibitId: PATCH_ID, counts: true, accepted: true });
    expect(v.verify[0]?.checks.every((c) => c.ok)).toBe(true);
    const b = v.bubbles.filter((x) => x.anchor === 'verify');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ agent: 'judge', tone: 'pos', title: 'Patch confirmed' });
    expect(v.evidence.find((x) => x.id === PATCH_ID)?.state).toBe('admitted');
  });

  it('shows one bubble per failed check and never accepts', () => {
    const events = withVerify(GATE, [
      verifyResult(PATCH_ID, { familyFlipped: false, suitePassed: false }),
    ]);
    const v = buildTerminalView(events);
    expect(v.verified).toBe(false);
    expect(v.verify[0]).toMatchObject({ counts: true, accepted: false });
    expect(v.verify[0]?.checks.filter((c) => !c.ok).map((c) => c.check)).toEqual([
      'family-flipped',
      'suite-passed',
    ]);
    const titles = v.bubbles.filter((b) => b.anchor === 'verify').map((b) => b.title);
    expect(titles).toEqual(['Witness still passes', 'Test suite failed']);
    expect(v.evidence.find((x) => x.id === PATCH_ID)?.state).toBe('rejected');
  });

  it('names the rule when the Judge rejected the patch by rule', () => {
    const v = buildTerminalView(
      withVerify(GATE, [verifyResult(PATCH_ID, { rejectedBy: 'literal-only-patch' })]),
    );
    expect(v.verify[0]).toMatchObject({ accepted: false, rejectedBy: 'literal-only-patch' });
    const b = v.bubbles.find((x) => x.title === 'Patch not accepted');
    expect(b?.body).toContain('special-cased the test input');
  });

  it('does not count a check from the wrong actor or stage', () => {
    for (const as of [{ actor: 'remedy' }, { stage: 'remedy' }]) {
      const v = buildTerminalView(withVerify(GATE, [verifyResult(PATCH_ID)], as));
      expect(v.verified).toBe(false);
      const row = v.verify[0];
      expect(row).toMatchObject({ counts: false, accepted: false });
      const b = v.bubbles.find((x) => x.anchor === 'verify');
      expect(b).toMatchObject({ title: 'Check does not count', tone: 'warn' });
      expect(v.tape.find((t) => t.type === 'verify-result')?.tone).toBe('warn');
    }
  });

  it('does not count a check recorded after the verdict', () => {
    const v = buildTerminalView(afterVerdict(GATE));
    expect(v.verified).toBe(false);
    expect(v.verify[0]).toMatchObject({ counts: false, accepted: false });
    expect(v.bubbles.find((x) => x.anchor === 'verify')?.title).toBe('Check after the verdict');
  });

  it('with no check on record, the fix is awaiting verification and nothing is accepted', () => {
    const v = buildTerminalView(withoutVerify(GATE));
    expect(v.verify).toEqual([]);
    expect(v.verified).toBe(false);
    expect(v.awaitingVerification).toBe(true);
    const verdict = v.bubbles.find((b) => b.anchor === 'verdict');
    expect(verdict?.tone).toBe('warn');
    expect(verdict?.body).toContain('not verified');
  });

  it('agrees with the case view on which checks were accepted', () => {
    for (const events of [
      GATE,
      withVerify(GATE, [verifyResult(PATCH_ID), verifyResult(PATCH_ID, { rescanClean: false })]),
      withVerify(GATE, [verifyResult(PATCH_ID, { rescanClean: false }), verifyResult(PATCH_ID)]),
    ]) {
      const v = buildTerminalView(events);
      const docket = buildCaseView(events).docket;
      for (const row of v.verify) {
        const label = docket.find((d) => d.seq === row.seq)?.label ?? '';
        expect(label.startsWith('The Judge confirmed')).toBe(row.accepted);
      }
    }
  });
});

describe('buildTerminalView: prosecution', () => {
  it('shows an admitted counterexample and the objection quote', () => {
    const claim = 'The fix must also stop this counterexample family.';
    const events = withProsecution(GATE, { counterexampleId: COUNTER_ID, claim });
    const v = buildTerminalView(events);
    const c = v.evidence.find((x) => x.id === COUNTER_ID);
    expect(c).toMatchObject({ kind: 'counterexample', author: 'prosecution', state: 'admitted' });
    const obj = v.bubbles.find((b) => b.title === 'Objection');
    expect(obj).toMatchObject({ agent: 'prosecution', anchor: 'arguments', quote: claim });
    expect(obj?.cites).toEqual([COUNTER_ID]);
    expect(v.bubbles.find((b) => b.title === 'Counterexample filed')?.agent).toBe('prosecution');
    expect(v.bubbles.some((b) => b.title === 'No counterexample filed')).toBe(false);
    // The gate check lists no counterexample, so it no longer accepts the patch.
    expect(v.verify[0]).toMatchObject({ counts: true, accepted: false });
    expect(v.verify[0]?.checks.find((x) => x.check === 'counterexamples')?.ok).toBe(false);
    expect(v.bubbles.some((b) => b.title === 'Counterexample check incomplete')).toBe(true);
    expect(v.verified).toBe(false);
  });

  it('accepts a check that stopped the admitted counterexample', () => {
    const events = withVerify(withProsecution(GATE, { counterexampleId: COUNTER_ID }), [
      verifyResult(PATCH_ID, {
        counterexamples: [{ exhibitId: COUNTER_ID as never, survived: false }],
      }),
    ]);
    const v = buildTerminalView(events);
    expect(v.verify[0]).toMatchObject({ accepted: true });
    expect(v.verified).toBe(true);
  });

  it('names a counterexample that survived', () => {
    const events = withVerify(withProsecution(GATE, { counterexampleId: COUNTER_ID }), [
      verifyResult(PATCH_ID, {
        counterexamples: [{ exhibitId: COUNTER_ID as never, survived: true }],
      }),
    ]);
    const b = buildTerminalView(events).bubbles.find((x) => x.title === 'Counterexample survived');
    expect(b?.cites).toEqual([PATCH_ID, COUNTER_ID]);
  });

  it('shows a rejected counterexample as rejected with no objection', () => {
    const events = withProsecution(GATE, { counterexampleId: COUNTER_ID, admissible: false });
    const v = buildTerminalView(events);
    expect(v.evidence.find((x) => x.id === COUNTER_ID)).toMatchObject({
      state: 'rejected',
      rejectedBy: 'differential',
    });
    expect(v.bubbles.some((b) => b.title === 'Objection')).toBe(false);
    expect(v.verified).toBe(true);
  });

  it('truncates a long recorded claim in the quote only', () => {
    const claim = 'x'.repeat(1000);
    const v = buildTerminalView(withProsecution(GATE, { counterexampleId: COUNTER_ID, claim }));
    const obj = v.bubbles.find((b) => b.title === 'Objection');
    expect(Array.from(obj?.quote ?? '')).toHaveLength(MAX_QUOTE_LENGTH);
    expect(obj?.body).not.toContain('xxx');
  });
});

describe('buildTerminalView: bubbles', () => {
  it('gives every acting role in the gate trial at least one bubble', () => {
    const v = buildTerminalView(GATE, GATE_CONTENT);
    const actors = new Set<Role>(GATE.map((e) => e.actor));
    const agents = new Set(v.bubbles.map((b) => b.agent));
    for (const r of actors) expect(agents, r).toContain(r);
    for (const b of v.bubbles) {
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.body.length).toBeGreaterThan(0);
      expect(GATE.find((e) => e.seq === b.seq)?.actor).toBe(b.agent);
    }
    expect(new Set(v.bubbles.map((b) => b.id)).size).toBe(v.bubbles.length);
    const admit = v.bubbles.find((b) => b.title === 'Witness admitted');
    expect(admit).toMatchObject({ agent: 'judge', anchor: 'evidence', cites: [WITNESS_ID] });
    expect(admit?.body).toContain('3 of 3 runs');
    expect(admit?.body).toContain('proves the difference');
    expect(v.bubbles.filter((b) => b.anchor === 'stages').map((b) => b.title)).toEqual([
      'Intake finished',
      'Map finished',
      'Arraignment finished',
    ]);
    const verdict = v.bubbles.find((b) => b.anchor === 'verdict');
    expect(verdict).toMatchObject({ tone: 'pos', cites: [WITNESS_ID, PATCH_ID] });
    expect(verdict?.quote).toBe('Summary generated from the structured verdict.');
  });

  it('gives a juror a bubble with its vote, confidence and mandate', () => {
    const verdict = GATE.find((e) => e.type === 'verdict-written');
    if (verdict?.type !== 'verdict-written') throw new Error('no verdict');
    const [ballot] = verdict.payload.verdict.ballots;
    if (!ballot) throw new Error('no ballot');
    const cast = {
      ...verdict,
      seq: 0,
      stage: 'jury',
      actor: 'juror',
      type: 'ballot-cast',
      payload: { ballot },
    } as unknown as TrialEvent;
    const at = GATE.indexOf(verdict);
    const events = [...GATE.slice(0, at), cast, ...GATE.slice(at)].map((e, seq) => ({ ...e, seq }));
    const v = buildTerminalView(events);
    expect(v.ballots).toHaveLength(1);
    expect(v.ballots[0]).toMatchObject({ vote: 'high', confidence: 0.8, mandate: 'security' });
    const b = v.bubbles.find((x) => x.anchor === 'jury');
    expect(b).toMatchObject({ agent: 'juror', agentDetail: 'security', title: 'Severity vote' });
    expect(b?.body).toContain('high');
    expect(b?.body).toContain('80%');
  });

  it('writes no em dashes in static text', () => {
    for (const events of [GATE, ESCALATED, withProsecution(GATE, { counterexampleId: COUNTER_ID })])
      for (const s of staticText(buildTerminalView(events, GATE_CONTENT)))
        expect(s).not.toContain(EM_DASH);
  });

  it('keeps poisoned payloads out of titles and bodies, and out of tape text except inside ids', () => {
    for (const base of [GATE, ESCALATED, withProsecution(GATE, { counterexampleId: COUNTER_ID })]) {
      const events = poisonPayloads(base);
      const v = buildTerminalView(events);
      // The same record, unpoisoned, gives the same shape of view.
      expect(v.bubbles.length).toBe(buildTerminalView(base).bubbles.length);
      const ids = new Set<string>();
      for (const e of events) {
        const p = e.payload as Record<string, unknown>;
        for (const k of ['exhibitId', 'counterexampleId'])
          if (typeof p[k] === 'string') ids.add(p[k]);
        if (e.type === 'exhibit-result') ids.add(e.payload.result.exhibitId);
        if (e.type === 'verify-result') ids.add(e.payload.result.patchExhibitId);
        if (e.type === 'ballot-cast') ids.add(e.payload.ballot.jurorId);
      }
      const longestFirst = [...ids].sort((a, b) => b.length - a.length);
      for (const b of v.bubbles)
        for (const s of [b.title, b.body])
          for (const bad of [IMG, SCRIPT, JS_URL, STYLE_PAYLOAD]) expect(s).not.toContain(bad);
      for (const t of v.tape) {
        let rest = t.text;
        for (const id of longestFirst) rest = rest.split(id).join('');
        for (const bad of [IMG, SCRIPT, JS_URL, STYLE_PAYLOAD]) expect(rest).not.toContain(bad);
      }
      // Recorded free text survives only in quotes.
      for (const b of v.bubbles)
        if (b.quote !== undefined) expect(b.quote.startsWith(PAYLOAD)).toBe(true);
    }
  });
});

describe('buildTerminalView: cost', () => {
  it('totals equal the sums of the recorded charges', () => {
    const extra = {
      ...GATE[9],
      payload: {
        cost: {
          stage: 'remedy',
          inputTokens: 120,
          outputTokens: 30,
          usd: 0.25,
          wallMs: 900,
          attempt: 2,
        },
        remaining: {
          remainingInputTokens: 10,
          remainingOutputTokens: 0,
          remainingUsd: 0,
          exhausted: true,
        },
      },
    } as TrialEvent;
    const charged = GATE.filter((e) => e.type === 'cost-charged');
    const events = [...GATE.slice(0, 14), extra, ...GATE.slice(14)].map((e, seq) => ({
      ...e,
      seq,
    }));
    const v = buildTerminalView(events);
    expect(v.cost.rows).toHaveLength(charged.length + 1);
    const sum = (k: 'inputTokens' | 'outputTokens' | 'usd' | 'wallMs') =>
      v.cost.rows.reduce((n, r) => n + r[k], 0);
    expect(v.cost.total).toEqual({
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      usd: sum('usd'),
      wallMs: sum('wallMs'),
    });
    expect(v.cost.total.inputTokens).toBe(120);
    expect(v.cost.remaining).toEqual({ inputTokens: 10, outputTokens: 0, usd: 0, exhausted: true });
    expect(v.stages.find((s) => s.stage === 'remedy')).toMatchObject({ attempts: 1, wallMs: 900 });
    expect(v.tape.find((t) => t.seq === 14)?.tone).toBe('warn');
  });

  it('gives a budget exhaustion a bubble on the cost panel', () => {
    const last = ESCALATED.at(-1);
    if (last?.type !== 'escalated') throw new Error('fixture changed');
    const exhausted = {
      ...last,
      type: 'budget-exhausted',
      payload: { escalation: { ...last.payload.escalation, reason: 'budget-exhausted' } },
    } as TrialEvent;
    const v = buildTerminalView([...ESCALATED.slice(0, -1), exhausted]);
    expect(v.bubbles.find((b) => b.anchor === 'cost')).toMatchObject({
      agent: 'stenographer',
      title: 'Budget exhausted',
      tone: 'warn',
    });
    expect(v.status).toBe('human-review');
  });
});

describe('buildTerminalView: diff and verdict', () => {
  it('shows the patch diff when content is served for it', () => {
    const v = buildTerminalView(GATE, GATE_CONTENT);
    expect(v.diff).toMatchObject({
      exhibitId: PATCH_ID,
      filesTouched: ['app/data/allocations-dao.js'],
      linesChanged: 4,
      added: 2,
      removed: 2,
    });
    expect(v.diff?.lines.some((l) => l.kind === 'hunk')).toBe(true);
    const filed = v.bubbles.find((b) => b.title === 'Patch filed');
    expect(filed).toMatchObject({ agent: 'remedy', anchor: 'diff', cites: [PATCH_ID] });
    expect(filed?.body).toContain('1 file with 4 lines changed');
  });

  it('has no diff without content, and says the content is not in the record', () => {
    for (const content of [[], GATE_CONTENT.filter((x) => x.kind !== 'patch')]) {
      const v = buildTerminalView(GATE, content);
      expect(v.diff).toBeUndefined();
      expect(v.bubbles.find((b) => b.title === 'Patch filed')?.body).toContain(
        'not in this record',
      );
    }
  });

  it('ignores content for a patch the record does not hold or another case', () => {
    const patch = GATE_CONTENT.find((x) => x.kind === 'patch');
    if (!patch) throw new Error('no patch content');
    const stray = [
      { ...patch, id: 'exhibit-patch-999' as never },
      { ...patch, caseId: 'case-other' as never },
    ];
    expect(buildTerminalView(GATE, stray).diff).toBeUndefined();
  });

  it('copies the verdict fields as recorded', () => {
    const v = buildTerminalView(GATE);
    expect(v.verdict).toEqual({
      outcome: 'proven-fixed',
      severity: 'high',
      models: [
        { prompt: 'defense', model: 'model-id-placeholder', version: 'v1' },
        { prompt: 'remedy', model: 'model-id-placeholder', version: 'v1' },
      ],
      exhibits: [WITNESS_ID, PATCH_ID],
    });
  });
});

describe('getCaseExhibits', () => {
  it('serves schema-valid exhibits matching the gate trial submissions', () => {
    const exhibits = getCaseExhibits('nodegoat-sqli-001');
    expect(Exhibit.array().safeParse(exhibits).success).toBe(true);
    const submitted = GATE.flatMap((e) =>
      e.type === 'exhibit-submitted' ? [e.payload.exhibitId as string] : [],
    );
    expect(exhibits.map((x) => x.id).sort()).toEqual([...submitted].sort());
    expect(exhibits).toEqual(GATE_CONTENT);
    expect(exhibits.every((x) => x.caseId === GATE[0]?.caseId)).toBe(true);
  });

  it('returns an empty array for a case with no content', () => {
    expect(getCaseExhibits('escalated-001')).toEqual([]);
    expect(getCaseExhibits('no-such-case')).toEqual([]);
  });
});
