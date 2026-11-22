// L3-21: settling the up-front charge after every model call (CR-T1) and recording why a case
// halted (CR-T12, CR-T13), on a FakeCaseStore given the sink, so a release against the wrong
// seq, stage or attempt is refused the way the Postgres store will refuse it.
import { describe, expect, it } from 'vitest';
import {
  Verdict,
  type Budget,
  type CaseStage,
  type ModelPort,
  type StageCost,
  type TrialEvent,
} from '@affidavit/contracts';
import { FakeEventSink } from '@affidavit/testing';
import { ModelCallError, ModelUnconfiguredError, REFUSAL_CLASS } from './model/errors.js';
import {
  Orchestrator,
  RetryStageError,
  type AgentRequest,
  type BudgetSettlement,
  type ModelTurnResult,
  type ReportingEventSink,
  type StageHandler,
} from './orchestrator.js';
import {
  BIG_BUDGET,
  LoggingCaseStore,
  NOW,
  PATH_TO,
  assertSchemaValid,
  makeCaseFile,
  openAt,
} from './test-support.js';

const CF = makeCaseFile();
const CASE = CF.id;

/** The turn cap from the first real run: $0.50, 100000 input and 8000 output tokens. */
const TURN_BUDGET = { maxInputTokens: 100_000, maxOutputTokens: 8_000, maxUsd: 0.5 };

const req = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  actor: 'defense',
  promptId: 'defense',
  promptVersion: '1.0.0',
  model: 'model-a',
  system: 'static system text',
  user: 'u',
  tools: ['submit_witness'],
  outputSchemaRef: 'Witness',
  maxTurns: 4,
  budget: TURN_BUDGET,
  ...overrides,
});

const spent = (usd: number, inputTokens = 900, outputTokens = 120): StageCost => ({
  stage: 'defense',
  attempt: 1,
  inputTokens,
  outputTokens,
  usd,
  wallMs: 7,
});

type Step = ModelTurnResult | Error;

