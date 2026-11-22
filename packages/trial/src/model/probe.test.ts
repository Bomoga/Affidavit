// L3-17: the diagnostic probe. Every test uses a stubbed transport and a fake fetch; nothing
// reaches the network.
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getPrompt } from '@affidavit/prompts';
import { describe, expect, it } from 'vitest';
import { buildAgentOptions } from './anthropic.js';
import { DEFAULT_MODEL_TABLE } from './models.js';
import {
  BANNER,
  MESSAGES_URL,
  P1_MODEL,
  ProbeKeyError,
  RAW_MESSAGE_MAX,
  advertisedTools,
  buildLadder,
  describeSchema,
  fillerText,
  interpret,
  isSynthetic,
  readProbeKey,
  runLadder,
  showRaw,
  type ProbeDeps,
  type ProbeResult,
  type ProbeSpec,
} from './probe.js';
import { SubmissionBox, buildSubmitTools } from './submit-tools.js';
import { CANARY_KEY, assistant, result } from './test-stubs.js';
import type { AgentTransport } from './transport.js';

const ENV = { [`ANTHROPIC_API_KEY`]: CANARY_KEY, PATH: '/usr/bin' };

interface Call {
  prompt: string;
  options: Options;
}

function fakeTransport(script: (call: Call) => SDKMessage[]): {
  transport: AgentTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: AgentTransport = (params) => {
    calls.push(params);
    const msgs = script(params);
    return (async function* () {
      for (const m of msgs) {
        await Promise.resolve();
        yield m;
      }
    })();
  };
  return { transport, calls };
}

const ok = (): SDKMessage[] => [assistant('m1', 10, 2, undefined, 'ok'), result('success')];

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (body: Record<string, unknown>) => Response): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(JSON.parse(init.body as string) as Record<string, unknown>));
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const fetchOk = () =>
  fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200, headers: { 'request-id': 'req_probe_ok' } },
      ),
  );

function deps(
  transport: AgentTransport,
  f: typeof fetch,
  env: () => Record<string, string> = () => ENV,
): ProbeDeps {
  return { transport, fetch: f, env, modelTable: DEFAULT_MODEL_TABLE, timeoutMs: 5_000 };
}

const everything = (r: unknown) => JSON.stringify(r);

describe('probe ladder construction', () => {
  it('builds P1, one P2 per distinct configured model, P3, P4a, P4b, P5 and P6a to P6c', () => {
    const ladder = buildLadder(DEFAULT_MODEL_TABLE);
    const distinct = [...new Set(Object.values(DEFAULT_MODEL_TABLE))].sort();
    expect(ladder.map((p) => p.id)).toEqual([
      'P1',
      ...distinct.map((m) => `P2:${m}`),
      'P3',
      'P4a',
      'P4b',
      'P5',
      'P6a',
      'P6b',
      'P6c',
    ]);
    expect(ladder[0]).toMatchObject({ model: P1_MODEL, path: 'sdk-bare', tools: [] });
    expect(ladder[0]?.user.text).toBe('Reply with the single word ok');
    for (const p of ladder.filter((x) => !x.id.startsWith('P1') && !x.id.startsWith('P2'))) {
      expect(p.model).toBe(DEFAULT_MODEL_TABLE.defense);
    }
  });

  it('follows the configured table, including a fable id', () => {
    const table = { ...DEFAULT_MODEL_TABLE, defense: 'claude-fable-5-2' as const };
    const ladder = buildLadder(table, { fetch: false });
    expect(ladder.map((p) => p.id)).toContain('P2:claude-fable-5-2');
    expect(ladder.find((p) => p.id === 'P4b')?.model).toBe('claude-fable-5-2');
    expect(ladder.some((p) => p.path === 'fetch')).toBe(false);
  });

  it('marks every input synthetic and uses the packaged Defense prompt for the port probes', () => {
    const ladder = buildLadder(DEFAULT_MODEL_TABLE);
    for (const p of ladder) {
      expect(isSynthetic(p.system)).toBe(true);
      expect(isSynthetic(p.user)).toBe(true);
    }
    const p4b = ladder.find((p) => p.id === 'P4b');
    expect(p4b?.system.text).toBe(getPrompt('defense').system);
    expect(p4b?.user.text).toContain('BEGIN UNTRUSTED DATA source=probe');
    expect(p4b?.tools).toEqual(['submit_witness']);
  });

  it('sizes P5 from the filler setting and refuses an out-of-range size', () => {
    const p5 = buildLadder(DEFAULT_MODEL_TABLE, { fillerKb: 8 }).find((p) => p.id === 'P5');
    expect(p5?.user.text.length).toBeGreaterThan(8 * 1024);
    expect(p5?.user.text.length).toBeLessThan(10 * 1024);
    expect(fillerText(4)).toHaveLength(4096);
    expect(() => fillerText(0)).toThrow(RangeError);
    expect(() => fillerText(65)).toThrow(RangeError);
    expect(() => fillerText(1.5)).toThrow(RangeError);
  });
});

