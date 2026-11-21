// L3-16: a provider failure must be diagnosable from the error alone, without leaking the key,
// credential-shaped text, or case content, and a failed call must not be charged the turn cap
// when the runtime reported what it actually spent. Every test uses a stubbed transport.
import { describe, expect, it } from 'vitest';
import { type StageCost } from '@affidavit/contracts';
import { FakeEventSink } from '@affidavit/testing';
import { Orchestrator, type BudgetSettlement, type StageHandler } from '../orchestrator.js';
import {
  BIG_BUDGET,
  LoggingCaseStore,
  NOW,
  PATH_TO,
  assertSchemaValid,
  makeCaseFile,
  openAt,
} from '../test-support.js';
import { AnthropicModelPort, PROVIDER_MESSAGE_MAX, type ModelLogEntry } from './anthropic.js';
import { ModelCallError, ModelUnconfiguredError } from './errors.js';
import { DEFAULT_MODEL_TABLE } from './models.js';
import {
  CANARY_KEY,
  assistant,
  requestFor,
  result,
  stubTransport,
  type Script,
} from './test-stubs.js';

function makePort(script: Script, key: string | undefined = CANARY_KEY, timeoutMs = 5_000) {
  const stub = stubTransport(script);
  const logs: ModelLogEntry[] = [];
  const port = new AnthropicModelPort({
    mode: 'live',
    modelTable: DEFAULT_MODEL_TABLE,
    timeoutMs,
    transport: stub.transport,
    env: () => ({ ANTHROPIC_API_KEY: key, PATH: '/usr/bin' }),
    log: (e) => logs.push(e),
  });
  return { port, stub, logs };
}

/** What the runtime yields for an API error: a synthetic assistant message, then a result. */
function apiError(text: string, opts: { status?: number; resultText?: string } = {}): Script {
  return async function* () {
    await Promise.resolve();
    yield assistant('m1', 0, 0, 'invalid_request', text);
    yield result('success', {
      isError: true,
      usd: 0,
      input: 0,
      output: 0,
      text: opts.resultText ?? text,
      ...(opts.status === undefined ? {} : { apiErrorStatus: opts.status }),
    });
  };
}

const PROVIDER_400 =
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.custom.input_schema: JSON schema is invalid"}}';

async function failure(port: AnthropicModelPort, user?: string): Promise<ModelCallError> {
  const err = await port.runTurn(requestFor('defense', user)).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelCallError);
  return err as ModelCallError;
}

