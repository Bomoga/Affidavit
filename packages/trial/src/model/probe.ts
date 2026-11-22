// Diagnostic probe for the real model port (L3-17). A ladder of tiny live calls, each built only
// from fixed synthetic text, that shows the provider's own error text for every failing probe.
// The real port never prints raw provider text, because its input is real case content. Here
// the input is fixed and synthetic, so the raw text (after key redaction) is safe to show.
//
// Run by the lead on their own key: `node --import tsx packages/trial/scripts/probe-model.ts`.
// Nothing in the trial or the worker imports this file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SubmitToolName } from '@affidavit/contracts';
import { getPrompt, renderPrompt } from '@affidavit/prompts';
import type { ModelTurnRequest } from '../orchestrator.js';
import {
  API_KEY_ENV_VAR,
  AnthropicModelPort,
  KEY_SHAPE,
  buildAgentOptions,
  childEnv,
} from './anthropic.js';
import { DEFAULT_MODEL_TABLE, resolveModelTable, type ModelTable } from './models.js';
import { describeThrown, redact } from './redact.js';
import { SubmissionBox, buildSubmitTools, qualifiedToolName } from './submit-tools.js';
import type { AgentTransport } from './transport.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The cheapest model id the port knows, for the key sanity probe. */
export const P1_MODEL = 'claude-haiku-5-5';
/** The only URL the fetch probes call. They bypass the Agent SDK on purpose (P6). */
export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Output cap for the fetch probes. */
export const FETCH_MAX_TOKENS = 16;
/** Longest raw provider text printed per probe, after redaction. */
export const RAW_MESSAGE_MAX = 2000;
export const DEFAULT_MAX_USD = 0.5;
export const MAX_ALLOWED_USD = 2;
/**
 * Charged against the cap for a probe whose real spend is unknown (no result, or a fetch probe),
 * and passed to the SDK as each probe's `maxBudgetUsd`. A cap, not an estimate.
 */
export const DEFAULT_RESERVE_USD = 0.05;
export const DEFAULT_FILLER_KB = 16;
export const MAX_FILLER_KB = 64;
export const PROBE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------------------------
// Synthetic input. A probe only runs on text made here: fixed strings, deterministic filler, and
// the packaged system prompts. Anything else is refused before any call.
// ---------------------------------------------------------------------------------------------

export interface SyntheticText {
  readonly origin: string;
  readonly text: string;
}

const SYNTHETIC = new WeakSet<object>();

function synthetic(origin: string, text: string): SyntheticText {
  const s = Object.freeze({ origin, text });
  SYNTHETIC.add(s);
  return s;
}

/** True only for text this module built. A look-alike object is not synthetic. */
export function isSynthetic(x: unknown): x is SyntheticText {
  return typeof x === 'object' && x !== null && SYNTHETIC.has(x);
}

export class NonSyntheticInputError extends Error {
  constructor(probe: string) {
    super(`probe ${probe} refused: its input is not synthetic probe text`);
    this.name = 'NonSyntheticInputError';
  }
}

const TRIVIAL_SYSTEM = synthetic(
  'trivial-system',
  'You are a connectivity check for a test harness. Answer in one word.',
);
const TRIVIAL_USER = synthetic('trivial-user', 'Reply with the single word ok');
const TOOL_USER = synthetic(
  'tool-user',
  'This is a synthetic connectivity test with fake data. There is no real case. Call your submit tool exactly once with obviously fake placeholder values (for example a template "probe" and an empty parameter space), then stop.',
);

const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat';

