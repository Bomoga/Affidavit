import { describe, expect, it } from 'vitest';
import { IllegalTransitionError, type CaseStage, type ModelPort } from '@affidavit/contracts';
import { FakeEventSink, ReplayModel, recordingKey } from '@affidavit/testing';
import {
  BudgetExhaustedError,
  EscalationNotAllowedError,
  Orchestrator,
  RetryStageError,
  type AgentRequest,
  type ModelTurnResult,
  type StageHandler,
} from './orchestrator.js';
import {
  BIG_BUDGET,
  LoggingCaseStore,
  NOW,
  assertSchemaValid,
  makeCaseFile,
  turnCost,
} from './test-support.js';

const CF = makeCaseFile();
const CASE = CF.id;
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

const agentReq = (user: string, overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  actor: 'defense',
  promptId: 'defense',
  promptVersion: '1.0.0',
  model: 'model-a',
  system: 'static system text',
  user,
  tools: ['submit_witness'],
  outputSchemaRef: 'Witness',
  maxTurns: 4,
  budget: { maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: 0.25 },
  ...overrides,
});

const submitted: ModelTurnResult = {
  outcome: 'submitted',
  submission: { ok: true },
  cost: turnCost('defense', 0.05),
};

function passThrough(): Partial<Record<CaseStage, StageHandler>> {
  const handlers: Partial<Record<CaseStage, StageHandler>> = {};
  ORDER.forEach((stage, i) => {
    const next: CaseStage = i === ORDER.length - 1 ? 'verdict' : ORDER[i + 1]!;
    handlers[stage] = { run: () => Promise.resolve({ kind: 'advance', next }) };
  });
  return handlers;
}

/** Recordings keyed the way ReplayModel looks them up, one per user text. */
function recordings(entries: Record<string, ModelTurnResult>): Map<string, ModelTurnResult> {
  return new Map(
    Object.entries(entries).map(([user, r]) => [recordingKey('defense', '1.0.0', user), r]),
  );
}

async function setup(
  opts: {
    usd?: number;
    recorded?: Record<string, ModelTurnResult>;
    killed?: () => boolean;
  } = {},
) {
  const log: string[] = [];
  const store = new LoggingCaseStore(log);
  await store.open(CF, { ...BIG_BUDGET, maxUsd: opts.usd ?? 10 });
  const sink = new FakeEventSink();
  const replay = new ReplayModel(recordings(opts.recorded ?? {}));
  const model: ModelPort = {
    runTurn: (req) => {
      log.push(`model:${req.user}`);
      return replay.runTurn(req);
    },
  };
  const killed = opts.killed ?? ((): boolean => false);
  const make = (handlers: Partial<Record<CaseStage, StageHandler>>): Orchestrator =>
    new Orchestrator({
      store,
      sink,
      model,
      handlers,
      config: { killSwitch: () => killed(), maxStageAttempts: 3, now: () => NOW },
    });
  return { log, store, sink, replay, make, events: () => assertSchemaValid(sink.events(CASE)) };
}

