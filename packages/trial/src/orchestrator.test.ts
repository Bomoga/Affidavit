import { describe, expect, it } from 'vitest';
import type { CaseStage, ModelTurnResult, StageCost } from './interim/types.js';
import {
  BudgetExhaustedError,
  Orchestrator,
  RetryStageError,
  type AgentRequest,
  type StageHandler,
} from './orchestrator.js';
import { FakeCaseStore, FakeEventSink, FakeModel } from './testing/fakes.js';

const CASE = 'case-1';
const ORDER: CaseStage[] = [
  'intake',
  'map',
  'arraign',
  'defense',
  'prosecution',
  'remedy',
  'verify',
  'jury',
];

const cost = (stage: CaseStage, attempt: number, usd = 0.05): StageCost => ({
  stage,
  attempt,
  inputTokens: 100,
  outputTokens: 50,
  usd,
  wallMs: 10,
});

const submitted = (stage: CaseStage, attempt: number): ModelTurnResult => ({
  outcome: 'submitted',
  submission: { ok: true },
  cost: cost(stage, attempt),
});

const agentReq = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  actor: 'defense',
  promptId: 'defense',
  promptVersion: '1.0.0',
  model: 'model-a',
  system: 'static system text',
  user: 'wrapped untrusted data',
  tools: ['submit_witness'],
  outputSchemaRef: 'Witness',
  maxTurns: 4,
  budget: { maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: 0.25 },
  ...overrides,
});

function passThrough(): Record<string, StageHandler> {
  const handlers: Record<string, StageHandler> = {};
  ORDER.forEach((stage, i) => {
    const next: CaseStage = i === ORDER.length - 1 ? 'verdict' : ORDER[i + 1]!;
    handlers[stage] = { run: () => Promise.resolve({ kind: 'advance', next }) };
  });
  return handlers;
}

function setup(opts: { usd?: number; script?: ModelTurnResult[]; killed?: () => boolean } = {}) {
  const log: string[] = [];
  const store = new FakeCaseStore(log, { usd: opts.usd ?? 10, tokens: 1_000_000 });
  const sink = new FakeEventSink();
  const model = new FakeModel(log, opts.script ?? []);
  const killed = opts.killed ?? ((): boolean => false);
  const make = (handlers: Record<string, StageHandler>): Orchestrator =>
    new Orchestrator({
      store,
      sink,
      model,
      handlers,
      config: { killSwitch: () => killed(), maxStageAttempts: 3, now: () => 1_700_000_000_000 },
    });
  return { log, store, sink, model, make };
}