/** Deterministic lorem filler of `kb` KiB, shaped like case-file slices. */
export function fillerText(kb: number): string {
  if (!Number.isInteger(kb) || kb < 1 || kb > MAX_FILLER_KB) {
    throw new RangeError(`filler size must be an integer from 1 to ${MAX_FILLER_KB} KiB`);
  }
  const target = kb * 1024;
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < target; i++) {
    const line = `// filler line ${i}: ${LOREM}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n').slice(0, target);
}

function defenseRendered(
  origin: string,
  content: string,
): { system: SyntheticText; user: SyntheticText; version: string; outputSchemaRef: string } {
  const r = renderPrompt('defense', [{ label: 'probe', content }]);
  return {
    system: synthetic('packaged-defense-system', r.system),
    user: synthetic(origin, r.user),
    version: r.version,
    outputSchemaRef: r.outputSchemaRef,
  };
}

// ---------------------------------------------------------------------------------------------
// The ladder.
// ---------------------------------------------------------------------------------------------

export type ProbePath =
  /** The SDK with a bare option set: no submit server, no hooks, no denylist. */
  | 'sdk-bare'
  /** The SDK with the port's own option set (`buildAgentOptions`). */
  | 'sdk-port-options'
  /** `AnthropicModelPort.runTurn` itself, on a real packaged prompt. */
  | 'port'
  /** A direct HTTPS call to the Messages API. Bypasses the Agent SDK. */
  | 'fetch';

export interface ProbeSpec {
  readonly id: string;
  readonly name: string;
  readonly path: ProbePath;
  readonly model: string;
  readonly system: SyntheticText;
  readonly user: SyntheticText;
  /** Submit tools advertised to the model. */
  readonly tools: readonly SubmitToolName[];
  /** For a fetch probe with tools: drop the top-level `$schema` of each input schema. */
  readonly stripSchemaKeyword?: boolean;
  /** For a port probe: the prompt version and schema ref the port checks. */
  readonly promptVersion?: string;
  readonly outputSchemaRef?: string;
}

export interface LadderOptions {
  fillerKb?: number;
  /** Include the P6 fetch probes. Default true. */
  fetch?: boolean;
}

/** The model table the port would use, or the defaults with a note when it does not resolve. */
export function probeModelTable(env: Env): { table: ModelTable; note?: string } {
  try {
    return { table: resolveModelTable(env) };
  } catch (err) {
    return {
      table: DEFAULT_MODEL_TABLE,
      note: `model table did not resolve (${describeThrown(err, [])}); probing the defaults`,
    };
  }
}

export function buildLadder(table: ModelTable, opts: LadderOptions = {}): ProbeSpec[] {
  const defenseModel = table.defense;
  const ladder: ProbeSpec[] = [
    {
      id: 'P1',
      name: `key sanity: bare request on ${P1_MODEL}, no tools`,
      path: 'sdk-bare',
      model: P1_MODEL,
      system: TRIVIAL_SYSTEM,
      user: TRIVIAL_USER,
      tools: [],
    },
  ];
  for (const model of [...new Set(Object.values(table))].sort()) {
    const prompts = Object.entries(table)
      .filter(([, m]) => m === model)
      .map(([p]) => p);
    ladder.push({
      id: `P2:${model}`,
      name: `model id ${model} (used by ${prompts.join(', ')}), bare request`,
      path: 'sdk-bare',
      model,
      system: TRIVIAL_SYSTEM,
      user: TRIVIAL_USER,
      tools: [],
    });
  }
  ladder.push({
    id: 'P3',
    name: `port option set on ${defenseModel}, trivial prompt, no submit tools`,
    path: 'sdk-port-options',
    model: defenseModel,
    system: TRIVIAL_SYSTEM,
    user: TRIVIAL_USER,
    tools: [],
  });
  ladder.push({
    id: 'P4a',
    name: `port option set on ${defenseModel} with the Defense submit tool, trivial system prompt`,
    path: 'sdk-port-options',
    model: defenseModel,
    system: TRIVIAL_SYSTEM,
    user: TOOL_USER,
    tools: ['submit_witness'],
  });
  const p4 = defenseRendered('rendered-defense-tool-user', TOOL_USER.text);
  ladder.push({
    id: 'P4b',
    name: `real port runTurn: packaged Defense prompt on ${defenseModel}, synthetic user message`,
    path: 'port',
    model: defenseModel,
    system: p4.system,
    user: p4.user,
    tools: ['submit_witness'],
    promptVersion: p4.version,
    outputSchemaRef: p4.outputSchemaRef,
  });
  const kb = opts.fillerKb ?? DEFAULT_FILLER_KB;
  const p5 = defenseRendered(
    'rendered-defense-filler-user',
    `${TOOL_USER.text}\n\nThe text below is filler with no meaning.\n${fillerText(kb)}`,
  );
  ladder.push({
    id: 'P5',
    name: `real port runTurn as P4b with about ${kb} KiB of lorem filler`,
    path: 'port',
    model: defenseModel,
    system: p5.system,
    user: p5.user,
    tools: ['submit_witness'],
    promptVersion: p5.version,
    outputSchemaRef: p5.outputSchemaRef,
  });
  if (opts.fetch !== false) {
    ladder.push(
      {
        id: 'P6a',
        name: `direct HTTPS (bypasses the SDK) on ${defenseModel}, no tools`,
        path: 'fetch',
        model: defenseModel,
        system: TRIVIAL_SYSTEM,
        user: TRIVIAL_USER,
        tools: [],
      },
      {
        id: 'P6b',
        name: `direct HTTPS (bypasses the SDK) on ${defenseModel}, Defense submit tool schema as advertised`,
        path: 'fetch',
        model: defenseModel,
        system: TRIVIAL_SYSTEM,
        user: TOOL_USER,
        tools: ['submit_witness'],
      },
      {
        id: 'P6c',
        name: `direct HTTPS (bypasses the SDK) on ${defenseModel}, as P6b without the top-level $schema`,
        path: 'fetch',
        model: defenseModel,
        system: TRIVIAL_SYSTEM,
        user: TOOL_USER,
        tools: ['submit_witness'],
        stripSchemaKeyword: true,
      },
    );
  }
  return ladder;
}

// ---------------------------------------------------------------------------------------------
// Key handling: read at call time, never stored, never printed.
// ---------------------------------------------------------------------------------------------

export class ProbeKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeKeyError';
  }
}

/** Reads and checks the key. The message names the problem, never the value. */
export function readProbeKey(env: Env): string {
  const key = env[API_KEY_ENV_VAR];
  if (key === undefined || key.trim() === '') {
    throw new ProbeKeyError(
      `${API_KEY_ENV_VAR} is not set. Export it in this shell first; never put it in the command line or a file in the repo.`,
    );
  }
  if (!KEY_SHAPE.test(key) || /["'`]/.test(key)) {
    throw new ProbeKeyError(
      `${API_KEY_ENV_VAR} is malformed: it contains whitespace, a line break, quotes or a character that is not printable ASCII. Export the bare key.`,
    );
  }
  return key;
}

