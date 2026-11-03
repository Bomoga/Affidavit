import { describe, expect, it } from 'vitest';
import type { CaseStage, ModelTurnResult, StageCost } from './interim/types.js';
import { Orchestrator, type AgentRequest, type StageHandler } from './orchestrator.js';
import { FakeCaseStore, FakeEventSink, FakeModel } from './testing/fakes.js';

const cost = (stage: CaseStage, attempt: number): StageCost => ({
  stage,
  attempt,
  inputTokens: 10,
  outputTokens: 5,
  usd: 0.01,
  wallMs: 1,
});

const req = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  actor: 'defense',
  promptId: 'defense',
  promptVersion: '1.0.0',
  model: 'model-a',
  system: 'static',
  user: 'wrapped',
  tools: ['submit_witness'],
  outputSchemaRef: 'Witness',
  maxTurns: 3,
  budget: { maxInputTokens: 100, maxOutputTokens: 50, maxUsd: 0.1 },
  ...overrides,
});

type Validator = (ref: string, value: unknown) => { ok: true } | { ok: false; errors: string[] };
const hasTemplate: Validator = (ref, value) =>
  typeof value === 'object' && value !== null && 'template' in value
    ? { ok: true }
    : { ok: false, errors: [`${ref}: missing template`] };

function setup(script: ModelTurnResult[]) {
  const log: string[] = [];
  const store = new FakeCaseStore(log, { usd: 10, tokens: 1_000_000 }, 'defense');
  const sink = new FakeEventSink();
  const model = new FakeModel(log, script);
  const results: unknown[] = [];
  const handlers: Record<string, StageHandler> = {
    defense: {
      async run(ctx) {
        results.push(await ctx.runAgentValidated(req()));
        return { kind: 'advance', next: 'prosecution' };
      },
    },
    prosecution: { run: () => Promise.resolve({ kind: 'advance', next: 'remedy' }) },
    remedy: { run: () => Promise.resolve({ kind: 'advance', next: 'verify' }) },
    verify: { run: () => Promise.resolve({ kind: 'advance', next: 'verdict' }) },
  };
  const orch = new Orchestrator({
    store,
    sink,
    model,
    handlers,
    validate: hasTemplate,
    config: { killSwitch: () => false, maxStageAttempts: 2, now: () => 1_700_000_000_000 },
  });
  return { orch, model, sink, store, results };
}

describe('schema validation of agent output', () => {
  it('records output that fails the schema as inadmissible, with the rule', async () => {
    const { orch, sink, results } = setup([
      { outcome: 'submitted', submission: { prose: 'trust me' }, cost: cost('defense', 1) },
    ]);
    await orch.run('c1');

    expect(results[0]).toMatchObject({ outcome: 'inadmissible', rule: 'schema' });
    const ev = sink.events.find((e) => e.type === 'exhibit-inadmissible');
    expect(ev).toBeDefined();
    expect(ev?.payload).toMatchObject({ rule: 'schema', schemaRef: 'Witness' });
    expect(JSON.stringify(ev?.payload)).toContain('missing template');
  });

  it('does not silently retry the model after a schema failure', async () => {
    const { orch, model } = setup([
      { outcome: 'submitted', submission: {}, cost: cost('defense', 1) },
      { outcome: 'submitted', submission: { template: 'sqli' }, cost: cost('defense', 2) },
    ]);
    await orch.run('c1');
    expect(model.requests).toHaveLength(1);
  });

  it('admits a valid submission and passes the value through', async () => {
    const { orch, sink, results } = setup([
      { outcome: 'submitted', submission: { template: 'sqli' }, cost: cost('defense', 1) },
    ]);
    await orch.run('c1');
    expect(results[0]).toMatchObject({ outcome: 'admitted', value: { template: 'sqli' } });
    expect(sink.events.some((e) => e.type === 'exhibit-inadmissible')).toBe(false);
  });

  it('reports no-submission without inventing an exhibit', async () => {
    const { orch, sink, results } = setup([{ outcome: 'no-submission', cost: cost('defense', 1) }]);
    await orch.run('c1');
    expect(results[0]).toMatchObject({ outcome: 'no-submission' });
    expect(sink.events.some((e) => e.type === 'exhibit-inadmissible')).toBe(false);
  });
});

describe('tool allowlist is enforced before any spend', () => {
  it('refuses a request whose tools exceed the role allowlist, without charging or calling the model', async () => {
    const log: string[] = [];
    const store = new FakeCaseStore(log, { usd: 10, tokens: 1_000_000 }, 'defense');
    const model = new FakeModel(log, []);
    const handlers: Record<string, StageHandler> = {
      defense: {
        async run(ctx) {
          await ctx.runAgent(req({ tools: ['submit_patch'] }));
          return { kind: 'advance', next: 'prosecution' };
        },
      },
    };
    const orch = new Orchestrator({
      store,
      sink: new FakeEventSink(),
      model,
      handlers,
      validate: hasTemplate,
      config: { killSwitch: () => false, maxStageAttempts: 1 },
    });
    await expect(orch.run('c1')).rejects.toThrow(/not allowed/);
    expect(model.requests).toHaveLength(0);
    expect(log).toEqual([]);
  });
});