describe('provider error detail', () => {
  it('carries the HTTP status, the error class and the provider message', async () => {
    const { port, logs } = makePort(apiError(PROVIDER_400, { status: 400 }));
    const err = await failure(port);
    expect(err.message).toContain('provider error invalid_request');
    expect(err.message).toContain('HTTP 400');
    expect(err.message).toContain('invalid_request_error');
    expect(err.message).toContain('tools.0.custom.input_schema: JSON schema is invalid');
    expect(err.provider).toEqual({
      errorClass: 'invalid_request',
      status: 400,
      message: PROVIDER_400,
    });
    // The same line reaches the port log, so a worker that logs either sees the cause.
    expect(
      logs.some((l) => l.level === 'warn' && l.message.includes('JSON schema is invalid')),
    ).toBe(true);
  });

  it('falls back to the result text when the assistant message has none', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield assistant('m1', 0, 0, 'invalid_request');
      yield result('success', { isError: true, usd: 0, text: PROVIDER_400, apiErrorStatus: 400 });
    });
    const err = await failure(port);
    expect(err.provider?.message).toBe(PROVIDER_400);
    expect(err.provider?.status).toBe(400);
  });

  it('redacts a key-shaped value and the real key in the provider message', async () => {
    const text = `Invalid X-Api-Key header value: sk-ant-FAKE-abcdef0123456789. Was ${CANARY_KEY}`;
    const { port, logs } = makePort(apiError(text, { status: 400 }));
    const err = await failure(port);
    const all = [err.message, JSON.stringify(err.provider), ...logs.map((l) => l.message)].join(
      '\n',
    );
    expect(all).not.toContain('sk-ant-FAKE');
    expect(all).not.toContain('FAKE-abcdef');
    expect(all).not.toContain('CANARY');
    expect(all).toContain('[redacted]');
    expect(all).toContain('Invalid X-Api-Key header value');
  });

  it('redacts before clipping, so a key across the clip leaves no fragment', async () => {
    for (let pad = PROVIDER_MESSAGE_MAX - 40; pad <= PROVIDER_MESSAGE_MAX + 5; pad += 5) {
      const text = `${'e'.repeat(pad)} sk-ant-FAKE-0123456789abcdefghijklmnop tail`;
      const { port } = makePort(apiError(text));
      const err = await failure(port);
      expect(err.message, `pad ${pad}`).not.toMatch(/sk-ant|FAKE|0123456789abc/);
    }
  });

  it('clips a long provider message to the limit, on one line', async () => {
    const text = `API Error: 400\n${'x'.repeat(2_000)}\r\nend`;
    const { port } = makePort(apiError(text));
    const err = await failure(port);
    const message = err.provider!.message!;
    expect(message.length).toBe(PROVIDER_MESSAGE_MAX + 3);
    expect(message.endsWith('...')).toBe(true);
    expect(message).not.toMatch(/[\r\n]/);
  });

  it('withholds a provider message that quotes case content from the user message', async () => {
    const caseText = 'db.query("SELECT * FROM users WHERE id=" + req.query.id) // vulnerable';
    const text = `API Error: 400 messages.0.content.0.text: unexpected ${caseText.slice(0, 40)}`;
    const { port } = makePort(apiError(text, { status: 400 }));
    const err = await failure(port, caseText);
    expect(err.message).not.toContain('SELECT * FROM users');
    expect(err.message).toContain('withheld');
    expect(err.message).toContain('HTTP 400');
  });

  it('never echoes a status that is not an integer or an error class outside the closed set', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield assistant('m1', 0, 0, `x-api-key: ${CANARY_KEY}`);
      yield result('success', { isError: false, usd: 0 });
    });
    const err = await failure(port);
    expect(err.message).toBe('agent turn failed: provider error unrecognised');
  });
});

describe('API key shape', () => {
  for (const [kind, key] of [
    ['trailing newline', `${CANARY_KEY}\n`],
    ['trailing CR', `${CANARY_KEY}\r`],
    ['inner space', `${CANARY_KEY.slice(0, 10)} ${CANARY_KEY.slice(10)}`],
    ['smart quotes', `“${CANARY_KEY}”`],
  ] as const) {
    it(`a key with a ${kind} is refused before any call, naming no value`, async () => {
      const { port, stub } = makePort(apiError(PROVIDER_400), key);
      const err = await port.preflight(requestFor('defense')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelUnconfiguredError);
      expect((err as Error).message).not.toContain('CANARY');
      expect(stub.calls).toHaveLength(0);
    });
  }
});

describe('what a failed call costs', () => {
  it('a provider refusal with a zero-cost result reports a zero cost, not the cap', async () => {
    const { port } = makePort(apiError(PROVIDER_400, { status: 400 }));
    const err = await failure(port);
    expect(err.cost).toMatchObject({ inputTokens: 0, outputTokens: 0, usd: 0 });
  });

  it('a provider refusal with no result and no tokens is zero, not the cap', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield assistant('m1', 0, 0, 'invalid_request', PROVIDER_400);
    });
    const err = await failure(port);
    expect(err.cost?.usd).toBe(0);
  });

  it('a failure with reported usage reports that usage', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield assistant('m1', 300, 20);
      yield result('error_during_execution', { usd: 0.042, input: 300, output: 20 });
    });
    const err = await failure(port);
    expect(err.cost).toMatchObject({ inputTokens: 300, outputTokens: 20, usd: 0.042 });
  });

  it('a timeout reports no cost, so the whole up-front charge stands', async () => {
    const { port } = makePort(
      async function* (h) {
        yield assistant('m1', 1, 1);
        await new Promise<void>((resolve) => {
          h.options.abortController!.signal.addEventListener('abort', () => resolve());
        });
      },
      CANARY_KEY,
      20,
    );
    const err = await failure(port);
    expect(err.cost).toBeUndefined();
  });
});