/** Raw provider text for display: the key and every credential pattern redacted, then clipped. */
export function showRaw(text: string, key: string): string {
  const clean = redact(text, [key]).replace(/\s+/g, ' ').trim();
  return clean.length > RAW_MESSAGE_MAX ? `${clean.slice(0, RAW_MESSAGE_MAX)}...` : clean;
}

// ---------------------------------------------------------------------------------------------
// The advertised submit tool schema, read from the in-process tool server the port builds.
// ---------------------------------------------------------------------------------------------

export interface AdvertisedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * The tools exactly as the submit server lists them over MCP `tools/list`, which is what the
 * agent runtime turns into API tool definitions. Talks to the server in process; no network.
 */
export async function advertisedTools(names: readonly SubmitToolName[]): Promise<AdvertisedTool[]> {
  const set = buildSubmitTools(names, new SubmissionBox());
  const server = set.server.instance as unknown as {
    connect(t: unknown): Promise<void>;
    close(): Promise<void>;
  };
  const pending = new Map<number, (m: JsonRpcMessage) => void>();
  const transport: {
    onmessage?: (m: JsonRpcMessage) => void;
    onclose?: () => void;
    onerror?: (e: unknown) => void;
    start(): Promise<void>;
    close(): Promise<void>;
    send(m: JsonRpcMessage): Promise<void>;
  } = {
    start: () => Promise.resolve(),
    close: () => Promise.resolve(),
    send: (m) => {
      if (m.id !== undefined && m.method === undefined) pending.get(m.id)?.(m);
      return Promise.resolve();
    },
  };
  await server.connect(transport);
  const request = (id: number, method: string, params: unknown): Promise<JsonRpcMessage> =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
    });
  try {
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'affidavit-probe', version: '0.0.0' },
    });
    transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await request(2, 'tools/list', {});
    const tools = (listed.result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(tools)) throw new Error('submit server returned no tool list');
    return (
      tools as { name: string; description?: string; inputSchema: Record<string, unknown> }[]
    ).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
  } finally {
    await server.close().catch(() => undefined);
  }
}

