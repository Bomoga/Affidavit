// L3-16: a provider failure must be diagnosable from the error alone, without leaking the key,
// credential-shaped text, or case content, and a failed call must not be charged the turn cap
// when the runtime reported what it actually spent. Every test uses a stubbed transport.
import { describe, expect, it } from 'vitest';
import { type Budget, type CaseId, type ModelPort, type StageCost } from '@affidavit/contracts';
import { FakeEventSink } from '@affidavit/testing';
import {
  BudgetExhaustedError,
  Orchestrator,
  type BudgetSettlement,
  type StageHandler,
} from '../orchestrator.js';
import {
  BIG_BUDGET,
  LoggingCaseStore,
  NOW,
  PATH_TO,
  assertSchemaValid,
  makeCaseFile,
  openAt,
} from '../test-support.js';
import {
  AnthropicModelPort,
  PROVIDER_MESSAGE_MAX,
  PROVIDER_MESSAGE_WITHHELD,
  type ModelLogEntry,
} from './anthropic.js';
import { ModelCallError, ModelUnconfiguredError } from './errors.js';
import { DEFAULT_MODEL_TABLE } from './models.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { qualifiedToolName } from './submit-tools.js';
import {
  CANARY_KEY,
  GOOD_WITNESS,
  assistant,
  refusalAssistant,
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
  it('carries the HTTP status, the error class and a known-safe message', async () => {
    const { port, logs } = makePort(apiError(PROVIDER_400, { status: 400 }));
    const err = await failure(port);
    expect(err.message).toContain('provider error invalid_request');
    expect(err.message).toContain('HTTP 400');
    expect(err.provider).toEqual({
      errorClass: 'invalid_request',
      status: 400,
      message: 'invalid_request_error; tools.0.custom.input_schema: JSON schema is invalid',
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
    expect(err.provider?.message).toContain('tools.0.custom.input_schema: JSON schema is invalid');
    expect(err.provider?.status).toBe(400);
  });

  for (const [text, shown] of [
    ['Invalid API key · Fix external API key', 'Invalid API key'],
    ['API Error: 400 Your organization has been disabled.', 'organization has been disabled'],
    [
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210345 tokens > 200000 maximum"}}',
      'invalid_request_error; prompt is too long: 210345 tokens > 200000 maximum',
    ],
    [
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}',
      'invalid_request_error; tool_choice: type "tool" and "any" are not supported',
    ],
    ['API Error: 404 model: claude-opus-5-5', 'model: claude-opus-5-5'],
    ['API Error: 400 temperature is not supported on this model', 'temperature: not supported'],
    [
      'API Error: 400 messages.0.content.0.text: Field required',
      'messages.0.content.0.text: Field required',
    ],
  ] as const) {
    it(`shows the known-safe shape of "${shown}"`, async () => {
      const { port } = makePort(apiError(text, { status: 400 }));
      expect((await failure(port)).provider?.message).toBe(shown);
    });
  }

  it('withholds provider text that matches no known-safe shape', async () => {
    const { port } = makePort(apiError('API Error: 400 something new went wrong', { status: 400 }));
    const err = await failure(port);
    expect(err.provider?.message).toBe(PROVIDER_MESSAGE_WITHHELD);
    expect(err.message).toContain('HTTP 400');
    expect(err.message).not.toContain('something new');
  });

  const SLICE = 'db.query("SELECT * FROM users WHERE id=" + req.query.id) // TOKEN=hunter2hunter2';
  const ECHOES: readonly [string, string][] = [
    ['verbatim', SLICE],
    ['JSON-escaped', JSON.stringify(SLICE)],
    ['unicode-escaped', SLICE.replace(/[a-z]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`)],
    ['case-changed', SLICE.toUpperCase()],
    ['whitespace-collapsed', SLICE.replace(/\s+/g, '')],
    ['short fragments', 'id=" + req.q ... ry.id) //'],
  ];
  for (const [kind, echo] of ECHOES) {
    it(`withholds a provider message echoing a code slice, ${kind}`, async () => {
      const text = `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":${JSON.stringify(`could not process ${echo}`)}}}`;
      const { port, logs } = makePort(apiError(text, { status: 400 }));
      const err = await failure(port, SLICE);
      const all = [err.message, JSON.stringify(err.provider), ...logs.map((l) => l.message)].join(
        '\n',
      );
      expect(all).not.toMatch(/select|users|req\.query|hunter2|query/i);
      expect(err.provider?.message).toBe(`invalid_request_error; ${PROVIDER_MESSAGE_WITHHELD}`);
    });
  }

  it('a safe template mixed with echoed content shows only the template', async () => {
    const text = `API Error: 400 messages.0.content.0.text: unexpected ${SLICE}`;
    const { port } = makePort(apiError(text, { status: 400 }));
    const err = await failure(port, SLICE);
    expect(err.provider?.message).toBe('messages.0.content.0.text: (reason withheld)');
    expect(err.message).not.toMatch(/SELECT|users|hunter2/);
  });

  it('a path made of names outside the request vocabulary is not shown', async () => {
    const text = 'API Error: 400 messages.password_reset_token: bad';
    const { port } = makePort(apiError(text));
    const err = await failure(port);
    expect(err.message).not.toContain('password_reset');
    expect(err.provider?.message).toBe(PROVIDER_MESSAGE_WITHHELD);
  });

  it('a fake key in a safe-shaped message is never shown', async () => {
    const text = `Invalid X-Api-Key header value: sk-ant-FAKE-abcdef0123456789. Was ${CANARY_KEY}`;
    const { port, logs } = makePort(apiError(text, { status: 400 }));
    const err = await failure(port);
    const all = [err.message, JSON.stringify(err.provider), ...logs.map((l) => l.message)].join(
      '\n',
    );
    expect(all).not.toContain('sk-ant');
    expect(all).not.toContain('FAKE');
    expect(all).not.toContain('CANARY');
    expect(err.provider?.message).toBe('Invalid X-Api-Key header value');
  });

  it('a fake key anywhere in long text leaves no fragment, and the message stays capped', async () => {
    for (let pad = PROVIDER_MESSAGE_MAX - 40; pad <= PROVIDER_MESSAGE_MAX + 5; pad += 5) {
      const text = `rate limit ${'e'.repeat(pad)} sk-ant-FAKE-0123456789abcdefghijklmnop overloaded`;
      const { port } = makePort(apiError(text));
      const err = await failure(port);
      expect(err.message, `pad ${pad}`).not.toMatch(/sk-ant|FAKE|0123456789abc/);
      expect(err.provider!.message!.length).toBeLessThanOrEqual(PROVIDER_MESSAGE_MAX + 3);
    }
  });

  it('runtime error text on an error result goes through the same allowlist', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield result('error_during_execution', { errors: [`failed on ${SLICE}`] });
    });
    const err = await failure(port, SLICE);
    expect(err.message).not.toMatch(/SELECT|hunter2/);
    expect(err.message).toContain(PROVIDER_MESSAGE_WITHHELD);
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

  for (const code of ['invalid_request', 'rate_limit', 'billing_error']) {
    it(`${code} with no result and no tokens is refused before work: zero`, async () => {
      const { port } = makePort(async function* () {
        await Promise.resolve();
        yield assistant('m1', 0, 0, code);
      });
      expect((await failure(port)).cost?.usd).toBe(0);
    });
  }
  for (const code of [
    'server_error',
    'overloaded',
    'max_output_tokens',
    'unknown',
    'model_not_found',
    'some_future_code',
  ]) {
    it(`${code} with no result is unknown spend, even with no tokens: the charge stands`, async () => {
      const { port } = makePort(async function* () {
        await Promise.resolve();
        yield assistant('m1', 0, 0, code);
      });
      expect((await failure(port)).cost).toBeUndefined();
    });
  }

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

// L3-18: the runtime reports a usage-policy refusal under the same assistant error code as a
// malformed request. A refusal is billed and is not a malformed request, so it must not be
// reported as `invalid_request` and must never be settled as zero spend.
describe('a model safety refusal', () => {
  const zeroResult = (text: string) =>
    result('success', { isError: true, usd: 0, input: 0, output: 0, text });

  it('is reported as class refusal with its category, not invalid_request', async () => {
    const { port, logs } = makePort(async function* () {
      await Promise.resolve();
      yield refusalAssistant();
      yield zeroResult('API Error: safeguards flagged this message');
    });
    const err = await failure(port);
    expect(err.provider?.errorClass).toBe('refusal');
    expect(err.provider?.refusalCategory).toBe('cyber');
    expect(err.message).toContain('provider error refusal');
    expect(err.message).toContain('category cyber');
    expect(err.message).toContain('usage policy refusal');
    expect(err.message).not.toContain('invalid_request');
    expect(logs.some((l) => l.message.includes('refusal'))).toBe(true);
  });

  it('with no result and no tokens is unknown spend, never zero: the charge stands', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield refusalAssistant();
    });
    expect((await failure(port)).cost).toBeUndefined();
  });

  it('with a result that reports no spend is unknown spend, not zero', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield refusalAssistant();
      yield zeroResult('refused');
    });
    expect((await failure(port)).cost).toBeUndefined();
  });

  it('with a result that reports spend carries that spend', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield refusalAssistant();
      yield result('success', { isError: true, usd: 0.031, input: 1200, output: 40 });
    });
    expect((await failure(port)).cost).toMatchObject({
      inputTokens: 1200,
      outputTokens: 40,
      usd: 0.031,
    });
  });

  it('never shows the refusal explanation or echoed text', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield refusalAssistant({
        explanation: 'CANARY-EXPLANATION about $where injection',
        text: 'API Error: CANARY-ECHO this.userId == ${parsedUserId}',
      });
    });
    const err = await failure(port);
    expect(err.message).not.toContain('CANARY');
    expect(err.message).not.toContain('$where');
    expect(err.message).toContain(PROVIDER_MESSAGE_WITHHELD);
  });

  for (const [kind, category] of [
    ['prose', 'Cyber Security!'],
    ['a number', 7],
    ['an object', { name: 'cyber' }],
    ['an unknown snake_case word', 'weapons_of_note'],
    ['a known word with case changed', 'Cyber'],
  ] as const) {
    it(`maps a category that is ${kind} to other, never passing it on`, async () => {
      const { port } = makePort(async function* () {
        await Promise.resolve();
        yield refusalAssistant({ category });
      });
      const err = await failure(port);
      expect(err.provider?.errorClass).toBe('refusal');
      expect(err.provider?.refusalCategory).toBe('other');
      expect(err.message).toContain('category other');
    });
  }

  for (const category of ['cyber', 'bio', 'chem', 'csam', 'frontier_llm', 'reasoning_extraction']) {
    it(`passes on the allowlisted category ${category}`, async () => {
      const { port } = makePort(async function* () {
        await Promise.resolve();
        yield refusalAssistant({ category });
      });
      expect((await failure(port)).provider?.refusalCategory).toBe(category);
    });
  }

  it('a refusal that names no category has none', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield refusalAssistant({ withDetails: false });
    });
    const err = await failure(port);
    expect(err.provider?.errorClass).toBe('refusal');
    expect(err.provider?.refusalCategory).toBeUndefined();
  });

  it('never returns a submission captured in a turn that was refused', async () => {
    const { port, logs } = makePort(async function* (h) {
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield refusalAssistant();
      yield result('success', { isError: true, usd: 0.02, input: 900, output: 30 });
    });
    const err = await failure(port);
    expect(err.provider).toMatchObject({ errorClass: 'refusal', refusalCategory: 'cyber' });
    expect(err.message).toContain('category cyber');
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('category cyber'))).toBe(true);
    expect(err.cost?.usd).toBe(0.02);
  });

  it('a refusal and a fallback notice together still throw refusal, submission or not', async () => {
    const { port } = makePort(async function* (h) {
      yield refusalAssistant();
      yield {
        type: 'system',
        subtype: 'model_refusal_fallback',
        trigger: 'refusal',
        direction: 'retry',
        original_model: 'claude-opus-5-5',
        fallback_model: 'claude-sonnet-5-5',
        request_id: null,
        api_refusal_category: 'cyber',
        uuid: '00000000-0000-0000-0000-000000000011',
        session_id: 's',
      } as unknown as SDKMessage;
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield result('success', { usd: 0.03 });
    });
    const err = await failure(port);
    expect(err.provider).toMatchObject({ errorClass: 'refusal', refusalCategory: 'cyber' });
    expect(err.message).toContain('fallback model');
  });

  it('fails the turn when an assistant message came from another model, notice or not', async () => {
    const { port } = makePort(async function* (h) {
      const m = assistant('m2', 100, 10, undefined, 'calling the tool') as unknown as {
        message: Record<string, unknown>;
      };
      m.message.model = 'claude-sonnet-5-5';
      yield m as unknown as SDKMessage;
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield result('success', { usd: 0.01 });
    });
    const err = await failure(port);
    expect(err.provider?.errorClass).toBe('model_mismatch');
    expect(err.message).toContain('claude-sonnet-5-5');
    expect(err.message).toContain('claude-opus-5-5');
  });

  it('does not echo an unshaped model name, and accepts the same model with a date suffix', async () => {
    const odd = makePort(async function* () {
      await Promise.resolve();
      const m = assistant('m3', 1, 1) as unknown as { message: Record<string, unknown> };
      m.message.model = 'CANARY model name with spaces';
      yield m as unknown as SDKMessage;
      yield result('success', { usd: 0.01 });
    });
    const err = await failure(odd.port);
    expect(err.message).toContain('another model');
    expect(err.message).not.toContain('CANARY');

    const dated = makePort(async function* (h) {
      for (const model of ['claude-opus-5-5-20261001', '<synthetic>']) {
        const m = assistant(`m-${model}`, 1, 1) as unknown as { message: Record<string, unknown> };
        m.message.model = model;
        yield m as unknown as SDKMessage;
      }
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield result('success', { usd: 0.01 });
    });
    expect((await dated.port.runTurn(requestFor('defense'))).outcome).toBe('submitted');
  });

  it('a no-fallback refusal notice upgrades invalid_request to refusal', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield assistant('m1', 0, 0, 'invalid_request', 'API Error: Claude cannot help');
      yield {
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        original_model: 'claude-opus-5-5',
        request_id: null,
        api_refusal_category: 'cyber',
        content: 'refused',
        uuid: '00000000-0000-0000-0000-000000000009',
        session_id: 's',
      } as unknown as SDKMessage;
    });
    const err = await failure(port);
    expect(err.provider).toMatchObject({ errorClass: 'refusal', refusalCategory: 'cyber' });
    expect(err.cost).toBeUndefined();
  });

  it('a fallback to another model after a refusal fails the turn even with a submission', async () => {
    const { port } = makePort(async function* (h) {
      yield {
        type: 'system',
        subtype: 'model_refusal_fallback',
        trigger: 'refusal',
        direction: 'retry',
        original_model: 'claude-opus-5-5',
        fallback_model: 'claude-sonnet-5-5',
        request_id: null,
        api_refusal_category: 'cyber',
        uuid: '00000000-0000-0000-0000-000000000010',
        session_id: 's',
      } as unknown as SDKMessage;
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield result('success', { usd: 0.02 });
    });
    const err = await failure(port);
    expect(err.provider).toMatchObject({ errorClass: 'refusal', refusalCategory: 'cyber' });
    expect(err.message).toContain('fallback model');
    expect(err.cost?.usd).toBe(0.02);
  });

  it('a real malformed request is still invalid_request and still zero before work', async () => {
    const { port } = makePort(async function* () {
      await Promise.resolve();
      yield assistant('m1', 0, 0, 'invalid_request', PROVIDER_400);
    });
    const err = await failure(port);
    expect(err.provider?.errorClass).toBe('invalid_request');
    expect(err.cost?.usd).toBe(0);
  });
});