describe('probe refusal and redaction', () => {
  it('refuses a probe whose input is not synthetic, without any call', async () => {
    const t = fakeTransport(ok);
    const f = fetchOk();
    const forged: ProbeSpec = {
      ...buildLadder(DEFAULT_MODEL_TABLE)[0]!,
      id: 'X1',
      user: { origin: 'trivial-user', text: 'case file content' },
    };
    const forgedSystem: ProbeSpec = {
      ...buildLadder(DEFAULT_MODEL_TABLE).find((p) => p.id === 'P6a')!,
      id: 'X2',
      system: { origin: 'trivial-system', text: 'x' },
    };
    const run = await runLadder([forged, forgedSystem], deps(t.transport, f.fetch));
    expect(run.results.map((r) => r.status)).toEqual(['REFUSED', 'REFUSED']);
    expect(t.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect(isSynthetic({ origin: 'trivial-user', text: 'Reply with the single word ok' })).toBe(
      false,
    );
  });

  it('exits clearly on a missing or malformed key and never names the value', () => {
    expect(() => readProbeKey({})).toThrow(ProbeKeyError);
    expect(() => readProbeKey({ ANTHROPIC_API_KEY: '  ' })).toThrow(/not set/);
    for (const bad of [`${CANARY_KEY}\n`, `"${CANARY_KEY}"`, `${CANARY_KEY} x`, `${CANARY_KEY}é`]) {
      let message = '';
      try {
        readProbeKey({ ANTHROPIC_API_KEY: bad });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/malformed/);
      expect(message).not.toContain(CANARY_KEY);
    }
    expect(readProbeKey({ ANTHROPIC_API_KEY: CANARY_KEY })).toBe(CANARY_KEY);
  });

  it('redacts the key and credential patterns from raw text, then clips', () => {
    const shown = showRaw(
      `bad request for key ${CANARY_KEY} and x-api-key: abcdefgh12345`,
      CANARY_KEY,
    );
    expect(shown).not.toContain(CANARY_KEY);
    expect(shown).not.toContain('abcdefgh12345');
    expect(shown).toContain('bad request');
    expect(showRaw('a'.repeat(RAW_MESSAGE_MAX + 50), CANARY_KEY)).toHaveLength(RAW_MESSAGE_MAX + 3);
  });

  it('stops with a key error before any call when the key goes missing', async () => {
    const t = fakeTransport(ok);
    await expect(
      runLadder(
        buildLadder(DEFAULT_MODEL_TABLE).slice(0, 1),
        deps(t.transport, fetchOk().fetch, () => ({})),
      ),
    ).rejects.toThrow(ProbeKeyError);
    expect(t.calls).toHaveLength(0);
  });

  it('prints a banner that says raw provider text is shown because input is synthetic', () => {
    expect(BANNER).toMatch(/RAW PROVIDER TEXT IS SHOWN/);
    expect(BANNER).toMatch(/synthetic/);
    expect(BANNER).toMatch(/bypass the Agent SDK/);
    expect(BANNER).not.toMatch(/—/);
  });
});

describe('probe runs with a fake port', () => {
  it('shows the raw provider text, class, status and request id for a failing SDK probe', async () => {
    const raw = `{"type":"error","error":{"type":"invalid_request_error","message":"tools.0.custom: some brand new reason (key ${CANARY_KEY})"}}`;
    const t = fakeTransport(() => [
      {
        type: 'system',
        subtype: 'init',
        claude_code_version: '9.9.9',
        model: 'claude-opus-5-5',
        apiKeySource: 'ANTHROPIC_API_KEY',
        permissionMode: 'dontAsk',
        betas: ['probe-beta'],
        tools: [],
        mcp_servers: [{ name: 'affidavit', status: 'connected' }],
      } as unknown as SDKMessage,
      {
        ...assistant('m1', 0, 0, 'invalid_request', `API Error: 400 ${raw}`),
        request_id: 'req_123',
      } as unknown as SDKMessage,
      result('success', {
        isError: true,
        input: 0,
        output: 0,
        usd: 0,
        apiErrorStatus: 400,
        text: 'API Error',
      }),
    ]);
    const run = await runLadder(
      buildLadder(DEFAULT_MODEL_TABLE).slice(0, 1),
      deps(t.transport, fetchOk().fetch),
    );
    const r = run.results[0]!;
    expect(r).toMatchObject({
      id: 'P1',
      status: 'FAIL',
      errorClass: 'invalid_request',
      httpStatus: 400,
      requestId: 'req_123',
    });
    expect(r.rawMessage).toContain('some brand new reason');
    expect(r.runtime).toMatchObject({
      version: '9.9.9',
      betas: ['probe-beta'],
      mcpServers: ['affidavit:connected'],
    });
    expect(everything(run)).not.toContain(CANARY_KEY);
  });

  it('passes the port option set to P3 and P4a, and the real port path for P4b', async () => {
    const t = fakeTransport(ok);
    const ladder = buildLadder(DEFAULT_MODEL_TABLE, { fetch: false });
    const run = await runLadder(ladder, deps(t.transport, fetchOk().fetch), { maxUsd: 2 });
    expect(run.results.every((r) => r.status === 'PASS')).toBe(true);
    const byPrompt = (i: number) => t.calls[i]!.options;
    const ids = ladder.map((p) => p.id);
    const p1 = byPrompt(ids.indexOf('P1'));
    expect(p1.model).toBe(P1_MODEL);
    expect(p1.tools).toEqual([]);
    expect(p1.mcpServers).toBeUndefined();
    expect(p1.env?.ANTHROPIC_API_KEY).toBe(CANARY_KEY);

    const reference = buildAgentOptions({
      abortController: new AbortController(),
      workdir: 'w',
      tools: buildSubmitTools(['submit_witness'], new SubmissionBox()),
      system: 's',
      model: 'm',
      maxTurns: 2,
      maxBudgetUsd: 0.05,
      key: CANARY_KEY,
      parentEnv: ENV,
    });
    for (const id of ['P3', 'P4a', 'P4b', 'P5']) {
      const o = byPrompt(ids.indexOf(id));
      expect(Object.keys(o).sort()).toEqual(Object.keys(reference).sort());
      expect(o).toMatchObject({
        tools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
      });
      expect(Object.keys(o.mcpServers ?? {})).toEqual(['affidavit']);
    }
    expect(byPrompt(ids.indexOf('P3')).allowedTools).toEqual([]);
    expect(byPrompt(ids.indexOf('P4a')).allowedTools).toEqual(['mcp__affidavit__submit_witness']);
    expect(byPrompt(ids.indexOf('P4b')).systemPrompt).toBe(getPrompt('defense').system);
    expect(run.results.find((r) => r.id === 'P4b')?.detail).toMatch(/port outcome no-submission/);
  });

  it('reports the port error for a failing port probe alongside the raw text', async () => {
    const t = fakeTransport(() => [
      assistant('m1', 0, 0, 'invalid_request', 'API Error: 400 something the port would withhold'),
      result('success', { isError: true, input: 0, output: 0, apiErrorStatus: 400 }),
    ]);
    const p4b = buildLadder(DEFAULT_MODEL_TABLE).filter((p) => p.id === 'P4b');
    const r = (await runLadder(p4b, deps(t.transport, fetchOk().fetch))).results[0]!;
    expect(r.status).toBe('FAIL');
    expect(r.rawMessage).toContain('something the port would withhold');
    expect(r.portMessage).toMatch(/provider error invalid_request \(HTTP 400\)/);
    expect(r.portMessage).toMatch(/withheld/);
  });

  it('enforces the USD cap, charging the reserve for unknown spend, and keeps going', async () => {
    const t = fakeTransport(() => [assistant('m1', 0, 0, 'server_error', 'boom')]);
    const run = await runLadder(
      buildLadder(DEFAULT_MODEL_TABLE, { fetch: false }),
      deps(t.transport, fetchOk().fetch),
      {
        maxUsd: 0.1,
        reserveUsd: 0.05,
      },
    );
    expect(run.results.slice(0, 2).map((r) => r.status)).toEqual(['FAIL', 'FAIL']);
    expect(run.results.slice(2).every((r) => r.status === 'SKIP')).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(run.chargedUsd).toBeCloseTo(0.1);
    await expect(runLadder([], deps(t.transport, fetchOk().fetch), { maxUsd: 5 })).rejects.toThrow(
      RangeError,
    );
  });

  it('sends the fetch probes to the Messages API with the advertised tool schema', async () => {
    const f = fakeFetch((body) =>
      body.tools === undefined
        ? new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), { status: 200 })
        : new Response(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: `tools.0.custom.input_schema: weird ${CANARY_KEY}`,
              },
            }),
            { status: 400, headers: { 'request-id': 'req_400' } },
          ),
    );
    const fetchProbes = buildLadder(DEFAULT_MODEL_TABLE).filter((p) => p.path === 'fetch');
    const run = await runLadder(fetchProbes, deps(fakeTransport(ok).transport, f.fetch));
    expect(f.calls.map((c) => c.url)).toEqual([MESSAGES_URL, MESSAGES_URL, MESSAGES_URL]);
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const bodies = f.calls.map(
      (c) =>
        JSON.parse(c.init.body as string) as {
          max_tokens: number;
          tools?: { name: string; input_schema: Record<string, unknown> }[];
        },
    );
    expect(bodies.every((b) => b.max_tokens === 16)).toBe(true);
    expect(bodies[1]?.tools?.[0]?.name).toBe('mcp__affidavit__submit_witness');
    expect(bodies[2]?.tools?.[0]?.input_schema.$schema).toBeUndefined();
    expect(run.results.map((r) => r.status)).toEqual(['PASS', 'FAIL', 'FAIL']);
    expect(run.results[1]).toMatchObject({
      errorClass: 'invalid_request_error',
      httpStatus: 400,
      requestId: 'req_400',
    });
    expect(run.results[1]?.rawMessage).toContain('weird');
    expect(everything(run)).not.toContain(CANARY_KEY);
  });

  it('reads the advertised submit tool schema from the in-process server', async () => {
    const [tool] = await advertisedTools(['submit_witness']);
    expect(tool?.name).toBe('submit_witness');
    expect(tool?.inputSchema.type).toBe('object');
    expect(describeSchema(tool?.inputSchema)).toMatch(/bytes/);
  });
});