describe('settling the up-front charge in a trial', () => {
  async function runFailingDefense(
    script: Script,
    settlement?: BudgetSettlement,
    timeoutMs = 5_000,
  ) {
    const cf = makeCaseFile();
    const store = new LoggingCaseStore([]);
    await openAt(store, cf, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    const { port } = makePort(script, CANARY_KEY, timeoutMs);
    let ledger: readonly StageCost[] = [];
    const defense: StageHandler = {
      async run(ctx) {
        try {
          await ctx.runAgent({ ...requestFor('defense'), actor: 'defense' });
        } finally {
          ledger = ctx.costs();
        }
        return { kind: 'advance', next: 'prosecution' };
      },
    };
    const orch = new Orchestrator({
      store,
      sink,
      model: port,
      handlers: { defense },
      config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
      ...(settlement === undefined ? {} : { settlement }),
    });
    await expect(orch.run(cf.id)).rejects.toBeInstanceOf(ModelCallError);
    const events = assertSchemaValid(sink.events(cf.id));
    return { cf, store, events, ledger };
  }

  function recorder(): BudgetSettlement & {
    calls: { refund: StageCost; seq: number }[];
  } {
    const calls: { refund: StageCost; seq: number }[] = [];
    return {
      calls,
      release(_caseId, refund, seq) {
        calls.push({ refund, seq });
        return Promise.resolve({
          remainingInputTokens: 0,
          remainingOutputTokens: 0,
          remainingUsd: 0,
          exhausted: false,
        });
      },
    };
  }

  it('gives back the whole charge for a refused call, keyed by the charge event', async () => {
    const settlement = recorder();
    const { events, ledger } = await runFailingDefense(
      apiError(PROVIDER_400, { status: 400 }),
      settlement,
    );
    const charged = events.filter((e) => e.type === 'cost-charged');
    expect(charged).toHaveLength(1);
    const reservation = (charged[0]!.payload as { cost: StageCost }).cost;
    expect(settlement.calls).toHaveLength(1);
    expect(settlement.calls[0]!.seq).toBe(charged[0]!.seq);
    expect(settlement.calls[0]!.refund).toMatchObject({
      stage: 'defense',
      attempt: 1,
      usd: reservation.usd,
      inputTokens: reservation.inputTokens,
      outputTokens: reservation.outputTokens,
    });
    // The verdict ledger records what the call cost, not what was reserved.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ stage: 'defense', usd: 0 });
  });

  it('gives back only the unspent part when the failed call reported usage', async () => {
    const settlement = recorder();
    await runFailingDefense(async function* () {
      await Promise.resolve();
      yield assistant('m1', 300, 20);
      yield result('error_during_execution', { usd: 0.125, input: 300, output: 20 });
    }, settlement);
    const reqBudget = requestFor('defense').budget;
    expect(settlement.calls[0]!.refund).toMatchObject({
      usd: reqBudget.maxUsd - 0.125,
      inputTokens: reqBudget.maxInputTokens - 300,
      outputTokens: reqBudget.maxOutputTokens - 20,
    });
  });

  it('gives back nothing when the spend is unknown', async () => {
    const settlement = recorder();
    const { ledger } = await runFailingDefense(
      async function* (h) {
        yield assistant('m1', 1, 1);
        await new Promise<void>((resolve) => {
          h.options.abortController!.signal.addEventListener('abort', () => resolve());
        });
      },
      settlement,
      20,
    );
    expect(settlement.calls).toEqual([]);
    expect(ledger).toEqual([]);
  });

  it('without a settlement the up-front charge stands and nothing else is charged', async () => {
    const { cf, store, events } = await runFailingDefense(apiError(PROVIDER_400, { status: 400 }));
    expect(store.charges(cf.id)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'cost-charged')).toHaveLength(1);
  });

  it('a settlement that fails leaves the charge in place and reports the call error', async () => {
    const settlement: BudgetSettlement = {
      release: () => Promise.reject(new Error('store down')),
    };
    // runFailingDefense asserts the run rejects with the ModelCallError, not the store error.
    await runFailingDefense(apiError(PROVIDER_400), settlement);
  });
});
