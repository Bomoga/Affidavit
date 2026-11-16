import { describe, expect, it } from 'vitest';
import { Verdict } from '@affidavit/contracts';
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
import { checkSummary } from './verdict.js';

const cf = makeCaseFile();

const asEscalate: StageHandler = {
  run: () =>
    Promise.resolve({
      kind: 'escalate',
      reason: 'no-admissible-witness-above-floor',
      detail: 'x',
    }),
};

class FlakyStore extends FakeCaseStore {
  failures = 1;
  override appendVerdict(v: Verdict): Promise<void> {
    if (this.failures-- > 0) return Promise.reject(new Error('store down'));
    return super.appendVerdict(v);
  }
}

const make = (
  store: FakeCaseStore,
  sink: FakeEventSink,
  handlers: Partial<Record<string, StageHandler>>,
  model = new ReplayModel(new Map()),
) =>
  new Orchestrator({
    store,
    sink,
    model,
    handlers,
    config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
  });

const verdictOf = (outcome: Verdict['outcome'], summary = 'earlier') =>
  Verdict.parse({
    schemaVersion: 1,
    caseId: cf.id,
    outcome,
    exhibits: [],
    ballots: [],
    summary,
    promptVersions: {},
    modelIds: {},
    cost: [],
  });

const written = (sink: FakeEventSink) =>
  assertSchemaValid(sink.events(cf.id)).filter((e) => e.type === 'verdict-written');

describe('terminal verdict invariants', () => {
  it('writes the missing verdict when a terminal case is run again', async () => {
    const store = new FlakyStore({ juryEnabled: false });
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
    await openAt(store, cf, BIG_BUDGET, PATH_TO.prosecution);
    const sink = new FakeEventSink();
    const toDismissed: StageHandler = {
      run: () => Promise.resolve({ kind: 'advance', next: 'dismissed' }),
    };
    await expect(make(store, sink, { prosecution: toDismissed }).run(cf.id)).rejects.toThrow(
      /no dismissal was recorded/,
    );
    expect(await store.getVerdict(cf.id)).toBeNull();
  });

  it('throws when the case already has a verdict with a different outcome', async () => {
    const store = new FakeCaseStore({ juryEnabled: false });
    await openAt(store, cf, BIG_BUDGET, PATH_TO.defense);
    await store.appendVerdict(verdictOf('proven-fixed'));
    await expect(
      make(store, new FakeEventSink(), { defense: asEscalate }).run(cf.id),
    ).rejects.toThrow(/already has a proven-fixed verdict/);
  });

  it('accepts an existing verdict with the same outcome without writing another', async () => {
    const store = new FakeCaseStore({ juryEnabled: false });
    await openAt(store, cf, BIG_BUDGET, PATH_TO.defense);
    await store.appendVerdict(verdictOf('escalated'));
    const sink = new FakeEventSink();
    expect((await make(store, sink, { defense: asEscalate }).run(cf.id)).stage).toBe('escalated');
    expect((await store.getVerdict(cf.id))?.summary).toBe('earlier');
    expect(written(sink)).toHaveLength(0);
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
    expect((await make(store, sink, { defense: handler }, model).run(cf.id)).stage).toBe(
      'escalated',
    );
    const v = Verdict.parse(await store.getVerdict(cf.id));
    expect(v.cost[0]?.usd).toBe(5e-7);
    expect(v.summary).not.toMatch(/\de-\d/);
    expect(checkSummary(v)).toEqual([]);
  });
});