/** A model that answers (or throws) in call order. */
function scripted(steps: readonly Step[]): ModelPort & { calls: number } {
  const queue = [...steps];
  const port = {
    calls: 0,
    runTurn(): Promise<ModelTurnResult> {
      port.calls++;
      const next = queue.shift();
      if (next === undefined) return Promise.reject(new Error('script ran out'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return port;
}

async function setup(
  opts: {
    budget?: Budget;
    stage?: readonly CaseStage[];
    settlement?: BudgetSettlement;
    killSwitch?: () => boolean;
    stopAfterTransition?: () => boolean;
    maxStageAttempts?: number;
  } = {},
) {
  const sink = new FakeEventSink();
  const store = new LoggingCaseStore([], { events: sink, juryEnabled: false });
  await openAt(store, CF, opts.budget ?? BIG_BUDGET, opts.stage ?? PATH_TO.defense);
  const make = (handlers: Partial<Record<CaseStage, StageHandler>>, model: ModelPort) =>
    new Orchestrator({
      store,
      sink,
      model,
      handlers,
      config: {
        killSwitch: opts.killSwitch ?? (() => false),
        maxStageAttempts: opts.maxStageAttempts ?? 1,
        now: () => NOW,
        ...(opts.stopAfterTransition === undefined
          ? {}
          : { stopAfterTransition: opts.stopAfterTransition }),
      },
      ...(opts.settlement === undefined ? {} : { settlement: opts.settlement }),
    });
  return { sink, store, make, events: () => assertSchemaValid(sink.events(CASE)) };
}

/** A Defense handler that makes `calls` model calls, swallowing call errors, then escalates. */
function callingDefense(calls: number, seen?: { costs: readonly StageCost[] }): StageHandler {
  return {
    async run(ctx) {
      for (let i = 0; i < calls; i++) {
        try {
          await ctx.runAgent(req());
        } catch (e) {
          if (!(e instanceof ModelCallError)) throw e;
        }
      }
      if (seen) seen.costs = ctx.costs();
      return { kind: 'escalate', reason: 'no-admissible-witness-above-floor', detail: 'test' };
    },
  };
}

const ofType = <T extends TrialEvent['type']>(events: readonly TrialEvent[], type: T) =>
  events.filter((e): e is Extract<TrialEvent, { type: T }> => e.type === type);

describe('settling a successful call (reason reservation-unspent)', () => {
  it('gives back the unspent part so a $2 case survives many cheap calls (first real run)', async () => {
    // Before L3-21 each call kept its $0.50 reservation, so the fourth call exhausted a $2 case.
    const { store, events, make } = await setup({
      budget: { maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxUsd: 2 },
    });
    const steps = Array.from({ length: 6 }, (): Step => ({
      outcome: 'no-submission',
      cost: spent(0.0005),
    }));
    const out = await make({ defense: callingDefense(6) }, scripted(steps)).run(CASE);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    const evs = events();
    expect(evs.some((e) => e.type === 'budget-exhausted')).toBe(false);
    const escalated = ofType(evs, 'escalated');
    expect(escalated[0]!.payload.escalation.reason).toBe('no-admissible-witness-above-floor');

    const charged = ofType(evs, 'cost-charged');
    const released = ofType(evs, 'cost-released');
    expect(charged).toHaveLength(6);
    expect(released).toHaveLength(6);
    released.forEach((r, i) => {
      expect(r.actor).toBe('defense');
      expect(r.stage).toBe('defense');
      expect(r.payload.reason).toBe('reservation-unspent');
      expect(r.payload.reservationSeq).toBe(charged[i]!.seq);
      expect(r.payload.cost).toMatchObject({
        stage: 'defense',
        attempt: 1,
        inputTokens: TURN_BUDGET.maxInputTokens - 900,
        outputTokens: TURN_BUDGET.maxOutputTokens - 120,
        wallMs: 0,
      });
      expect(r.payload.cost.usd).toBeCloseTo(0.4995, 12);
      expect(r.seq).toBeGreaterThan(charged[i]!.seq);
    });
    // The budget view after the last release is the real spend, not six reservations.
    expect(released.at(-1)!.payload.remaining.remainingUsd).toBeCloseTo(2 - 6 * 0.0005, 6);
    expect(store.releases(CASE).size).toBe(6);

    const verdict = Verdict.parse(await store.getVerdict(CASE));
    expect(verdict.cost).toHaveLength(6);
    for (const c of verdict.cost) expect(c).toEqual(spent(0.0005));
  });

  it('keeps the reservation up front, so the model is never called past the budget', async () => {
    const { store, events, make } = await setup({
      budget: { maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxUsd: 0.4 },
    });
    const model = scripted([]);
    const out = await make({ defense: callingDefense(1) }, model).run(CASE);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    expect(model.calls).toBe(0);
    expect(store.charges(CASE).map((c) => c.usd)).toEqual([0.5]);
    expect(events().some((e) => e.type === 'cost-released')).toBe(false);
  });

  it('charges an overspent field and releases the unspent ones, netting to the reported cost', async () => {
    const { store, events, make } = await setup();
    const over = { ...spent(0.75), inputTokens: 120_000 };
    const seen = { costs: [] as readonly StageCost[] };
    await make(
      { defense: callingDefense(1, seen) },
      scripted([{ outcome: 'no-submission', cost: over }]),
    ).run(CASE);
    const evs = events();
    expect(store.charges(CASE).map((c) => [c.inputTokens, c.outputTokens, c.usd])).toEqual([
      [100_000, 8_000, 0.5],
      [20_000, 0, 0.25],
    ]);
    const released = ofType(evs, 'cost-released');
    expect(released).toHaveLength(1);
    expect(released[0]!.payload.cost).toMatchObject({
      inputTokens: 0,
      outputTokens: 7_880,
      usd: 0,
    });
    expect(seen.costs).toEqual([over]);
  });

  it('a release that fails does not fail a call that succeeded; the charge stands everywhere', async () => {
    const { events, make, store } = await setup({
      settlement: { release: () => Promise.reject(new Error('store down')) },
    });
    const seen = { costs: [] as readonly StageCost[] };
    const out = await make(
      { defense: callingDefense(1, seen) },
      scripted([{ outcome: 'no-submission', cost: spent(0.001) }]),
    ).run(CASE);
    expect(out.stage).toBe('escalated');
    expect(events().some((e) => e.type === 'cost-released')).toBe(false);
    expect(seen.costs[0]).toMatchObject({ usd: 0.5, inputTokens: 100_000, outputTokens: 8_000 });
    expect(Verdict.parse(await store.getVerdict(CASE)).cost[0]).toMatchObject({ usd: 0.5 });
  });

  it('a wired settlement is used instead of the store, once per reservation seq', async () => {
    const calls: number[] = [];
    const { make, store, events } = await setup({
      settlement: {
        release: (id, refund, seq) => {
          calls.push(seq);
          return store.releaseCharge(id, refund, seq);
        },
      },
    });
    await make(
      { defense: callingDefense(2) },
      scripted([
        { outcome: 'no-submission', cost: spent(0.002) },
        { outcome: 'no-submission', cost: spent(0.003) },
      ]),
    ).run(CASE);
    const charged = ofType(events(), 'cost-charged').map((e) => e.seq);
    expect(calls).toEqual(charged);
    expect(
      new Set(ofType(events(), 'cost-released').map((e) => e.payload.reservationSeq)).size,
    ).toBe(2);
  });
});

describe('the verdict cost agrees with the event stream', () => {
  /** Net cost per stage and attempt from the stream alone: charges minus releases. */
  function netFromStream(events: readonly TrialEvent[]) {
    const net = new Map<string, { inputTokens: number; outputTokens: number; usd: number }>();
    const add = (c: StageCost, sign: 1 | -1) => {
      const key = `${c.stage}#${c.attempt}`;
      const t = net.get(key) ?? { inputTokens: 0, outputTokens: 0, usd: 0 };
      t.inputTokens += sign * c.inputTokens;
      t.outputTokens += sign * c.outputTokens;
      t.usd += sign * c.usd;
      net.set(key, t);
    };
    for (const e of events) {
      if (e.type === 'cost-charged') add(e.payload.cost, 1);
      if (e.type === 'cost-released') add(e.payload.cost, -1);
    }
    return net;
  }

  function netFromVerdict(v: Verdict) {
    const net = new Map<string, { inputTokens: number; outputTokens: number; usd: number }>();
    for (const c of v.cost) {
      const key = `${c.stage}#${c.attempt}`;
      const t = net.get(key) ?? { inputTokens: 0, outputTokens: 0, usd: 0 };
      t.inputTokens += c.inputTokens;
      t.outputTokens += c.outputTokens;
      t.usd += c.usd;
      net.set(key, t);
    }
    return net;
  }

  it('replaying the events recomputes the verdict cost, across every settlement path', async () => {
    const { store, events, make } = await setup({ maxStageAttempts: 2 });
    const model = scripted([
      // Attempt 1: a cheap success, an overspend, a failure that reported its spend, a failure
      // with unknown spend, and a refused-before-work failure (zero spend).
      { outcome: 'no-submission', cost: spent(0.0012) },
      { outcome: 'no-submission', cost: { ...spent(0.6), outputTokens: 9_000 } },
      new ModelCallError('agent turn failed', { cost: spent(0.0005, 300, 20) }),
      new ModelCallError('stream broke'),
      new ModelCallError('invalid_request', { cost: spent(0, 0, 0) }),
      // Attempt 2: one sub-micro-dollar success.
      { outcome: 'no-submission', cost: { ...spent(5e-7), attempt: 2 } },
    ]);
    const defense: StageHandler = {
      async run(ctx) {
        const n = ctx.attempt === 1 ? 5 : 1;
        for (let i = 0; i < n; i++) {
          try {
            await ctx.runAgent(req());
          } catch (e) {
            if (!(e instanceof ModelCallError)) throw e;
          }
        }
        if (ctx.attempt === 1) throw new RetryStageError('again');
        return { kind: 'escalate', reason: 'no-admissible-witness-above-floor', detail: 'test' };
      },
    };
    expect((await make({ defense }, model).run(CASE)).stage).toBe('escalated');

    const evs = events();
    const verdict = Verdict.parse(await store.getVerdict(CASE));
    const fromStream = netFromStream(evs);
    const fromVerdict = netFromVerdict(verdict);
    expect([...fromVerdict.keys()].sort()).toEqual([...fromStream.keys()].sort());
    for (const [key, s] of fromStream) {
      const v = fromVerdict.get(key)!;
      expect(v.inputTokens).toBe(s.inputTokens);
      expect(v.outputTokens).toBe(s.outputTokens);
      expect(v.usd).toBeCloseTo(s.usd, 12);
    }
    // And the figures are the real spend, with only the unknown-spend call kept at its cap.
    const a1 = fromVerdict.get('defense#1')!;
    expect(a1.usd).toBeCloseTo(0.0012 + 0.6 + 0.0005 + 0.5 + 0, 9);
    expect(fromVerdict.get('defense#2')!.usd).toBe(5e-7);
    // The verdict-written event carries the same verdict the store holds.
    expect(ofType(evs, 'verdict-written')[0]!.payload.verdict.cost).toEqual(verdict.cost);
    const reasons = ofType(evs, 'cost-released').map((e) => e.payload.reason);
    expect(reasons).toEqual([
      'reservation-unspent',
      'reservation-unspent',
      'model-call-failed',
      'model-call-failed',
      'reservation-unspent',
    ]);
  });
});

describe('halted events (CR-T12)', () => {
  const ORDER: CaseStage[] = [
    'intake',
    'map',
    'arraign',
    'defense',
    'prosecution',
    'remedy',
    'verify',
  ];
  const passThrough = (): Partial<Record<CaseStage, StageHandler>> =>
    Object.fromEntries(
      ORDER.map((s, i) => [
        s,
        { run: () => Promise.resolve({ kind: 'advance', next: ORDER[i + 1] ?? 'verdict' }) },
      ]),
    );

  it.each(ORDER)('a kill switch halt is legal at %s and moves no stage', async (stage) => {
    // The kill switch is read once per stage here; trip it on the read for `stage`.
    let reads = 0;
    const at = ORDER.indexOf(stage);
    const { store, events, make } = await setup({
      stage: [],
      killSwitch: () => reads++ === at,
    });
    const out = await make(passThrough(), scripted([])).run(CASE);
    expect(out).toEqual({ status: 'halted', stage, reason: 'kill-switch' });
    expect(await store.stage(CASE)).toBe(stage);
    const evs = events();
    const halted = ofType(evs, 'halted');
    expect(halted).toHaveLength(1);
    expect(halted[0]!.stage).toBe(stage);
    expect(halted[0]!.actor).toBe('stenographer');
    expect(halted[0]!.payload.reason).toBe('kill-switch');
    expect(halted[0]!.payload.detail).not.toMatch(/—/);
    expect(evs.at(-1)!.type).toBe('halted');
    expect(evs.some((e) => e.type === 'escalated' || e.type === 'dismissed')).toBe(false);
  });

  it('a resumed run continues inside the halted stage without a second stage-entered', async () => {
    let tripped = true;
    const { events, make } = await setup({ killSwitch: () => tripped });
    const orch = make(
      { defense: callingDefense(1) },
      scripted([{ outcome: 'no-submission', cost: spent(0.001) }]),
    );
    expect(await orch.run(CASE)).toEqual({
      status: 'halted',
      stage: 'defense',
      reason: 'kill-switch',
    });
    tripped = false;
    expect((await orch.run(CASE)).stage).toBe('escalated');
    const entered = ofType(events(), 'stage-entered').filter((e) => e.stage === 'defense');
    expect(entered).toHaveLength(1);
  });

  it('halts with model-unconfigured before any charge', async () => {
    const { store, events, make } = await setup();
    const model: ModelPort & { preflight(): Promise<void> } = {
      preflight: () => Promise.reject(new ModelUnconfiguredError('ANTHROPIC_API_KEY is not set')),
      runTurn: () => Promise.reject(new Error('must not be called')),
    };
    const out = await make({ defense: callingDefense(1) }, model).run(CASE);
    expect(out).toEqual({ status: 'halted', stage: 'defense', reason: 'model-unconfigured' });
    expect(store.charges(CASE)).toEqual([]);
    const halted = ofType(events(), 'halted');
    expect(halted.map((h) => [h.stage, h.payload.reason])).toEqual([
      ['defense', 'model-unconfigured'],
    ]);
    expect(halted[0]!.payload.detail).not.toContain('ANTHROPIC_API_KEY');
  });

  it.each([
    ['cyber', 'cyber'],
    ['not-on-the-list', 'other'],
    [undefined, 'other'],
  ] as const)(
    'an unrouted refusal (category %s) halts with model-refusal and category %s, never dismissing',
    async (given, expected) => {
      const { store, events, make } = await setup();
      const refusal = new ModelCallError('provider error: refusal', {
        cost: spent(0.002),
        provider: {
          errorClass: REFUSAL_CLASS,
          ...(given === undefined ? {} : { refusalCategory: given }),
        },
      });
      const defense: StageHandler = {
        async run(ctx) {
          await ctx.runAgent(req());
          return { kind: 'advance', next: 'prosecution' };
        },
      };
      const out = await make({ defense }, scripted([refusal])).run(CASE);
      expect(out).toEqual({
        status: 'halted',
        stage: 'defense',
        reason: 'model-refusal',
        refusalCategory: expected,
      });
      expect(await store.stage(CASE)).toBe('defense');
      expect(await store.getVerdict(CASE)).toBeNull();
      const evs = events();
      const halted = ofType(evs, 'halted');
      expect(halted).toHaveLength(1);
      expect(halted[0]!.payload).toMatchObject({
        reason: 'model-refusal',
        refusalCategory: expected,
      });
      expect(halted[0]!.payload.detail).not.toContain('provider error');
      expect(evs.some((e) => ['dismissed', 'escalated'].includes(e.type))).toBe(false);
      // The refused call was still settled as the port reported it.
      expect(ofType(evs, 'cost-released')[0]!.payload.reason).toBe('model-call-failed');
    },
  );

  it('a non-refusal call error is not a halt', async () => {
    const { events, make } = await setup();
    const defense: StageHandler = {
      async run(ctx) {
        await ctx.runAgent(req());
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const err = new ModelCallError('rate limited', { provider: { errorClass: 'rate_limit' } });
    await expect(make({ defense }, scripted([err])).run(CASE)).rejects.toBe(err);
    expect(events().some((e) => e.type === 'halted')).toBe(false);
  });

  it('a budget-exhausted halt comes before, and never replaces, the budget-exhausted escalation', async () => {
    const { store, events, make } = await setup({
      budget: { maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxUsd: 0.1 },
    });
    const out = await make({ defense: callingDefense(1) }, scripted([])).run(CASE);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    expect(await store.stage(CASE)).toBe('escalated');
    const tail = events()
      .filter((e) => ['halted', 'budget-exhausted', 'escalated'].includes(e.type))
      .map((e) => [e.type, e.stage]);
    expect(tail).toEqual([
      ['halted', 'defense'],
      ['budget-exhausted', 'defense'],
      ['escalated', 'defense'],
    ]);
    const halted = ofType(events(), 'halted')[0]!;
    expect(halted.payload.reason).toBe('budget-exhausted');
    expect(halted.payload.refusalCategory).toBeUndefined();
  });
});

describe('stopping after a transition is not a halt (#84 review)', () => {
  const ORDER: CaseStage[] = ['intake', 'map', 'arraign', 'defense'];
  const advance = (): Partial<Record<CaseStage, StageHandler>> =>
    Object.fromEntries(
      ORDER.map((s, i) => [
        s,
        { run: () => Promise.resolve({ kind: 'advance', next: ORDER[i + 1] ?? 'prosecution' }) },
      ]),
    );

  it('a normal advance with stopAfterTransition ends quietly: no halted event', async () => {
    // As the worker runs it: stop once this job's stage has moved the case.
    let moved = false;
    const { store, events, make } = await setup({ stage: [], stopAfterTransition: () => moved });
    const transition = store.transition.bind(store);
    store.transition = async (id, to) => {
      await transition(id, to);
      moved = true;
    };
    expect(await make(advance(), scripted([])).run(CASE)).toEqual({
      status: 'stopped',
      stage: 'map',
    });
    expect(await store.stage(CASE)).toBe('map');
    const evs = events();
    expect(evs.some((e) => e.type === 'halted')).toBe(false);
    expect(evs.map((e) => [e.type, e.stage])).toEqual([
      ['stage-entered', 'intake'],
      ['stage-exited', 'intake'],
      ['stage-entered', 'map'],
    ]);
  });

  it('the kill switch still halts, with its event, when stopAfterTransition is wired', async () => {
    const { events, make } = await setup({
      stage: [],
      killSwitch: () => true,
      stopAfterTransition: () => false,
    });
    expect(await make(advance(), scripted([])).run(CASE)).toEqual({
      status: 'halted',
      stage: 'intake',
      reason: 'kill-switch',
    });
    expect(ofType(events(), 'halted')).toHaveLength(1);
  });

  it('is honoured only after this run moved the case, and after the terminal check', async () => {
    // Already true at the start: the run still does its stage's work, then reaches a terminal
    // stage, which returns terminal with its verdict rather than stopping.
    const { store, make } = await setup({ stopAfterTransition: () => true });
    const defense: StageHandler = {
      run: () =>
        Promise.resolve({
          kind: 'escalate',
          reason: 'no-admissible-witness-above-floor',
          detail: 'x',
        }),
    };
    expect(await make({ defense }, scripted([])).run(CASE)).toEqual({
      status: 'terminal',
      stage: 'escalated',
    });
    expect(Verdict.parse(await store.getVerdict(CASE)).outcome).toBe('escalated');
  });

  it('stops at the next stage once a transition happened, before its handler runs', async () => {
    const { store, make } = await setup({ stopAfterTransition: () => true });
    let prosecutionRan = false;
    const handlers: Partial<Record<CaseStage, StageHandler>> = {
      defense: { run: () => Promise.resolve({ kind: 'advance', next: 'prosecution' }) },
      prosecution: {
        run: () => {
          prosecutionRan = true;
          return Promise.resolve({ kind: 'advance', next: 'remedy' });
        },
      },
    };
    expect(await make(handlers, scripted([])).run(CASE)).toEqual({
      status: 'stopped',
      stage: 'prosecution',
    });
    expect(prosecutionRan).toBe(false);
    expect(await store.stage(CASE)).toBe('prosecution');
  });

  it('records a kill-switch halt once per case, not on every rerun while the switch stays on', async () => {
    const { events, make } = await setup({ killSwitch: () => true });
    const orch = make({ defense: callingDefense(1) }, scripted([]));
    for (let i = 0; i < 3; i++) {
      expect((await orch.run(CASE)).status).toBe('halted');
    }
    expect(ofType(events(), 'halted')).toHaveLength(1);
    expect(ofType(events(), 'stage-entered')).toHaveLength(1);
  });
});

describe('a sink that assigns the seq itself (#84 review, stage-scoped ports)', () => {
  /** Like the worker's stage-scoped ports: the store hands out 0, the sink assigns the real seq. */
  async function scoped(returnsSeq: boolean) {
    const sink = new FakeEventSink();
    const store = new LoggingCaseStore([], { events: sink, juryEnabled: false });
    await openAt(store, CF, BIG_BUDGET, PATH_TO.defense);
    let next = 0;
    const scopedSink: ReportingEventSink = {
      emit: async (e) => {
        const seq = next++;
        await sink.emit({ ...e, seq });
        return returnsSeq ? seq : undefined;
      },
    };
    store.nextSeq = () => Promise.resolve(0);
    const orch = new Orchestrator({
      store,
      sink: scopedSink,
      model: scripted([{ outcome: 'no-submission', cost: spent(0.001) }]),
      handlers: { defense: callingDefense(1) },
      config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
    });
    await orch.run(CASE);
    return { store, events: assertSchemaValid(sink.events(CASE)) };
  }

  it('names the seq the sink assigned when the sink returns it', async () => {
    const { store, events } = await scoped(true);
    const charged = ofType(events, 'cost-charged');
    const released = ofType(events, 'cost-released');
    expect(charged).toHaveLength(1);
    expect(charged[0]!.seq).toBeGreaterThan(0);
    expect(released).toHaveLength(1);
    expect(released[0]!.payload.reservationSeq).toBe(charged[0]!.seq);
    expect([...store.releases(CASE).keys()]).toEqual([charged[0]!.seq]);
  });

  it('releases nothing when the sink assigns seqs but does not say which (fails closed)', async () => {
    const { store, events } = await scoped(false);
    expect(ofType(events, 'cost-released')).toHaveLength(0);
    expect(store.releases(CASE).size).toBe(0);
    const verdict = Verdict.parse(await store.getVerdict(CASE));
    expect(verdict.cost[0]).toMatchObject({ usd: TURN_BUDGET.maxUsd });
  });
});

describe('a long-lived orchestrator across worker jobs (#84 re-review)', () => {
  /**
   * The worker's shape: ONE Orchestrator for its life, and per job stage-scoped ports. The store
   * hands out a placeholder seq 0; the sink assigns the real seq, reports it, and drops the
   * duplicate `stage-entered` that starts every job after the first (reporting nothing, or the
   * seq of the event it duplicates). One job moves the case at most one stage.
   */
  async function worker(dropReports: 'nothing' | 'duplicate-seq') {
    const sink = new FakeEventSink();
    const store = new LoggingCaseStore([], { events: sink, juryEnabled: false });
    await openAt(store, CF, BIG_BUDGET, PATH_TO.defense);
    let next = 0;
    let job = { stage: 'defense' as CaseStage, moved: false };
    const entered = new Map<CaseStage, number>();
    const transition = store.transition.bind(store);
    store.transition = async (id, to) => {
      await transition(id, to);
      job.moved = true;
    };
    store.nextSeq = () => Promise.resolve(0);
    const scopedSink: ReportingEventSink = {
      emit: async (e) => {
        if (e.type === 'stage-entered' && e.stage === job.stage && !job.moved) {
          const seen = entered.get(e.stage);
          if (seen !== undefined) return dropReports === 'nothing' ? undefined : seen;
        }
        const seq = next++;
        if (e.type === 'stage-entered') entered.set(e.stage, seq);
        await sink.emit({ ...e, seq });
        return seq;
      },
    };
    const turn = (actor: 'defense' | 'prosecution'): AgentRequest =>
      actor === 'defense'
        ? req()
        : req({
            actor: 'prosecution',
            promptId: 'prosecution',
            tools: ['submit_counterexample'],
            outputSchemaRef: 'Exhibit',
          });
    const orch = new Orchestrator({
      store,
      sink: scopedSink,
      model: scripted([
        { outcome: 'no-submission', cost: spent(0.001) },
        { outcome: 'no-submission', cost: { ...spent(0.002), stage: 'prosecution' } },
      ]),
      handlers: {
        defense: {
          async run(ctx) {
            await ctx.runAgent(turn('defense'));
            return { kind: 'advance', next: 'prosecution' };
          },
        },
        prosecution: {
          async run(ctx) {
            await ctx.runAgent(turn('prosecution'));
            return { kind: 'advance', next: 'remedy' };
          },
        },
      },
      config: {
        killSwitch: () => false,
        stopAfterTransition: () => job.moved,
        maxStageAttempts: 1,
        now: () => NOW,
      },
    });
    expect(await orch.run(CASE)).toEqual({ status: 'stopped', stage: 'prosecution' });
    job = { stage: 'prosecution', moved: false };
    expect(await orch.run(CASE)).toEqual({ status: 'stopped', stage: 'remedy' });
    return { store, events: assertSchemaValid(sink.events(CASE)) };
  }

  it.each(['nothing', 'duplicate-seq'] as const)(
    'releases every job reservation with its real seq when the duplicate stage-entered reports %s',
    async (dropReports) => {
      const { store, events } = await worker(dropReports);
      // The second job's stage-entered was dropped: one per stage in the stream.
      expect(ofType(events, 'stage-entered').filter((e) => e.stage === 'prosecution')).toHaveLength(
        1,
      );
      const charged = ofType(events, 'cost-charged');
      const released = ofType(events, 'cost-released');
      expect(charged.map((e) => e.stage)).toEqual(['defense', 'prosecution']);
      expect(released.map((e) => e.payload.reservationSeq)).toEqual(charged.map((e) => e.seq));
      expect([...store.releases(CASE).keys()]).toEqual(charged.map((e) => e.seq));
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    },
  );

  /**
   * The production shape after #85 and #84: the store hands out the placeholder seq 2^30, the
   * case starts at arraign, and each job moves it one stage. The arraign job stores the real
   * `stage-entered` for defense, so every later job's own `stage-entered` is a duplicate the
   * sink drops, resolving to undefined. Run on one Orchestrator for the worker's life, and on a
   * new one per job (a worker restart between jobs).
   */
  it.each(['one orchestrator', 'a new orchestrator per job'] as const)(
    'production shape: releases every later reservation with its real seq on %s',
    async (lifetime) => {
      const PLACEHOLDER = 2 ** 30;
      const sink = new FakeEventSink();
      const store = new LoggingCaseStore([], { events: sink, juryEnabled: false });
      await openAt(store, CF, BIG_BUDGET, ['map', 'arraign']);
      let next = 0;
      let job = { stage: 'arraign' as CaseStage, moved: false };
      const transition = store.transition.bind(store);
      store.transition = async (id, to) => {
        await transition(id, to);
        job.moved = true;
      };
      store.nextSeq = () => Promise.resolve(PLACEHOLDER);
      const stored = (stage: CaseStage) =>
        sink.events(CASE).some((e) => e.type === 'stage-entered' && e.stage === stage);
      const dropped: CaseStage[] = [];
      const scopedSink: ReportingEventSink = {
        emit: async (e) => {
          if (e.type === 'stage-entered' && e.stage === job.stage && stored(e.stage)) {
            dropped.push(e.stage);
            return undefined;
          }
          const seq = next++;
          await sink.emit({ ...e, seq });
          return seq;
        },
      };
      const call = (stage: 'defense' | 'prosecution' | 'remedy'): StageHandler => ({
        async run(ctx) {
          await ctx.runAgent(
            stage === 'defense'
              ? req()
              : req({
                  actor: stage,
                  promptId: stage,
                  tools: [stage === 'prosecution' ? 'submit_counterexample' : 'submit_patch'],
                  outputSchemaRef: stage === 'prosecution' ? 'Exhibit' : 'Patch',
                }),
          );
          return {
            kind: 'advance',
            next:
              stage === 'defense' ? 'prosecution' : stage === 'prosecution' ? 'remedy' : 'verify',
          };
        },
      });
      const model = scripted([
        { outcome: 'no-submission', cost: spent(0.001) },
        { outcome: 'no-submission', cost: { ...spent(0.002), stage: 'prosecution' } },
        { outcome: 'no-submission', cost: { ...spent(0.003), stage: 'remedy' } },
      ]);
      const make = () =>
        new Orchestrator({
          store,
          sink: scopedSink,
          model,
          handlers: {
            arraign: { run: () => Promise.resolve({ kind: 'advance', next: 'defense' }) },
            defense: call('defense'),
            prosecution: call('prosecution'),
            remedy: call('remedy'),
          },
          config: {
            killSwitch: () => false,
            stopAfterTransition: () => job.moved,
            maxStageAttempts: 1,
            now: () => NOW,
          },
        });
      const shared = make();
      const jobs: [CaseStage, CaseStage][] = [
        ['arraign', 'defense'],
        ['defense', 'prosecution'],
        ['prosecution', 'remedy'],
        ['remedy', 'verify'],
      ];
      for (const [at, to] of jobs) {
        job = { stage: at, moved: false };
        const orch = lifetime === 'one orchestrator' ? shared : make();
        expect(await orch.run(CASE)).toEqual({ status: 'stopped', stage: to });
      }

      const events = assertSchemaValid(sink.events(CASE));
      // Every job after the arraign one started with a duplicate the sink dropped.
      expect(dropped).toEqual(['defense', 'prosecution', 'remedy']);
      // openAt stores no events, so the arraign job's own stage-entered is the first stored.
      expect(ofType(events, 'stage-entered').map((e) => e.stage)).toEqual([
        'arraign',
        'defense',
        'prosecution',
        'remedy',
        'verify',
      ]);
      const charged = ofType(events, 'cost-charged');
      const released = ofType(events, 'cost-released');
      expect(charged.map((e) => e.stage)).toEqual(['defense', 'prosecution', 'remedy']);
      expect(charged.every((e) => e.seq < PLACEHOLDER)).toBe(true);
      expect(released.map((e) => e.payload.reservationSeq)).toEqual(charged.map((e) => e.seq));
      expect(released.map((e) => e.payload.reason)).toEqual([
        'reservation-unspent',
        'reservation-unspent',
        'reservation-unspent',
      ]);
      expect([...store.releases(CASE).keys()]).toEqual(charged.map((e) => e.seq));
      // Each release is the reservation less the reported spend, so the stream nets to the spend.
      released.forEach((r, i) => {
        expect(r.payload.cost.usd).toBeCloseTo(TURN_BUDGET.maxUsd - [0.001, 0.002, 0.003][i]!, 9);
        expect(r.seq).toBeGreaterThan(charged[i]!.seq);
      });
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    },
  );

  it('a sink that reports a repeated seq for a real event disables release (fails closed)', async () => {
    const sink = new FakeEventSink();
    const store = new LoggingCaseStore([], { events: sink, juryEnabled: false });
    await openAt(store, CF, BIG_BUDGET, PATH_TO.defense);
    let next = 0;
    let last = -1;
    const lying: ReportingEventSink = {
      emit: async (e) => {
        const seq = next++;
        await sink.emit({ ...e, seq });
        // Reports the previous event's seq for the charge: not above the last one.
        const reported = e.type === 'cost-charged' ? last : seq;
        last = seq;
        return reported;
      },
    };
    const calls: number[] = [];
    const orch = new Orchestrator({
      store,
      sink: lying,
      model: scripted([{ outcome: 'no-submission', cost: spent(0.001) }]),
      handlers: { defense: callingDefense(1) },
      config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
      // Accepts anything, so only the orchestrator's own guard can stop the release.
      settlement: {
        release: (id, refund, seq) => {
          calls.push(seq);
          return store.releaseCharge(id, refund, seq).catch(() => ({
            remainingInputTokens: 0,
            remainingOutputTokens: 0,
            remainingUsd: 0,
            exhausted: false,
          }));
        },
      },
    });
    await orch.run(CASE);
    expect(calls).toEqual([]);
    expect(ofType(assertSchemaValid(sink.events(CASE)), 'cost-released')).toHaveLength(0);
  });
});

describe('a reported cost on a successful call that is not valid is unknown spend', () => {
  it.each([
    ['negative usd', { ...spent(0.01), usd: -0.4 }],
    ['NaN usd', { ...spent(0.01), usd: Number.NaN }],
    ['infinite input tokens', { ...spent(0.01), inputTokens: Number.POSITIVE_INFINITY }],
    ['negative output tokens', { ...spent(0.01), outputTokens: -5 }],
  ])('%s: nothing is released and the whole charge stands', async (_kind, cost) => {
    const { store, events, make } = await setup();
    const seen = { costs: [] as readonly StageCost[] };
    await make(
      { defense: callingDefense(1, seen) },
      scripted([{ outcome: 'no-submission', cost }]),
    ).run(CASE);
    expect(ofType(events(), 'cost-released')).toHaveLength(0);
    expect(store.charges(CASE)).toHaveLength(1);
    expect(seen.costs[0]).toMatchObject({
      inputTokens: TURN_BUDGET.maxInputTokens,
      outputTokens: TURN_BUDGET.maxOutputTokens,
      usd: TURN_BUDGET.maxUsd,
    });
  });

  it('a huge reported field is charged as an overage and overdraws the case', async () => {
    const { store, events, make } = await setup();
    const huge = { ...spent(0.01), inputTokens: 1e15 };
    const out = await make(
      { defense: callingDefense(1) },
      scripted([{ outcome: 'no-submission', cost: huge }]),
    ).run(CASE);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    expect(store.charges(CASE)[1]).toMatchObject({
      inputTokens: 1e15 - TURN_BUDGET.maxInputTokens,
    });
    // Only the fields under the reservation come back, never more than was reserved.
    const released = ofType(events(), 'cost-released');
    expect(released).toHaveLength(1);
    expect(released[0]!.payload.cost.inputTokens).toBe(0);
    expect(released[0]!.payload.cost.usd).toBeLessThanOrEqual(TURN_BUDGET.maxUsd);
    expect(released[0]!.payload.cost.outputTokens).toBeLessThanOrEqual(TURN_BUDGET.maxOutputTokens);
    expect(ofType(events(), 'budget-exhausted')).toHaveLength(1);
  });
});
