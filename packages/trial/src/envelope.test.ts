import { describe, expect, it } from 'vitest';
import type { CaseStage } from '@affidavit/contracts';
import { FakeEventSink, ReplayModel } from '@affidavit/testing';
import { SUBMISSIONS } from './envelope.js';
import {
  ActorMismatchError,
  Orchestrator,
  type AgentRequest,
  type ModelTurnResult,
  type StageHandler,
  type ValidatedAgentResult,
} from './orchestrator.js';
import {
  BIG_BUDGET,
  LoggingCaseStore,
  NOW,
  PATH_TO,
  assertSchemaValid,
  inOrder,
  makeCaseFile,
  openAt,
  turnCost,
} from './test-support.js';

const CF = makeCaseFile();
const CASE = CF.id;

const req = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
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

const submitted = (submission: unknown): ModelTurnResult => ({
  outcome: 'submitted',
  submission,
  cost: turnCost('defense'),
});
const WITNESS = { template: 'witness template', params: [{ name: 'n', values: [1, 2] }] };

const rest = (): Partial<Record<CaseStage, StageHandler>> => ({
  prosecution: { run: () => Promise.resolve({ kind: 'advance', next: 'remedy' }) },
  remedy: { run: () => Promise.resolve({ kind: 'advance', next: 'verify' }) },
  verify: { run: () => Promise.resolve({ kind: 'advance', next: 'jury' }) },
  jury: { run: () => Promise.resolve({ kind: 'advance', next: 'verdict' }) },
});

async function setup(defense: StageHandler, script: ModelTurnResult[] = []) {
  const log: string[] = [];
  const store = new LoggingCaseStore(log);
  await openAt(store, CF, BIG_BUDGET, PATH_TO.defense);
  const sink = new FakeEventSink();
  const model = new ReplayModel(inOrder(script));
  const orch = new Orchestrator({
    store,
    sink,
    model,
    handlers: { defense, ...rest() },
    config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
  });
  return { orch, store, sink, model, log, events: () => assertSchemaValid(sink.events(CASE)) };
}

function capture(r: AgentRequest = req()) {
  const results: ValidatedAgentResult<unknown>[] = [];
  const handler: StageHandler = {
    async run(ctx) {
      results.push(await ctx.runAgentValidated(r, SUBMISSIONS.defense));
      return { kind: 'advance', next: 'prosecution' };
    },
  };
  return { handler, results };
}

describe('schema validation of agent output against contract schemas', () => {
  it('records output that fails the schema as exhibit-inadmissible with rule schema', async () => {
    const { handler, results } = capture();
    const { orch, events } = await setup(handler, [submitted({ prose: 'trust me' })]);
    await orch.run(CASE);

    expect(results[0]).toMatchObject({ outcome: 'inadmissible', rule: 'schema' });
    const ev = events().find((e) => e.type === 'exhibit-inadmissible');
    expect(ev?.actor).toBe('judge');
    expect(ev?.payload).toEqual({
      exhibitId: (results[0] as { exhibitId: string }).exhibitId,
      rejectedBy: 'schema',
    });
    expect(ev?.payload.exhibitId).toMatch(/^exhibit-witness-rejected-[0-9a-f]{24}$/);
  });

  it('rejects a witness whose params are not a contract ParamSpace', async () => {
    const { handler, results } = capture();
    const { orch } = await setup(handler, [submitted({ template: 'x', params: { n: 1 } })]);
    await orch.run(CASE);
    expect(results[0]?.outcome).toBe('inadmissible');
    expect(JSON.stringify(results[0])).toContain('params');
  });

  it('does not silently retry the model after a schema failure', async () => {
    const { handler } = capture();
    const { orch, model } = await setup(handler, [submitted({}), submitted(WITNESS)]);
    await orch.run(CASE);
    expect(model.requests).toHaveLength(1);
  });

  it('admits a valid submission and strips fields the agent may not set', async () => {
    const { handler, results } = capture();
    const { orch, events } = await setup(handler, [
      submitted({ ...WITNESS, id: 'chosen-by-agent', sha256: 'f'.repeat(64), passed: true }),
    ]);
    await orch.run(CASE);
    expect(results[0]).toMatchObject({ outcome: 'admitted', value: WITNESS });
    expect((results[0] as { value: object }).value).toEqual(WITNESS);
    expect(events().some((e) => e.type === 'exhibit-inadmissible')).toBe(false);
  });

  it('reports no-submission without inventing an exhibit', async () => {
    const { handler, results } = capture();
    const { orch, events } = await setup(handler, [
      { outcome: 'no-submission', cost: turnCost('defense') },
    ]);
    await orch.run(CASE);
    expect(results[0]).toMatchObject({ outcome: 'no-submission' });
    expect(events().some((e) => e.type === 'exhibit-inadmissible')).toBe(false);
  });

  it('validates ballots against the contract Ballot, with juror identity left to code', () => {
    const ok = SUBMISSIONS.juror.check({
      question: 'severity',
      vote: 'high',
      confidence: 0.5,
      citedExhibits: ['exhibit-witness-001'],
    });
    expect(ok.ok).toBe(true);
    expect(
      SUBMISSIONS.juror.check({
        question: 'did-the-test-pass',
        vote: 'yes',
        confidence: 1,
        citedExhibits: ['e'],
      }).ok,
    ).toBe(false);
    expect(
      SUBMISSIONS.juror.check({
        question: 'severity',
        vote: 'high',
        confidence: 1,
        citedExhibits: [],
      }).ok,
    ).toBe(false);
  });
});

describe('actor comes from the stage', () => {
  it('derives the actor from the stage when the handler names none', async () => {
    const { handler } = capture(req());
    const { orch, events } = await setup(handler, [submitted(WITNESS)]);
    await orch.run(CASE);
    expect(events().find((e) => e.type === 'cost-charged')?.actor).toBe('defense');
  });

  it('refuses a handler-supplied actor that does not match the stage, before any spend', async () => {
    const { handler } = capture(req({ actor: 'remedy' }));
    const { orch, model, log } = await setup(handler, [submitted(WITNESS)]);
    await expect(orch.run(CASE)).rejects.toBeInstanceOf(ActorMismatchError);
    expect(model.requests).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it('refuses a submission spec for another role', async () => {
    const handler: StageHandler = {
      async run(ctx) {
        await ctx.runAgentValidated(
          req({ tools: ['submit_patch'], outputSchemaRef: 'Exhibit' }),
          SUBMISSIONS.remedy,
        );
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const { orch, model } = await setup(handler);
    await expect(orch.run(CASE)).rejects.toBeInstanceOf(ActorMismatchError);
    expect(model.requests).toHaveLength(0);
  });

  it('refuses a prompt whose output schema does not match the role', async () => {
    const { handler } = capture(req({ outputSchemaRef: 'Ballot' }));
    const { orch, model } = await setup(handler);
    await expect(orch.run(CASE)).rejects.toThrow(/does not match/);
    expect(model.requests).toHaveLength(0);
  });
});

describe('tool allowlist is enforced before any spend', () => {
  it('refuses tools outside the role allowlist, without charging or calling the model', async () => {
    const handler: StageHandler = {
      async run(ctx) {
        await ctx.runAgent(req({ tools: ['submit_patch'] }));
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const { orch, model, log } = await setup(handler);
    await expect(orch.run(CASE)).rejects.toThrow(/not allowed/);
    expect(model.requests).toHaveLength(0);
    expect(log).toEqual([]);
  });
});