// Second review of L3-18: a refusal anywhere in the stream must win, whatever came before it.
describe('a refusal anywhere in the stream', () => {
  const noFallback = (): SDKMessage =>
    ({
      type: 'system',
      subtype: 'model_refusal_no_fallback',
      original_model: 'claude-opus-5-5',
      request_id: null,
      api_refusal_category: 'bio',
      content: 'refused',
      uuid: '00000000-0000-0000-0000-000000000020',
      session_id: 's',
    }) as unknown as SDKMessage;
  const withStop = (m: SDKMessage, stop: string): SDKMessage => {
    (m as unknown as Record<string, unknown>).stop_reason = stop;
    return m;
  };
  const refusedTurn = async (script: Script) => {
    const { port } = makePort(script);
    const err = await failure(port);
    expect(err.provider?.errorClass).toBe('refusal');
    return err;
  };

  it('max_output_tokens, then a submission, then a refusal frame: refusal, no submission', async () => {
    const err = await refusedTurn(async function* (h) {
      yield assistant('m1', 50, 1500, 'max_output_tokens', 'API Error: output limit');
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield refusalAssistant();
      yield result('success', { isError: true, usd: 0.05, input: 900, output: 1500 });
    });
    expect(err.provider?.refusalCategory).toBe('cyber');
    expect(err.message).toContain('usage policy refusal');
    expect(err.cost?.usd).toBe(0.05);
  });

  it('max_output_tokens, then a submission, then a no-fallback notice: refusal', async () => {
    const err = await refusedTurn(async function* (h) {
      yield assistant('m1', 50, 1500, 'max_output_tokens');
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield noFallback();
      yield result('success', { isError: true, usd: 0, input: 0, output: 0 });
    });
    expect(err.provider?.refusalCategory).toBe('bio');
    // Zero reported spend for a refusal is unknown spend, even after another error.
    expect(err.cost).toBeUndefined();
  });

  it('a submission, then a result whose stop_reason is refusal (no error frame): refusal', async () => {
    const err = await refusedTurn(async function* (h) {
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield withStop(result('success', { usd: 0.02 }), 'refusal');
    });
    expect(err.provider?.refusalCategory).toBeUndefined();
  });

  it('a submission, then a refusal frame: refusal', async () => {
    await refusedTurn(async function* (h) {
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield refusalAssistant();
    });
  });

  it('an assistant message with stop_reason refusal and no error field: refusal', async () => {
    const err = await refusedTurn(async function* (h) {
      const m = assistant('m1', 10, 1, undefined, 'partial') as unknown as {
        message: Record<string, unknown>;
      };
      m.message.stop_reason = 'refusal';
      m.message.stop_details = { category: 'cyber', explanation: null };
      yield m as unknown as SDKMessage;
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield result('success', { usd: 0.01 });
    });
    expect(err.provider?.refusalCategory).toBe('cyber');
  });

  it('a normal stream with other stop reasons is not a refusal', async () => {
    const { port } = makePort(async function* (h) {
      const m = assistant('m1', 10, 1, undefined, 'calling') as unknown as {
        message: Record<string, unknown>;
      };
      m.message.stop_reason = 'tool_use';
      yield m as unknown as SDKMessage;
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield withStop(result('success', { usd: 0.01 }), 'end_turn');
    });
    const out = await port.runTurn(requestFor('defense'));
    expect(out.outcome).toBe('submitted');
    expect(out.submission).toEqual(GOOD_WITNESS);
  });
});