/** Which JSON Schema features a schema uses, for the report. Static text, never case content. */
export function describeSchema(schema: unknown): string {
  const counts: Record<string, number> = {};
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (
        [
          '$ref',
          'anyOf',
          'oneOf',
          'allOf',
          'propertyNames',
          'definitions',
          '$defs',
          'not',
          'additionalProperties',
        ].includes(k)
      ) {
        counts[k] = (counts[k] ?? 0) + 1;
      }
      walk(child);
    }
  };
  walk(schema);
  const top = schema as Record<string, unknown>;
  const dialect = typeof top.$schema === 'string' ? top.$schema : 'none';
  const used = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} x${n}`)
    .join(', ');
  return `$schema ${dialect}; ${JSON.stringify(schema).length} bytes; uses ${used === '' ? 'nothing notable' : used}`;
}

// ---------------------------------------------------------------------------------------------
// Running one probe.
// ---------------------------------------------------------------------------------------------

export type ProbeStatus = 'PASS' | 'FAIL' | 'SKIP' | 'REFUSED';

export interface RuntimeInfo {
  version: string;
  model: string;
  apiKeySource: string;
  permissionMode: string;
  betas: string[];
  tools: string[];
  mcpServers: string[];
}

export interface ProbeResult {
  id: string;
  name: string;
  /** The model the probe asked for. */
  model?: string;
  status: ProbeStatus;
  errorClass?: string;
  httpStatus?: number;
  /** The provider's own text, redacted. Shown only because the input was synthetic. */
  rawMessage?: string;
  /** What the real port reported (already sanitized by the port). */
  portMessage?: string;
  requestId?: string;
  /** Reported spend; undefined when unknown. */
  costUsd?: number;
  detail: string;
  runtime?: RuntimeInfo;
  stderrTail?: string[];
}

export interface ProbeDeps {
  /** The Agent SDK transport. The real one is `sdkTransport`. */
  transport: AgentTransport;
  fetch: typeof fetch;
  /** Read for the key on every probe. */
  env: () => Env;
  makeWorkdir?: () => { path: string; dispose(): void };
  timeoutMs?: number;
  /** The table the port is built with for port probes. */
  modelTable: ModelTable;
}

function defaultWorkdir(): { path: string; dispose(): void } {
  const path = mkdtempSync(join(tmpdir(), 'affidavit-probe-'));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

interface StreamFacts {
  runtime?: RuntimeInfo;
  providerError?: string;
  providerText?: string;
  requestId?: string;
  result?: {
    subtype: string;
    isError: boolean;
    status?: number;
    text?: string;
    costUsd?: number;
    numTurns?: number;
  };
  toolCalls: string[];
  replyText: string;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as { type?: unknown; text?: unknown }[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join(' ');
}

const str = (v: unknown): string => (typeof v === 'string' ? v : 'unknown');

function observe(facts: StreamFacts, msg: SDKMessage): void {
  const m = msg as unknown as Record<string, unknown>;
  if (msg.type === 'system' && m.subtype === 'init') {
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    facts.runtime = {
      version: str(m.claude_code_version),
      model: str(m.model),
      apiKeySource: str(m.apiKeySource),
      permissionMode: str(m.permissionMode),
      betas: strings(m.betas),
      tools: strings(m.tools),
      mcpServers: Array.isArray(m.mcp_servers)
        ? (m.mcp_servers as { name?: unknown; status?: unknown }[]).map(
            (s) => `${String(s.name)}:${String(s.status)}`,
          )
        : [],
    };
  } else if (msg.type === 'assistant') {
    const content = (msg.message as { content?: unknown }).content;
    if (msg.error !== undefined && facts.providerError === undefined) {
      facts.providerError = String(msg.error);
      const t = textOf(content);
      if (t !== '') facts.providerText = t;
      if (typeof m.request_id === 'string') facts.requestId = m.request_id;
    } else {
      facts.replyText += textOf(content);
      if (Array.isArray(content)) {
        for (const b of content as { type?: unknown; name?: unknown }[]) {
          if (b?.type === 'tool_use' && typeof b.name === 'string') facts.toolCalls.push(b.name);
        }
      }
      if (facts.requestId === undefined && typeof m.request_id === 'string') {
        facts.requestId = m.request_id;
      }
    }
  } else if (msg.type === 'result') {
    const errors = Array.isArray(m.errors)
      ? (m.errors as unknown[]).filter((e): e is string => typeof e === 'string').join('; ')
      : '';
    const text = typeof m.result === 'string' && m.result !== '' ? m.result : errors;
    facts.result = {
      subtype: str(m.subtype),
      isError: m.is_error === true,
      ...(Number.isInteger(m.api_error_status) ? { status: m.api_error_status as number } : {}),
      ...(text === undefined || text === '' ? {} : { text }),
      ...(typeof m.total_cost_usd === 'number' && Number.isFinite(m.total_cost_usd)
        ? { costUsd: m.total_cost_usd }
        : {}),
      ...(typeof m.num_turns === 'number' ? { numTurns: m.num_turns } : {}),
    };
  }
}

/** Drains a stream into facts, stopping at the abort signal even if the stream ignores it. */
async function drain(
  stream: AsyncIterable<SDKMessage>,
  signal: AbortSignal,
  facts: StreamFacts,
): Promise<void> {
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  const it = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([it.next(), aborted]);
      if (next === 'aborted' || next.done === true) break;
      observe(facts, next.value);
    }
  } finally {
    void Promise.resolve()
      .then(() => it.return?.())
      .catch(() => undefined);
  }
}

function factsToResult(
  spec: ProbeSpec,
  facts: StreamFacts,
  key: string,
  extra: { timedOut: boolean; streamError?: unknown; stderr: string[] },
): ProbeResult {
  const r = facts.result;
  const raw = facts.providerText ?? (r?.isError === true ? r.text : undefined);
  const failed =
    facts.providerError !== undefined ||
    extra.streamError !== undefined ||
    extra.timedOut ||
    r === undefined ||
    r.subtype === 'error_during_execution' ||
    (r.subtype === 'success' && r.isError);
  const detailParts: string[] = [];
  if (extra.timedOut) detailParts.push('timed out');
  if (extra.streamError !== undefined)
    detailParts.push(`stream error: ${describeThrown(extra.streamError, [key])}`);
  if (r === undefined) detailParts.push('no result message');
  else
    detailParts.push(
      `result ${r.subtype}${r.numTurns === undefined ? '' : `, ${r.numTurns} turn(s)`}`,
    );
  if (facts.toolCalls.length > 0) detailParts.push(`called ${facts.toolCalls.join(', ')}`);
  else if (!failed && facts.replyText.trim() !== '') {
    detailParts.push(`replied "${showRaw(facts.replyText, key).slice(0, 60)}"`);
  }
  return {
    id: spec.id,
    name: spec.name,
    status: failed ? 'FAIL' : 'PASS',
    ...(facts.providerError === undefined ? {} : { errorClass: facts.providerError }),
    ...(r?.status === undefined ? {} : { httpStatus: r.status }),
    ...(raw === undefined ? {} : { rawMessage: showRaw(raw, key) }),
    ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
    ...(r?.costUsd === undefined ? {} : { costUsd: r.costUsd }),
    detail: detailParts.join('; '),
    ...(facts.runtime === undefined ? {} : { runtime: facts.runtime }),
    ...(extra.stderr.length === 0
      ? {}
      : { stderrTail: extra.stderr.slice(-20).map((l) => showRaw(l, key)) }),
  };
}

function stderrCollector(): { lines: string[]; collect: (data: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    collect: (data: string) => {
      for (const line of data.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        lines.push(line);
        if (lines.length > 200) lines.shift();
      }
    },
  };
}

async function runSdkProbe(
  spec: ProbeSpec,
  deps: ProbeDeps,
  key: string,
  budgetUsd: number,
): Promise<ProbeResult> {
  const workdir = (deps.makeWorkdir ?? defaultWorkdir)();
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  const err = stderrCollector();
  const facts: StreamFacts = { toolCalls: [], replyText: '' };
  let streamError: unknown;
  try {
    let options: Options;
    if (spec.path === 'sdk-bare') {
      options = {
        abortController: ac,
        cwd: workdir.path,
        tools: [],
        systemPrompt: spec.system.text,
        model: spec.model,
        maxTurns: 1,
        maxBudgetUsd: budgetUsd,
        settingSources: [],
        persistSession: false,
        env: childEnv(key, workdir.path, deps.env()),
        stderr: err.collect,
      };
    } else {
      // The port's own option set; only stderr is collected instead of dropped.
      options = {
        ...buildAgentOptions({
          abortController: ac,
          workdir: workdir.path,
          tools: buildSubmitTools(spec.tools, new SubmissionBox()),
          system: spec.system.text,
          model: spec.model,
          maxTurns: 2,
          maxBudgetUsd: budgetUsd,
          key,
          parentEnv: deps.env(),
        }),
        stderr: err.collect,
      };
    }
    await drain(deps.transport({ prompt: spec.user.text, options }), ac.signal, facts);
  } catch (e) {
    streamError = e;
  } finally {
    clearTimeout(timer);
    workdir.dispose();
  }
  return factsToResult(spec, facts, key, { timedOut, streamError, stderr: err.lines });
}

async function runPortProbe(
  spec: ProbeSpec,
  deps: ProbeDeps,
  key: string,
  budgetUsd: number,
): Promise<ProbeResult> {
  const facts: StreamFacts = { toolCalls: [], replyText: '' };
  const err = stderrCollector();
  // The real transport, observed: every message is also read here, and stderr is collected.
  const tee: AgentTransport = (params) => {
    const inner = deps.transport({
      prompt: params.prompt,
      options: { ...params.options, stderr: err.collect },
    });
    return (async function* () {
      for await (const msg of inner) {
        observe(facts, msg);
        yield msg;
      }
    })();
  };
  const port = new AnthropicModelPort({
    mode: 'live',
    modelTable: deps.modelTable,
    timeoutMs: deps.timeoutMs ?? PROBE_TIMEOUT_MS,
    transport: tee,
    env: deps.env,
    ...(deps.makeWorkdir === undefined ? {} : { makeWorkdir: deps.makeWorkdir }),
  });
  const req: ModelTurnRequest = {
    promptId: 'defense',
    promptVersion: spec.promptVersion ?? getPrompt('defense').version,
    model: spec.model,
    system: spec.system.text,
    user: spec.user.text,
    tools: spec.tools,
    outputSchemaRef: spec.outputSchemaRef ?? getPrompt('defense').outputSchemaRef,
    maxTurns: 2,
    budget: { maxInputTokens: 200_000, maxOutputTokens: 2_000, maxUsd: budgetUsd },
  };
  let outcome: string | undefined;
  let portError: unknown;
  try {
    outcome = (await port.runTurn(req)).outcome;
  } catch (e) {
    portError = e;
  }
  const base = factsToResult(spec, facts, key, { timedOut: false, stderr: err.lines });
  const portMessage = portError === undefined ? undefined : describeThrown(portError, [key]);
  return {
    ...base,
    status: portError === undefined ? 'PASS' : 'FAIL',
    ...(portMessage === undefined ? {} : { portMessage }),
    detail: [outcome === undefined ? 'port threw' : `port outcome ${outcome}`, base.detail].join(
      '; ',
    ),
  };
}

async function runFetchProbe(spec: ProbeSpec, deps: ProbeDeps, key: string): Promise<ProbeResult> {
  const body: Record<string, unknown> = {
    model: spec.model,
    max_tokens: FETCH_MAX_TOKENS,
    system: spec.system.text,
    messages: [{ role: 'user', content: spec.user.text }],
  };
  let schemaNote: string | undefined;
  if (spec.tools.length > 0) {
    const tools = await advertisedTools(spec.tools);
    body.tools = tools.map((t) => {
      const schema = { ...t.inputSchema };
      if (spec.stripSchemaKeyword === true) delete schema.$schema;
      return {
        name: qualifiedToolName(t.name as SubmitToolName),
        description: t.description,
        input_schema: schema,
      };
    });
    schemaNote = (body.tools as { input_schema: unknown }[])
      .map((t) => describeSchema(t.input_schema))
      .join(' | ');
  }
  let res: Response;
  try {
    res = await deps.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      id: spec.id,
      name: spec.name,
      status: 'FAIL',
      errorClass: 'network',
      detail: `request failed: ${describeThrown(e, [key])}`,
    };
  }
  const text = await res.text().catch(() => '');
  const requestId = res.headers.get('request-id') ?? undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  const detail: string[] = [`HTTP ${res.status}`];
  if (schemaNote !== undefined) detail.push(`tool schema: ${schemaNote}`);
  if (res.ok) {
    const usage = parsed?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const content = parsed?.content as { type?: string; name?: string }[] | undefined;
    const called = (content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name);
    detail.push(`stop ${String(parsed?.stop_reason)}`);
    if (usage !== undefined)
      detail.push(`tokens in ${usage.input_tokens} out ${usage.output_tokens}`);
    if (called.length > 0) detail.push(`called ${called.join(', ')}`);
    return {
      id: spec.id,
      name: spec.name,
      status: 'PASS',
      httpStatus: res.status,
      ...(requestId === undefined ? {} : { requestId }),
      detail: detail.join('; '),
    };
  }
  const error = parsed?.error as { type?: unknown; message?: unknown } | undefined;
  const message = typeof error?.message === 'string' ? error.message : text;
  return {
    id: spec.id,
    name: spec.name,
    status: 'FAIL',
    ...(typeof error?.type === 'string' ? { errorClass: error.type } : {}),
    httpStatus: res.status,
    ...(message === '' ? {} : { rawMessage: showRaw(message, key) }),
    ...(requestId === undefined ? {} : { requestId }),
    detail: detail.join('; '),
  };
}

export interface LadderRun {
  results: ProbeResult[];
  /** Reported spend plus the reserve for every probe whose spend is unknown. */
  chargedUsd: number;
}

export interface RunOptions {
  maxUsd?: number;
  reserveUsd?: number;
  onResult?: (r: ProbeResult) => void;
}

/**
 * Runs every probe in order and never stops early, so one run gives the whole picture. A probe
 * with non-synthetic input is refused without any call. A probe that would take the total past
 * the USD cap is skipped. The key is read again before every probe.
 */
export async function runLadder(
  ladder: readonly ProbeSpec[],
  deps: ProbeDeps,
  opts: RunOptions = {},
): Promise<LadderRun> {
  const maxUsd = opts.maxUsd ?? DEFAULT_MAX_USD;
  const reserve = opts.reserveUsd ?? DEFAULT_RESERVE_USD;
  if (!(maxUsd > 0) || maxUsd > MAX_ALLOWED_USD) {
    throw new RangeError(`the USD cap must be above 0 and at most ${MAX_ALLOWED_USD}`);
  }
  if (!(reserve > 0) || reserve > maxUsd)
    throw new RangeError('the per-probe reserve must be above 0 and at most the cap');
  const results: ProbeResult[] = [];
  let charged = 0;
  const push = (r: ProbeResult): void => {
    results.push(r);
    opts.onResult?.(r);
  };
  for (const spec of ladder) {
    if (!isSynthetic(spec.system) || !isSynthetic(spec.user)) {
      push({
        id: spec.id,
        name: spec.name,
        status: 'REFUSED',
        detail: new NonSyntheticInputError(spec.id).message,
      });
      continue;
    }
    if (charged + reserve > maxUsd + 1e-9) {
      push({
        id: spec.id,
        name: spec.name,
        status: 'SKIP',
        detail: `USD cap: ${charged.toFixed(4)} charged of ${maxUsd.toFixed(2)}`,
      });
      continue;
    }
    const key = readProbeKey(deps.env());
    let r: ProbeResult;
    try {
      r =
        spec.path === 'fetch'
          ? await runFetchProbe(spec, deps, key)
          : spec.path === 'port'
            ? await runPortProbe(spec, deps, key, reserve)
            : await runSdkProbe(spec, deps, key, reserve);
    } catch (e) {
      r = {
        id: spec.id,
        name: spec.name,
        status: 'FAIL',
        errorClass: 'probe-error',
        detail: describeThrown(e, [key]),
      };
    }
    charged += r.costUsd ?? reserve;
    push({ ...r, model: spec.model });
  }
  return { results, chargedUsd: charged };
}

// ---------------------------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------------------------

export const BANNER = [
  'Affidavit model probe (L3-17)',
  'RAW PROVIDER TEXT IS SHOWN below, after key redaction, because every probe input is fixed synthetic text.',
  'No case file and no repository content is sent. A probe whose input is not synthetic is refused.',
  'P6 probes call https://api.anthropic.com/v1/messages directly and bypass the Agent SDK.',
].join('\n');

const statusOf = (results: readonly ProbeResult[], id: string): ProbeStatus | undefined =>
  results.find((r) => r.id === id)?.status;

/** One line per failure pattern the results show. */
export function interpret(results: readonly ProbeResult[]): string[] {
  const out: string[] = [];
  const s = (id: string) => statusOf(results, id);
  const p2 = results.filter((r) => r.id.startsWith('P2:'));
  const p2Fail = p2.filter((r) => r.status === 'FAIL').map((r) => r.id.slice(3));
  const p2Pass = p2.filter((r) => r.status === 'PASS').map((r) => r.id.slice(3));
  if (s('P1') === 'FAIL') {
    out.push(
      'P1 fails: key or organization problem (or the runtime cannot start). Read the P1 raw message and fix it in the Console first; later probes mean little until P1 passes.',
    );
  }
  if (p2Fail.length > 0) {
    out.push(
      `P2: these model ids fail: ${p2Fail.join(', ')}. The organization may not have access to them; set the matching ANTHROPIC_MODEL_<PROMPT> to an id that works.`,
    );
  }
  if (p2Pass.length > 0) out.push(`P2: these model ids work: ${p2Pass.join(', ')}.`);
  const defenseModel = results.find((r) => r.id === 'P3')?.model;
  const defenseBare = defenseModel === undefined ? undefined : s(`P2:${defenseModel}`);
  if (defenseBare === 'FAIL') {
    out.push(
      `The Defense model ${defenseModel} fails even on a bare request (P2), so P3 to P6 failing on it says nothing more: fix the model id or the organization's access first.`,
    );
  } else if (s('P1') === 'PASS' && s('P3') === 'FAIL') {
    out.push(
      'P3 fails with P1 passing: the SDK option set the port builds (buildAgentOptions) is refused.',
    );
  }
  if (s('P3') === 'PASS' && s('P4a') === 'FAIL') {
    out.push(
      'P3 passes and P4a fails: the advertised submit tool schema (submitInputShape in submit-tools.ts) is refused.',
    );
  }
  if (s('P4a') === 'PASS' && s('P4b') === 'FAIL') {
    out.push(
      'P4a passes and P4b fails: the packaged Defense system prompt, or the port request path around it, is refused.',
    );
  }
  if (s('P4b') === 'PASS' && s('P5') === 'FAIL') {
    out.push('P4b passes and P5 fails: request size. Check the case file size and the token caps.');
  }
  if (s('P6a') === 'PASS' && s('P6b') === 'FAIL') {
    out.push(
      s('P6c') === 'PASS'
        ? 'P6b fails and P6c passes: the API refuses the top-level $schema keyword of the tool schema.'
        : 'P6a passes and P6b fails: the API itself refuses the submit tool schema; the P6b raw message says why.',
    );
  }
  if (s('P6a') === 'FAIL' && s('P1') === 'PASS') {
    out.push(
      'P6a fails while P1 passes: the Defense model id or the direct request is refused; compare with P2.',
    );
  }
  if (results.some((r) => r.status === 'SKIP'))
    out.push('Some probes were skipped by the USD cap; rerun with a higher --max-usd to see them.');
  if (results.some((r) => r.status === 'REFUSED'))
    out.push('Some probes were refused because their input was not synthetic.');
  if (results.length > 0 && results.every((r) => r.status === 'PASS')) {
    out.push(
      'Every probe passed: the failure depends on the real case content, the real turn count or budget, or a case file larger than P5.',
    );
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function formatResult(r: ProbeResult): string {
  const lines = [`${r.id}  ${r.status}  ${r.name}`];
  lines.push(
    `  class: ${r.errorClass ?? '-'}   HTTP: ${r.httpStatus ?? '-'}   cost: ${r.costUsd === undefined ? 'unknown' : `$${r.costUsd.toFixed(4)}`}`,
  );
  lines.push(`  detail: ${r.detail}`);
  if (r.rawMessage !== undefined) lines.push(`  provider raw message (redacted): ${r.rawMessage}`);
  if (r.portMessage !== undefined) lines.push(`  port said: ${r.portMessage}`);
  if (r.requestId !== undefined) lines.push(`  request id: ${r.requestId}`);
  if (r.runtime !== undefined) {
    const rt = r.runtime;
    lines.push(
      `  runtime: version ${rt.version}, model ${rt.model}, key source ${rt.apiKeySource}, permission ${rt.permissionMode}`,
    );
    lines.push(`  runtime betas: ${rt.betas.length === 0 ? 'none' : rt.betas.join(', ')}`);
    lines.push(
      `  runtime tools: ${rt.tools.length === 0 ? 'none' : rt.tools.join(', ')}; mcp: ${rt.mcpServers.length === 0 ? 'none' : rt.mcpServers.join(', ')}`,
    );
  }
  if (r.stderrTail !== undefined) {
    lines.push('  runtime stderr (last lines, redacted):');
    for (const l of r.stderrTail) lines.push(`    ${l}`);
  }
  return lines.join('\n');
}

export function formatSummary(run: LadderRun, maxUsd: number): string {
  const w = Math.max(4, ...run.results.map((r) => r.id.length));
  const lines = [
    'Summary',
    `${pad('id', w)}  ${pad('status', 7)}  ${pad('class', 24)}  ${pad('HTTP', 4)}  cost`,
  ];
  for (const r of run.results) {
    lines.push(
      `${pad(r.id, w)}  ${pad(r.status, 7)}  ${pad(r.errorClass ?? '-', 24)}  ${pad(String(r.httpStatus ?? '-'), 4)}  ${r.costUsd === undefined ? 'unknown' : `$${r.costUsd.toFixed(4)}`}`,
    );
  }
  lines.push(
    `Charged against the cap: $${run.chargedUsd.toFixed(4)} of $${maxUsd.toFixed(2)} (unknown spend counts as the full per-probe reserve; the SDK cost is an estimate, not a bill).`,
  );
  lines.push('', 'Interpretation');
  for (const l of interpret(run.results)) lines.push(`- ${l}`);
  return lines.join('\n');
}