describe('Orchestrator stage loop', () => {
  it('moves a case through every stage with fakes and emits schema-valid events', async () => {
    const { store, events, make } = await setup();
    const out = await make(passThrough()).run(CASE);

    expect(out).toEqual({ status: 'terminal', stage: 'verdict' });
    expect(await store.stage(CASE)).toBe('verdict');

    const evs = events();
    const entered = evs.filter((e) => e.type === 'stage-entered');
    expect(entered.map((e) => e.stage)).toEqual([...ORDER, 'verdict']);
    expect(entered[0]?.payload).toEqual({});
    expect(entered[1]?.payload).toEqual({ from: 'intake' });
    const exited = evs.flatMap((e) => (e.type === 'stage-exited' ? [e.payload.to] : []));
    expect(exited).toEqual([...ORDER.slice(1), 'verdict']);
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i));
    expect(evs.every((e) => e.schemaVersion === 1)).toBe(true);
  });

  it('attributes deterministic stages to the stenographer and verify to the judge', async () => {
    const { events, make } = await setup();
    await make(passThrough()).run(CASE);
    const actorOf = (s: CaseStage) => events().find((e) => e.stage === s)?.actor;
    expect(actorOf('intake')).toBe('stenographer');
    expect(actorOf('defense')).toBe('defense');
    expect(actorOf('verify')).toBe('judge');
    expect(actorOf('jury')).toBe('juror');
  });

  it('throws when a stage has no handler', async () => {
    const { make } = await setup();
    const handlers = passThrough();
    delete handlers.map;
    await expect(make(handlers).run(CASE)).rejects.toThrow(/no handler.*map/i);
  });

  it('surfaces an illegal transition from the store instead of swallowing it', async () => {
    const { make } = await setup();
    const handlers = passThrough();
    handlers.intake = { run: () => Promise.resolve({ kind: 'advance', next: 'verdict' }) };
    await expect(make(handlers).run(CASE)).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('records an escalation returned by a handler with a contract Escalation', async () => {
    const { store, events, make } = await setup();
    const handlers = passThrough();
    handlers.defense = {
      run: () =>
        Promise.resolve({
          kind: 'escalate',
          reason: 'no-admissible-witness-above-floor',
          detail: 'second attempt failed',
        }),
    };
    const out = await make(handlers).run(CASE);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    expect(await store.stage(CASE)).toBe('escalated');
    const esc = events().find((e) => e.type === 'escalated');
    expect(esc?.stage).toBe('defense');
    expect(esc?.payload).toEqual({
      escalation: {
        schemaVersion: 1,
        caseId: CASE,
        reason: 'no-admissible-witness-above-floor',
        detail: 'second attempt failed',
      },
    });
    expect(events().some((e) => e.type === 'budget-exhausted')).toBe(false);
  });

  it.each(['intake', 'map', 'arraign'] as const)(
    'refuses to escalate from %s, which has no legal route to escalated',
    async (stage) => {
      const { store, events, make } = await setup();
      const handlers = passThrough();
      handlers[stage] = {
        run: () => Promise.resolve({ kind: 'escalate', reason: 'budget-exhausted', detail: 'x' }),
      };
      await expect(make(handlers).run(CASE)).rejects.toBeInstanceOf(EscalationNotAllowedError);
      expect(await store.stage(CASE)).toBe(stage);
      expect(events().some((e) => e.type === 'escalated')).toBe(false);
    },
  );

  it('refuses a model call from a stage that never calls a model', async () => {
    const { log, make } = await setup();
    const handlers = passThrough();
    handlers.intake = {
      async run(ctx) {
        await ctx.runAgent(agentReq('u'));
        return { kind: 'advance', next: 'map' };
      },
    };
    await expect(make(handlers).run(CASE)).rejects.toThrow(/never calls a model/);
    expect(log).toEqual([]);
  });
});

