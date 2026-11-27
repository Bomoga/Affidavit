import { describe, expect, it } from 'vitest';
import { Dismissal, Verdict, type CaseStage } from '@affidavit/contracts';
import { FakeCaseStore, FakeEventSink, ReplayModel } from '@affidavit/testing';
import { Orchestrator, type ModelTurnResult, type StageHandler } from './orchestrator.js';
import {
  BIG_BUDGET,
  NOW,
  PATH_TO,
  assertSchemaValid,
  makeCaseFile,
  openAt,
  turnCost,
} from './test-support.js';
import { buildVerdict, checkSummary, finalizeVerdict, plainDecimal } from './verdict.js';
import { InMemoryWorkspace } from './workspace.js';

const cf = makeCaseFile();
const low = makeCaseFile({ candidate: { ...cf.candidate, score: 0.2 } });

const asEscalate: StageHandler = {
  run: () =>
    Promise.resolve({
      kind: 'escalate',
      reason: 'no-admissible-witness-above-floor',
      detail: 'x',
    }),
};

const dismiss: StageHandler = {
  async run(ctx) {
    const dismissal = Dismissal.parse({
      schemaVersion: 1,
      candidateId: low.candidate.id,
      reason: 'no-admissible-witness-below-floor',
      detail: 'x',
    });
    await ctx.record('dismissed', { dismissal }, 'defense');
    return { kind: 'advance', next: 'dismissed' };
  },
};

/** Fails the first verdict append, like a store that is briefly down. */
class FlakyAppendStore extends FakeCaseStore {
  failures = 1;
  override appendVerdict(v: Verdict): Promise<void> {
    if (this.failures-- > 0) return Promise.reject(new Error('store down'));
    return super.appendVerdict(v);
  }
}

/** Refuses the first transition to a given stage, like a store applying its own rule. */
class RefusingTransitionStore extends FakeCaseStore {
  failures = 1;
  constructor(private readonly refuse: CaseStage) {
    super({ juryEnabled: false });
  }
  override transition(caseId: Parameters<FakeCaseStore['transition']>[0], to: CaseStage) {
    if (to === this.refuse && this.failures-- > 0) return Promise.reject(new Error('refused'));
    return super.transition(caseId, to);
  }
}

const make = (
  store: FakeCaseStore,
  sink: FakeEventSink,
  handlers: Partial<Record<string, StageHandler>>,
  opts: { model?: ReplayModel; workspace?: InMemoryWorkspace } = {},
) =>
  new Orchestrator({
    store,
    sink,
    model: opts.model ?? new ReplayModel(new Map()),
    handlers,
    config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
  });

const verdictOf = (caseId: typeof cf.id, outcome: Verdict['outcome'], summary = 'earlier') =>
  Verdict.parse({
    schemaVersion: 1,
    caseId,
    outcome,
    exhibits: [],
    ballots: [],
    summary,
    promptVersions: {},
    modelIds: {},
    cost: [],
  });

const written = (sink: FakeEventSink, id = cf.id) =>
  assertSchemaValid(sink.events(id)).filter((e) => e.type === 'verdict-written');

describe('cost formatting in summaries', () => {
  const finalizeWith = (usds: number[]) =>
    finalizeVerdict(
      buildVerdict({
        caseId: cf.id,
        outcome: 'escalated',
        exhibits: [],
        promptVersions: {},
        modelIds: {},
        cost: usds.map((usd, i) => ({
          stage: 'defense',
          attempt: i + 1,
          inputTokens: 1,
          outputTokens: 1,
          usd,
          wallMs: 1,
        })),
      }),
    );

  it.each([7 * 3e-6, 5e-7, 0.1 + 0.2, 1e-10, 1.5e-7, 123456789012345680000, 0, 0.07])(
    'finalizes with usd %s and prints a number that round-trips',
    (usd) => {
      const v = finalizeWith([usd]);
      expect(checkSummary(v)).toEqual([]);
      expect(Number(plainDecimal(usd))).toBe(usd);
      expect(v.summary).not.toMatch(/\de[+-]\d/);
    },
  );

  it('never throws for token count times price combinations', () => {
    const prices = [3e-6, 1.5e-5, 7.5e-7, 1e-6, 0.000003, 2.5e-8, 1e-3 / 3];
    for (let tokens = 1; tokens <= 400; tokens += 7) {
      for (const price of prices) {
        const usd = tokens * price;
        expect(() => finalizeWith([usd, usd + 0.1, usd * 3])).not.toThrow();
      }
    }
  });
});