describe('Orchestrator stage loop', () => {
  it('moves a case through every stage with fakes', async () => {
    const { store, sink, make } = setup();
    const final = await make(passThrough()).run(CASE);

    expect(final).toBe('verdict');
    expect(store.transitions).toEqual([...ORDER.slice(1), 'verdict']);

    const entered = sink.events.filter((e) => e.type === 'stage-entered').map((e) => e.stage);
    expect(entered).toEqual(ORDER);
    const seqs = sink.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('throws when a stage has no handler', async () => {
    const { make } = setup();
    const handlers = passThrough();
    delete handlers.map;
    await expect(make(handlers).run(CASE)).rejects.toThrow(/no handler.*map/i);
  });

  it('surfaces an illegal transition instead of swallowing it', async () => {
    const { make } = setup();
    const handlers = passThrough();
    handlers.intake = { run: () => Promise.resolve({ kind: 'advance', next: 'verdict' }) };
    await expect(make(handlers).run(CASE)).rejects.toThrow(/illegal transition/);
  });

  it('records an escalation returned by a handler', async () => {
    const { store, make } = setup();
    const handlers = passThrough();
    handlers.defense = {
      run: () =>
        Promise.resolve({
          kind: 'escalate',
          reason: 'no-admissible-witness-above-floor',
          detail: 'second attempt failed',
        }),
    };
    const final = await make(handlers).run(CASE);
    expect(final).toBe('escalated');
    expect(store.escalations).toEqual([
      {
        caseId: CASE,
        reason: 'no-admissible-witness-above-floor',
        detail: 'second attempt failed',
      },
    ]);
  });
});

describe('retries are charged before the agent runs', () => {
  it('charges attempt 2 before the model is called for attempt 2', async () => {
    const { log, make } = setup({
      script: [{ outcome: 'no-submission', cost: cost('defense', 1) }, submitted('defense', 2)],
    });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        const res = await ctx.runAgent(agentReq());
        if (res.outcome !== 'submitted') throw new RetryStageError('no submission');
        return { kind: 'advance', next: 'prosecution' };
      },
    };

    const final = await make(handlers).run(CASE);
    expect(final).toBe('verdict');
    expect(log.filter((l) => /^(charge|model|settle):defense/.test(l))).toEqual([
      'charge:defense:1',
      'model:defense:1',
      'settle:defense:1',
      'charge:defense:2',
      'model:defense:2',
      'settle:defense:2',
    ]);
  });

  it('settles the reservation with what the call actually cost', async () => {
    const { store, make } = setup({ script: [submitted('defense', 1)] });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        await ctx.runAgent(agentReq());
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    await make(handlers).run(CASE);
    expect(store.settled).toEqual([cost('defense', 1)]);
  });

  it('does not retry forever: rethrows after the attempt cap', async () => {
    const { make } = setup();
    const handlers = passThrough();
    let calls = 0;
    handlers.defense = {
      run: () => {
        calls++;
        return Promise.reject(new RetryStageError('always failing'));
      },
    };
    await expect(make(handlers).run(CASE)).rejects.toThrow(/always failing/);
    expect(calls).toBe(3);
  });
});

describe('budgets', () => {
  it('ends the stage with budget-exhausted and an Escalation, without calling the model', async () => {
    const { store, sink, model, make } = setup({ usd: 0.1 });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        await ctx.runAgent(agentReq()); // reserves 0.25 against a 0.10 budget
        return { kind: 'advance', next: 'prosecution' };
      },
    };

    const final = await make(handlers).run(CASE);
    expect(final).toBe('escalated');
    expect(model.requests).toHaveLength(0);
    expect(store.escalations).toHaveLength(1);
    expect(store.escalations[0]).toMatchObject({ caseId: CASE, reason: 'budget-exhausted' });
    expect(sink.events.some((e) => e.type === 'budget-exhausted')).toBe(true);
    expect(sink.events.some((e) => e.type === 'escalated')).toBe(true);
  });

  it('treats a model-reported budget exhaustion the same way', async () => {
    const { store, make } = setup({
      script: [{ outcome: 'budget-exhausted', cost: cost('defense', 1) }],
    });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        await ctx.runAgent(agentReq());
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const final = await make(handlers).run(CASE);
    expect(final).toBe('escalated');
    expect(store.escalations[0]?.reason).toBe('budget-exhausted');
  });

  it('exports a typed error for handlers that need to signal exhaustion themselves', () => {
    expect(new BudgetExhaustedError('x').detail).toBe('x');
  });
});

describe('global kill switch', () => {
  it('escalates before the first stage when already tripped', async () => {
    const { store, model, make } = setup({ killed: () => true });
    const final = await make(passThrough()).run(CASE);
    expect(final).toBe('escalated');
    expect(model.requests).toHaveLength(0);
    expect(store.escalations[0]).toMatchObject({ reason: 'budget-exhausted' });
    expect(store.escalations[0]?.detail).toMatch(/kill switch/i);
  });

  it('stops before the model call when tripped mid-stage', async () => {
    let tripped = false;
    const { model, make } = setup({ killed: () => tripped });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        tripped = true;
        await ctx.runAgent(agentReq());
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const final = await make(handlers).run(CASE);
    expect(final).toBe('escalated');
    expect(model.requests).toHaveLength(0);
  });
});