describe('retries are charged before the agent runs', () => {
  it('charges attempt 2 before the model is called for attempt 2', async () => {
    const { log, make } = await setup({
      recorded: {
        'attempt 1': { outcome: 'no-submission', cost: turnCost('defense') },
        'attempt 2': submitted,
      },
    });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        const res = await ctx.runAgent(agentReq(`attempt ${ctx.attempt}`));
        if (res.outcome !== 'submitted') throw new RetryStageError('no submission');
        return { kind: 'advance', next: 'prosecution' };
      },
    };

    const out = await make(handlers).run(CASE);
    expect(out.stage).toBe('verdict');
    expect(log).toEqual([
      'charge:defense:1',
      'model:attempt 1',
      'charge:defense:2',
      'model:attempt 2',
    ]);
  });

  it('charges the turn budget up front and records what the call actually cost', async () => {
    const { store, events, make } = await setup({ recorded: { u: submitted } });
    const handlers = passThrough();
    let seen: readonly unknown[] = [];
    handlers.defense = {
      async run(ctx) {
        await ctx.runAgent(agentReq('u'));
        seen = ctx.costs();
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    await make(handlers).run(CASE);
    expect(store.charges(CASE)).toEqual([
      { stage: 'defense', attempt: 1, inputTokens: 1000, outputTokens: 500, usd: 0.25, wallMs: 0 },
    ]);
    expect(seen).toEqual([{ ...turnCost('defense', 0.05), attempt: 1 }]);
    const charged = events().find((e) => e.type === 'cost-charged');
    expect(charged?.payload).toMatchObject({
      cost: { usd: 0.25 },
      remaining: { remainingUsd: 9.75, exhausted: false },
    });
  });

  it('does not retry forever: rethrows after the attempt cap', async () => {
    const { make } = await setup();
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
    const { store, events, replay, make } = await setup({ usd: 0.1 });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        await ctx.runAgent(agentReq('u')); // charges 0.25 against a 0.10 budget
        return { kind: 'advance', next: 'prosecution' };
      },
    };

    const out = await make(handlers).run(CASE);
    expect(out).toEqual({ status: 'terminal', stage: 'escalated' });
    expect(replay.requests).toHaveLength(0);
    expect(await store.stage(CASE)).toBe('escalated');
    const evs = events();
    const exhausted = evs.find((e) => e.type === 'budget-exhausted');
    expect(exhausted?.payload).toMatchObject({
      escalation: { caseId: CASE, reason: 'budget-exhausted' },
    });
    expect(evs.find((e) => e.type === 'escalated')?.payload).toMatchObject({
      escalation: { reason: 'budget-exhausted' },
    });
  });

  it('treats a model-reported budget exhaustion the same way', async () => {
    const { store, events, make } = await setup({
      recorded: { u: { outcome: 'budget-exhausted', cost: turnCost('defense') } },
    });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        await ctx.runAgent(agentReq('u'));
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const out = await make(handlers).run(CASE);
    expect(out.stage).toBe('escalated');
    expect(await store.stage(CASE)).toBe('escalated');
    expect(events().some((e) => e.type === 'budget-exhausted')).toBe(true);
  });

  it('charges an overspend on top of the up-front charge', async () => {
    const { store, make } = await setup({
      recorded: { u: { ...submitted, cost: { ...turnCost('defense'), usd: 0.3 } } },
    });
    const handlers = passThrough();
    handlers.defense = {
      async run(ctx) {
        await ctx.runAgent(agentReq('u'));
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    await make(handlers).run(CASE);
    expect(store.charges(CASE).map((c) => c.usd)).toEqual([0.25, 0.05]);
  });

  it('exports a typed error for handlers that need to signal exhaustion themselves', () => {
    expect(new BudgetExhaustedError('x').detail).toBe('x');
  });
});

describe('global kill switch', () => {
  it('halts before the first stage with reason kill-switch, not an escalation', async () => {
    const { store, events, replay, make } = await setup({ killed: () => true });
    const out = await make(passThrough()).run(CASE);
    expect(out).toEqual({ status: 'halted', stage: 'intake', reason: 'kill-switch' });
    expect(replay.requests).toHaveLength(0);
    expect(await store.stage(CASE)).toBe('intake');
    const types = events().map((e) => e.type);
    expect(types).not.toContain('escalated');
    expect(types).not.toContain('budget-exhausted');
  });

  it('halts before the model call when tripped mid-stage and leaves the case resumable', async () => {
    let tripped = false;
    const { store, replay, make } = await setup({
      killed: () => tripped,
      recorded: { u: submitted },
    });
    const handlers = passThrough();
    let calls = 0;
    handlers.defense = {
      async run(ctx) {
        calls++;
        if (calls === 1) tripped = true;
        await ctx.runAgent(agentReq('u'));
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const orch = make(handlers);
    const out = await orch.run(CASE);
    expect(out).toEqual({ status: 'halted', stage: 'defense', reason: 'kill-switch' });
    expect(replay.requests).toHaveLength(0);
    expect(await store.stage(CASE)).toBe('defense');

    tripped = false;
    expect(await orch.run(CASE)).toEqual({ status: 'terminal', stage: 'verdict' });
    expect(replay.requests).toHaveLength(1);
  });
});