describe('terminal verdict invariants', () => {
  it('repairs a dismissed case with a NEW instance sharing the workspace', async () => {
    const store = new FlakyAppendStore({ juryEnabled: false });
    await openAt(store, low, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    const workspace = new InMemoryWorkspace();
    await expect(
      make(store, sink, { defense: dismiss }, { workspace }).run(low.id),
    ).rejects.toThrow(/store down/);
    // The transition happened, the verdict write did not.
    expect(await store.stage(low.id)).toBe('dismissed');
    expect(await store.getVerdict(low.id)).toBeNull();

    const out = await make(store, sink, {}, { workspace }).run(low.id);
    expect(out).toEqual({ status: 'terminal', stage: 'dismissed' });
    expect(Verdict.parse(await store.getVerdict(low.id)).outcome).toBe('dismissed');
    expect(written(sink, low.id)).toHaveLength(1);
  });

  it('cannot repair a dismissed case when no Dismissal was stored', async () => {
    const store = new FlakyAppendStore({ juryEnabled: false });
    await openAt(store, low, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    await expect(make(store, sink, { defense: dismiss }).run(low.id)).rejects.toThrow(/store down/);
    await expect(make(store, sink, {}).run(low.id)).rejects.toThrow(/no recorded dismissal/);
    expect(await store.getVerdict(low.id)).toBeNull();
    assertSchemaValid(sink.events(low.id));
  });

  it('leaves no verdict when the store refuses the dismissal transition', async () => {
    const store = new RefusingTransitionStore('dismissed');
    await openAt(store, low, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    await expect(make(store, sink, { defense: dismiss }).run(low.id)).rejects.toThrow(/refused/);
    expect(await store.stage(low.id)).toBe('defense');
    expect(await store.getVerdict(low.id)).toBeNull();
    assertSchemaValid(sink.events(low.id));
  });

  it('never leaves a verdict that conflicts with the final stage after a refused dismissal', async () => {
    const store = new RefusingTransitionStore('dismissed');
    await openAt(store, low, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    const workspace = new InMemoryWorkspace();
    await expect(
      make(store, sink, { defense: dismiss }, { workspace }).run(low.id),
    ).rejects.toThrow(/refused/);
    // The rerun decides differently and escalates; the stored verdict must agree.
    const out = await make(store, sink, { defense: asEscalate }, { workspace }).run(low.id);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    expect(Verdict.parse(await store.getVerdict(low.id)).outcome).toBe('escalated');
    assertSchemaValid(sink.events(low.id));
  });

  it('writes the missing verdict when a terminal escalated case is run again', async () => {
    const store = new FlakyAppendStore({ juryEnabled: false });
    await openAt(store, cf, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    await expect(make(store, sink, { defense: asEscalate }).run(cf.id)).rejects.toThrow(
      /store down/,
    );
    expect(await store.stage(cf.id)).toBe('escalated');
    expect(await store.getVerdict(cf.id)).toBeNull();

    const out = await make(store, sink, {}).run(cf.id);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    expect(Verdict.parse(await store.getVerdict(cf.id)).outcome).toBe('escalated');
    expect(written(sink)).toHaveLength(1);
  });

  it('does not write another verdict when a terminal case with one is run again', async () => {
    const store = new FakeCaseStore({ juryEnabled: false });
    await openAt(store, cf, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    await make(store, sink, { defense: asEscalate }).run(cf.id);
    await make(store, sink, {}).run(cf.id);
    expect(written(sink)).toHaveLength(1);
  });

  it('refuses a dismissed verdict when no dismissal was recorded', async () => {
    const store = new FakeCaseStore({ juryEnabled: false });
    // `low` is below the floor: since CR-3 the store refuses any dismissal at or above it, which
    // would hide the missing-dismissal check this test is about.
    await openAt(store, low, BIG_BUDGET, PATH_TO.prosecution);
    const sink = new FakeEventSink();
    const toDismissed: StageHandler = {
      run: () => Promise.resolve({ kind: 'advance', next: 'dismissed' }),
    };
    await expect(make(store, sink, { prosecution: toDismissed }).run(low.id)).rejects.toThrow(
      /no recorded dismissal/,
    );
    expect(await store.getVerdict(low.id)).toBeNull();
    assertSchemaValid(sink.events(low.id));
  });

  it('throws when a terminal case has a verdict with a different outcome', async () => {
    const store = new FakeCaseStore({ juryEnabled: false });
    await openAt(store, cf, BIG_BUDGET, [...PATH_TO.defense, 'escalated']);
    await store.appendVerdict(verdictOf(cf.id, 'proven-fixed'));
    const sink = new FakeEventSink();
    await expect(make(store, sink, {}).run(cf.id)).rejects.toThrow(
      /already has a proven-fixed verdict/,
    );
    assertSchemaValid(sink.events(cf.id));
  });

  it('refuses to rerun agents for a case that is still in progress but has a verdict', async () => {
    const store = new FakeCaseStore({ juryEnabled: false });
    await openAt(store, cf, BIG_BUDGET, PATH_TO.defense);
    await store.appendVerdict(verdictOf(cf.id, 'dismissed'));
    const sink = new FakeEventSink();
    let ran = false;
    const handler: StageHandler = {
      run: () => {
        ran = true;
        return Promise.resolve({ kind: 'advance', next: 'prosecution' });
      },
    };
    await expect(make(store, sink, { defense: handler }).run(cf.id)).rejects.toThrow(
      /refusing to rerun agents/,
    );
    expect(ran).toBe(false);
    assertSchemaValid(sink.events(cf.id));
  });

  it('survives a cost too small to print without an exponent', async () => {
    const store = new FakeCaseStore({ juryEnabled: false });
    await openAt(store, cf, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    const tiny: ModelTurnResult = { outcome: 'no-submission', cost: turnCost('defense', 5e-7) };
    const handler: StageHandler = {
      async run(ctx) {
        await ctx.runAgent({
          promptId: 'defense',
          promptVersion: '1.0.0',
          model: 'model-a',
          system: 's',
          user: 'u',
          tools: ['submit_witness'],
          outputSchemaRef: 'Witness',
          maxTurns: 1,
          budget: { maxInputTokens: 100, maxOutputTokens: 100, maxUsd: 0.1 },
        });
        return { kind: 'escalate', reason: 'no-admissible-witness-above-floor', detail: 'x' };
      },
    };
    const model = new ReplayModel(new Map());
    model.runTurn = () => Promise.resolve(tiny);
    expect((await make(store, sink, { defense: handler }, { model }).run(cf.id)).stage).toBe(
      'escalated',
    );
    const v = Verdict.parse(await store.getVerdict(cf.id));
    expect(v.cost[0]?.usd).toBe(5e-7);
    expect(v.summary).not.toMatch(/\de-\d/);
    expect(checkSummary(v)).toEqual([]);
    assertSchemaValid(sink.events(cf.id));
  });
});