describe('settling the up-front charge in a trial', () => {
  async function runFailingDefense(
    script: Script | ModelPort,
    settlement?: BudgetSettlement,
    timeoutMs = 5_000,
    storeIn?: LoggingCaseStore | ((sink: FakeEventSink) => LoggingCaseStore),
    budget: Budget = BIG_BUDGET,
    expected: abstract new (...args: never[]) => Error = ModelCallError,
  ) {
    const cf = makeCaseFile();
    const sink = new FakeEventSink();
    // Given the sink, the fake checks every release against the charge at its seq (#83 review).
    const store =
      storeIn === undefined
        ? new LoggingCaseStore([], { events: sink })
        : typeof storeIn === 'function'
          ? storeIn(sink)
          : storeIn;
    await openAt(store, cf, budget, PATH_TO.defense);
    const port =
      typeof script === 'function' ? makePort(script, CANARY_KEY, timeoutMs).port : script;
    let thrown: unknown;
    let ledger: readonly StageCost[] = [];
    const defense: StageHandler = {
      async run(ctx) {
        try {
          await ctx.runAgent({ ...requestFor('defense'), actor: 'defense' });
        } catch (e) {
          thrown = e;
          throw e;
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
    if (expected === ModelCallError) {
      await expect(orch.run(cf.id)).rejects.toBeInstanceOf(ModelCallError);
    } else {
      await orch.run(cf.id).catch(() => undefined);
    }
    expect(thrown).toBeInstanceOf(expected);
    const events = assertSchemaValid(sink.events(cf.id));
    return { cf, store, events, ledger, thrown };
  }

  /** A port that fails every turn with a ModelCallError carrying `cost` as given. */
  const failingWith = (cost: unknown): ModelPort => ({
    runTurn: () =>
      Promise.reject(new ModelCallError('agent turn failed', { cost: cost as StageCost })),
  });
  const COST = { stage: 'defense', attempt: 1, inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 5 };

  for (const [kind, bad] of [
    ['NaN usd', { ...COST, usd: Number.NaN }],
    ['negative usd', { ...COST, usd: -0.4 }],
    ['infinite tokens', { ...COST, inputTokens: Number.POSITIVE_INFINITY }],
    ['negative tokens', { ...COST, outputTokens: -5 }],
    ['not an object', 'free'],
  ] as const) {
    it(`a reported cost with ${kind} is unknown spend: no refund, the charge stands in the ledger`, async () => {
      const settlement = recorder();
      const { ledger, events } = await runFailingDefense(failingWith(bad), settlement);
      expect(settlement.calls).toEqual([]);
      expect(events.some((e) => e.type === 'cost-released')).toBe(false);
      // Unknown spend never refunds: the verdict row is the whole reservation, as in the stream.
      const budget = requestFor('defense').budget;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        stage: 'defense',
        attempt: 1,
        inputTokens: budget.maxInputTokens,
        outputTokens: budget.maxOutputTokens,
        usd: budget.maxUsd,
      });
    });
  }

  it('a failing overage charge never replaces the call error; it is attached as secondary', async () => {
    class FailingOverage extends LoggingCaseStore {
      charged = 0;
      override chargeBudget(caseId: CaseId, cost: StageCost) {
        this.charged++;
        if (this.charged > 1) return Promise.reject(new Error('store down'));
        return super.chargeBudget(caseId, cost);
      }
    }
    const store = new FailingOverage([]);
    const { thrown } = await runFailingDefense(
      failingWith({ ...COST, usd: 0.9 }),
      recorder(),
      5_000,
      store,
    );
    expect(thrown).toBeInstanceOf(ModelCallError);
    expect(((thrown as ModelCallError).settlementError as Error).message).toBe('store down');
  });

  it('a failed call whose overage overdraws the case is budget-exhausted, as on success', async () => {
    const settlement = recorder();
    const { events } = await runFailingDefense(
      failingWith({ ...COST, usd: 2 }),
      settlement,
      5_000,
      undefined,
      { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000, maxUsd: 1 },
      BudgetExhaustedError,
    );
    // The dollars were overspent, so no dollar comes back; only the unused tokens do.
    expect(settlement.calls).toHaveLength(1);
    expect(settlement.calls[0]!.refund.usd).toBe(0);
    expect(settlement.calls[0]!.refund.inputTokens).toBe(
      requestFor('defense').budget.maxInputTokens,
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('budget-exhausted');
    expect(types.filter((t) => t === 'cost-charged')).toHaveLength(2);
  });

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
    // The whole charge stands: the ledger row is the reservation, matching the stream.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ usd: requestFor('defense').budget.maxUsd });
  });

  it("without a settlement dep the store's own releaseCharge settles the refused call", async () => {
    const { cf, store, events, ledger } = await runFailingDefense(
      apiError(PROVIDER_400, { status: 400 }),
    );
    expect(store.charges(cf.id)).toHaveLength(1);
    const charged = events.filter((e) => e.type === 'cost-charged');
    expect(charged).toHaveLength(1);
    const released = events.filter((e) => e.type === 'cost-released');
    expect(released).toHaveLength(1);
    expect(released[0]!.actor).toBe('defense');
    expect(released[0]!.stage).toBe('defense');
    expect(released[0]!.payload).toMatchObject({
      reservationSeq: charged[0]!.seq,
      reason: 'model-call-failed',
      cost: { usd: requestFor('defense').budget.maxUsd },
      remaining: { remainingUsd: BIG_BUDGET.maxUsd },
    });
    expect([...store.releases(cf.id).keys()]).toEqual([charged[0]!.seq]);
    expect(ledger[0]).toMatchObject({ usd: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('a store without releaseCharge and no settlement keeps the whole charge', async () => {
    class OlderStore extends LoggingCaseStore {}
    // An older store: the v1.2 method is simply absent.
    Object.defineProperty(OlderStore.prototype, 'releaseCharge', { value: undefined });
    const { cf, store, events, ledger } = await runFailingDefense(
      apiError(PROVIDER_400, { status: 400 }),
      undefined,
      5_000,
      new OlderStore([]),
    );
    expect(store.charges(cf.id)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'cost-charged')).toHaveLength(1);
    expect(events.some((e) => e.type === 'cost-released')).toBe(false);
    expect(ledger[0]).toMatchObject({ usd: requestFor('defense').budget.maxUsd });
  });

  it('a settlement that fails leaves the charge in place and reports the call error', async () => {
    const settlement: BudgetSettlement = {
      release: () => Promise.reject(new Error('store down')),
    };
    // runFailingDefense asserts the run rejects with the ModelCallError, not the store error.
    const { thrown, events, ledger } = await runFailingDefense(apiError(PROVIDER_400), settlement);
    expect(((thrown as ModelCallError).settlementError as Error).message).toBe('store down');
    expect(events.some((e) => e.type === 'cost-released')).toBe(false);
    expect(ledger[0]).toMatchObject({ usd: requestFor('defense').budget.maxUsd });
  });

  it('a release the store rejects (wrong seq) emits no cost-released and keeps the charge', async () => {
    // Points every release at seq 0 (a stage-entered event), which the fake refuses.
    const { thrown, events, ledger } = await runFailingDefense(
      apiError(PROVIDER_400, { status: 400 }),
      undefined,
      5_000,
      (sink) => {
        const s = new LoggingCaseStore([], { events: sink });
        const real = s.releaseCharge.bind(s);
        s.releaseCharge = (id, refund) => real(id, refund, 0);
        return s;
      },
    );
    expect(((thrown as ModelCallError).settlementError as Error).name).toBe('ReleaseRejectedError');
    expect(events.some((e) => e.type === 'cost-released')).toBe(false);
    expect(ledger[0]).toMatchObject({ usd: requestFor('defense').budget.maxUsd });
  });
});