describe('probe interpretation', () => {
  const r = (id: string, status: ProbeResult['status'], model?: string): ProbeResult => ({
    id,
    name: id,
    status,
    detail: '',
    ...(model === undefined ? {} : { model }),
  });

  it('names a key or organization problem when P1 fails', () => {
    expect(interpret([r('P1', 'FAIL')]).join('\n')).toMatch(/P1 fails: key or organization/);
  });

  it('lists model ids that fail and that work', () => {
    const lines = interpret([
      r('P1', 'PASS'),
      r('P2:claude-fable-5-2', 'FAIL'),
      r('P2:claude-haiku-5-5', 'PASS'),
    ]).join('\n');
    expect(lines).toMatch(/fail: claude-fable-5-2/);
    expect(lines).toMatch(/work: claude-haiku-5-5/);
  });

  it('blames the option set, the tool schema, the system prompt, size and $schema in turn', () => {
    const m = 'claude-opus-5-5';
    expect(interpret([r('P1', 'PASS'), r(`P2:${m}`, 'PASS'), r('P3', 'FAIL', m)]).join()).toMatch(
      /SDK option set/,
    );
    expect(interpret([r('P3', 'PASS', m), r('P4a', 'FAIL', m)]).join()).toMatch(
      /submit tool schema/,
    );
    expect(interpret([r('P4a', 'PASS', m), r('P4b', 'FAIL', m)]).join()).toMatch(
      /Defense system prompt/,
    );
    expect(interpret([r('P4b', 'PASS', m), r('P5', 'FAIL', m)]).join()).toMatch(/request size/);
    expect(interpret([r('P6a', 'PASS'), r('P6b', 'FAIL'), r('P6c', 'PASS')]).join()).toMatch(
      /\$schema/,
    );
    expect(interpret([r('P6a', 'PASS'), r('P6b', 'FAIL'), r('P6c', 'FAIL')]).join()).toMatch(
      /API itself refuses/,
    );
  });

  it('points at the model id when the Defense model fails even bare', () => {
    const m = 'claude-opus-5-5';
    const lines = interpret([r('P1', 'PASS'), r(`P2:${m}`, 'FAIL'), r('P3', 'FAIL', m)]).join();
    expect(lines).toMatch(/fails even on a bare request/);
    expect(lines).not.toMatch(/SDK option set/);
  });

  it('says so when everything passes, and has no em dash anywhere', () => {
    const all = interpret([r('P1', 'PASS'), r('P3', 'PASS')]);
    expect(all.join()).toMatch(/Every probe passed/);
    expect(all.join()).not.toMatch(/—/);
  });
});
