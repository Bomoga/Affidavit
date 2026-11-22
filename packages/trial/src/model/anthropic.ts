import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { PromptId, type CaseStage, type StageCost } from '@affidavit/contracts';
import { getPrompt } from '@affidavit/prompts';
import { KillSwitchError, type ModelTurnRequest, type ModelTurnResult } from '../orchestrator.js';
import { ROLE_TOOLS, assertAllowedTools } from '../roles.js';
import {
  ModelCallError,
  ModelConfigError,
  ModelUnconfiguredError,
  type ProviderFailure,
} from './errors.js';
import { isKnownModelId, type ModelTable } from './models.js';
import type { PreflightModelPort } from './preflight.js';
import { FileRecordingStore, type RecordingStore } from './recordings.js';
import { containsSecret, describeThrown, redact } from './redact.js';
import {
  DENIED_BUILTIN_TOOLS,
  SUBMIT_SERVER_NAME,
  SubmissionBox,
  buildSubmitTools,
  type SubmitToolSet,
} from './submit-tools.js';
import { sdkTransport, type AgentTransport } from './transport.js';

export type ModelMode = 'live' | 'record' | 'replay';
export const MODEL_MODES: readonly ModelMode[] = ['live', 'record', 'replay'];

/** The only place the key is read from, at call time. */
export const API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';

type Env = Readonly<Record<string, string | undefined>>;

export interface ModelLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface AnthropicModelPortConfig {
  mode: ModelMode;
  /** Which model each prompt runs on. A request naming any other model is refused. */
  modelTable: ModelTable;
  /** Hard wall-clock cap per turn, in milliseconds. */
  timeoutMs: number;
  transport?: AgentTransport;
  /** Required for record and replay; defaults to `fixtures/models/`. */
  recordings?: RecordingStore;
  /** Read on every call, so a key set or rotated later is picked up and never cached here. */
  env?: () => Env;
  /** The global kill switch. Polled while a turn runs; tripping it aborts the turn. */
  killSwitch?: () => boolean | Promise<boolean>;
  killSwitchPollMs?: number;
  /** Every message is redacted before it gets here. */
  log?: (entry: ModelLogEntry) => void;
  /** A fresh empty directory per turn, removed afterwards. */
  makeWorkdir?: () => { path: string; dispose(): void };
  now?: () => number;
}

function stageFor(promptId: PromptId): CaseStage {
  if (promptId === 'defense' || promptId === 'defense-second-attempt') return 'defense';
  if (promptId === 'prosecution' || promptId === 'remedy') return promptId;
  return 'jury';
}

function defaultWorkdir(): { path: string; dispose(): void } {
  const path = mkdtempSync(join(tmpdir(), 'affidavit-agent-'));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * The agent process environment. It replaces the parent environment entirely: the key, a PATH so
 * the runtime can start, and home, config and temp directories pointed at the empty per-turn
 * directory so no user or project settings, memory, or CLAUDE.md can be picked up.
 */
export function childEnv(key: string, workdir: string, parent: Env): Record<string, string> {
  const env: Record<string, string> = {
    [API_KEY_ENV_VAR]: key,
    HOME: workdir,
    USERPROFILE: workdir,
    CLAUDE_CONFIG_DIR: join(workdir, '.claude'),
    TMPDIR: workdir,
    TEMP: workdir,
    TMP: workdir,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'affidavit-trial/0.0.0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec']) {
    const v = parent[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

export interface AgentOptionsInput {
  abortController: AbortController;
  /** The fresh empty per-turn directory: cwd, home, config and temp. */
  workdir: string;
  tools: SubmitToolSet;
  system: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  key: string;
  parentEnv: Env;
}

/**
 * The SDK options of one agent turn. The port uses exactly this, and the diagnostic probe
 * (`scripts/probe-model.ts`) calls it too, so a probe exercises the same option set.
 */
export function buildAgentOptions(i: AgentOptionsInput): Options {
  return {
    abortController: i.abortController,
    cwd: i.workdir,
    additionalDirectories: [],
    // No built-in tools at all; the submit tools are the only tools the agent has.
    tools: [],
    allowedTools: i.tools.allowedTools,
    disallowedTools: [...DENIED_BUILTIN_TOOLS],
    // Anything not pre-approved is denied; nothing can prompt, and nothing runs code.
    permissionMode: 'dontAsk',
    mcpServers: { [SUBMIT_SERVER_NAME]: i.tools.server },
    strictMcpConfig: true,
    settingSources: [],
    skills: [],
    plugins: [],
    agents: {},
    hooks: i.tools.hooks,
    systemPrompt: i.system,
    model: i.model,
    maxTurns: i.maxTurns,
    maxBudgetUsd: i.maxBudgetUsd,
    persistSession: false,
    enableFileCheckpointing: false,
    includePartialMessages: false,
    env: childEnv(i.key, i.workdir, i.parentEnv),
    stderr: () => undefined,
  };
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

function resultUsage(result: SDKResultMessage): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  const models = Object.values(result.modelUsage ?? {});
  if (models.length > 0) {
    for (const m of models) {
      inputTokens += m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
      outputTokens += m.outputTokens;
    }
  } else {
    const u = result.usage;
    inputTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    outputTokens = u.output_tokens;
  }
  return { inputTokens, outputTokens };
}

const toInt = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0);

/** A key the HTTP runtime will accept as a header value: printable ASCII, no spaces. */
export const KEY_SHAPE = /^[\x21-\x7e]+$/;

/**
 * Provider error classes decided before the model does any work, so a call that failed with one
 * of them and reported no usage spent nothing. Any other class keeps the up-front charge.
 */
export const REFUSED_BEFORE_WORK: ReadonlySet<string> = new Set([
  'invalid_request',
  'rate_limit',
  'billing_error',
  'authentication_failed',
]);

/** Longest provider message an error carries. */
export const PROVIDER_MESSAGE_MAX = 300;
/** Shown in place of provider text that matches no known-safe shape. */
export const PROVIDER_MESSAGE_WITHHELD =
  'provider message withheld (does not match a known-safe shape)';
/** Longest provider text the templates are matched against. Longer text is withheld. */
const PROVIDER_SCAN_MAX = 16_384;

/** Request fields an API validation path may start with. */
const PATH_ROOTS =
  'tools|messages|system|thinking|output_config|max_tokens|temperature|top_p|top_k|metadata|stop_sequences';
/** Validation reasons shown after a path. Anything else after a path is not shown. */
const PATH_REASONS = [
  'JSON schema is invalid',
  'Field required',
  'Extra inputs are not permitted',
  'Input should be a valid string',
  'Input should be a valid dictionary',
  'Input should be a valid list',
  'String should have at least 1 character',
  'text content blocks must be non-empty',
  'text content blocks must contain non-whitespace text',
  'unexpected tool_use_id found in tool_result blocks',
  'does not support oneOf, allOf, or anyOf at the top level',
] as const;
/** Names a validation path may contain after its root: request structure, never case content. */
const PATH_NAMES =
  '(?:content|text|type|input_schema|custom|name|description|source|tool_use_id|tool_result|tool_use|image|document|media_type|data|properties|items|role|cache_control|budget_tokens|effort|format|input|id|display)(?![A-Za-z0-9_])';
const MODEL_ID = String.raw`claude-[a-z]{2,10}(?:-[0-9]{1,2}){1,3}`;
const PARAMS = 'temperature|top_p|top_k|budget_tokens|thinking\\.type|effort';

interface Template {
  pattern: RegExp;
  /** Builds the shown fragment from fixed text and the strictly shaped captures only. */
  show: (m: RegExpExecArray) => string;
}

/**
 * Every shape of provider text that may be shown. Each template rebuilds its fragment from fixed
 * text plus captures that are digits, a strictly shaped model id, or a validation path made of
 * known roots, indices and short snake_case names. No free text from the provider is forwarded.
 */
const TEMPLATES: readonly Template[] = [
  { pattern: /Invalid API key/i, show: () => 'Invalid API key' },
  { pattern: /Invalid X-Api-Key header value/i, show: () => 'Invalid X-Api-Key header value' },
  { pattern: /organization has been disabled/i, show: () => 'organization has been disabled' },
  { pattern: /credit balance is too low/i, show: () => 'credit balance is too low' },
  { pattern: /\brate[ _-]?limit/i, show: () => 'rate limit' },
  { pattern: /\boverloaded\b/i, show: () => 'overloaded' },
  {
    pattern: /prompt is too long: ([0-9]{1,9}) tokens > ([0-9]{1,9}) maximum/,
    show: (m) => `prompt is too long: ${m[1]} tokens > ${m[2]} maximum`,
  },
  {
    pattern: /max_tokens: ([0-9]{1,9}) > ([0-9]{1,9}), which is the maximum allowed/,
    show: (m) => `max_tokens: ${m[1]} > ${m[2]}, which is the maximum allowed`,
  },
  {
    pattern: /tool_choice: type "tool" and "any" are not supported/,
    show: () => 'tool_choice: type "tool" and "any" are not supported',
  },
  {
    pattern: new RegExp(String.raw`\b(${PARAMS})\b[^.;]{0,80}?\b(?:not supported|not allowed)`),
    show: (m) => `${m[1]}: not supported`,
  },
  {
    pattern: new RegExp(String.raw`\bmodel: (${MODEL_ID})(?![A-Za-z0-9_-])`),
    show: (m) => `model: ${m[1]}`,
  },
  {
    pattern: new RegExp(
      String.raw`\b((?:${PATH_ROOTS})(?:\.(?:[0-9]{1,4}|${PATH_NAMES})){0,8})(?![A-Za-z0-9_.]): ?([^\n]{0,200})`,
    ),
    show: (m) => {
      const reason = PATH_REASONS.find((r) => (m[2] ?? '').includes(r));
      return `${m[1]}: ${reason ?? '(reason withheld)'}`;
    },
  },
];

/** The provider's error type from a JSON body, only in the closed snake_case shape. */
const ERROR_TYPE = /^[a-z_]{1,40}$/;

/** Decodes the first JSON error body in `text`, if there is one; otherwise undefined. */
function decodeErrorBody(text: string): { type?: string; message?: string } | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start)) as unknown;
    const err = (parsed as { error?: unknown } | null)?.error as
      { type?: unknown; message?: unknown } | undefined;
    if (err === null || typeof err !== 'object') return undefined;
    return {
      ...(typeof err.type === 'string' ? { type: err.type } : {}),
      ...(typeof err.message === 'string' ? { message: err.message } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The provider's own error text, reduced to what is known to be safe for an error message and a
 * log line. It fails closed: a JSON error body is decoded, the text is redacted (the key by value
 * and every credential pattern), and then only fragments rebuilt from the allowlisted
 * templates above are shown. Anything else, including any echo of the request or case content
 * in whatever encoding, becomes `PROVIDER_MESSAGE_WITHHELD`. Never the request body.
 */
export function sanitizeProviderMessage(
  text: string,
  secrets: readonly string[],
): string | undefined {
  if (text.trim() === '') return undefined;
  if (text.length > PROVIDER_SCAN_MAX) return PROVIDER_MESSAGE_WITHHELD;
  // Decoded before redaction, so a redaction cannot break the JSON. Each decoded field is then
  // redacted on its own, and no free text from it is forwarded anyway.
  const decoded = decodeErrorBody(text);
  const body =
    decoded === undefined
      ? undefined
      : {
          ...(decoded.type === undefined ? {} : { type: redact(decoded.type, secrets) }),
          ...(decoded.message === undefined ? {} : { message: redact(decoded.message, secrets) }),
        };
  const subject = body?.message ?? redact(text, secrets);
  const shown: string[] = [];
  if (body?.type !== undefined && ERROR_TYPE.test(body.type)) shown.push(body.type);
  for (const t of TEMPLATES) {
    const m = t.pattern.exec(subject);
    if (m === null) continue;
    const fragment = t.show(m);
    if (!shown.includes(fragment)) shown.push(fragment);
  }
  // An error type alone says nothing beyond the class; withhold rather than imply more.
  if (shown.length === 0 || (shown.length === 1 && body?.type === shown[0])) {
    return shown.length === 0
      ? PROVIDER_MESSAGE_WITHHELD
      : `${shown[0]}; ${PROVIDER_MESSAGE_WITHHELD}`;
  }
  const out = shown.join('; ');
  return out.length > PROVIDER_MESSAGE_MAX ? `${out.slice(0, PROVIDER_MESSAGE_MAX)}...` : out;
}

/** The text blocks of a runtime message, which for a provider error hold the provider's text. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as unknown[]) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b !== null && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join(' ');
}

function describeProvider(p: ProviderFailure): string {
  const status = p.status === undefined ? '' : ` (HTTP ${p.status})`;
  const said = p.message === undefined ? '' : `: ${p.message}`;
  return `provider error ${p.errorClass}${status}${said}`;
}

/**
 * ModelPort on the Claude Agent SDK. One `runTurn` is one agent session that can do exactly one
 * thing: call the role's submit tool. The agent has no shell, no file tools, no network tools, no
 * MCP servers of its own, no skills, plugins or subagents, and no settings or CLAUDE.md from any
 * directory. Its working directory is a fresh empty directory that is deleted afterwards.
 *
 * The API key is read from `ANTHROPIC_API_KEY` on every call and goes only into the agent
 * process environment. It is never logged, never put in an error, an event, or a recording, and
 * never stored on this object.
 */
export class AnthropicModelPort implements PreflightModelPort {
  private readonly transport: AgentTransport;
  private readonly recordings: RecordingStore | undefined;
  private readonly env: () => Env;
  private readonly inflight = new Set<() => void>();

  constructor(private readonly config: AnthropicModelPortConfig) {
    if (!MODEL_MODES.includes(config.mode)) throw new ModelConfigError('unknown model mode');
    if (!(config.timeoutMs > 0)) throw new ModelConfigError('timeoutMs must be positive');
    this.transport = config.transport ?? sdkTransport;
    this.env = config.env ?? (() => process.env);
    // Record mode writes files, so where they go must be chosen explicitly, never defaulted.
    if (config.mode === 'record' && config.recordings === undefined) {
      throw new ModelConfigError('record mode needs an explicit recording store');
    }
    this.recordings =
      config.recordings ?? (config.mode === 'replay' ? new FileRecordingStore() : undefined);
  }

  /** Aborts every turn in flight; each one throws KillSwitchError. */
  abortAll(): void {
    for (const abort of [...this.inflight]) abort();
  }

  /**
   * Everything that can refuse a call without spending money. Throws ModelConfigError for a
   * request the deployment should never make, and ModelUnconfiguredError when a live call has
   * no key.
   */
  preflight(req: ModelTurnRequest): Promise<void> {
    try {
      this.check(req);
      if (this.config.mode !== 'replay') this.readKey();
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async runTurn(req: ModelTurnRequest): Promise<ModelTurnResult> {
    await this.preflight(req);
    if (this.config.mode === 'replay') {
      // recordings is always set outside live mode.
      return this.recordings!.read(req);
    }
    const key = this.readKey();
    const result = await this.live(req, key);
    if (this.config.mode === 'record') await this.recordings!.write(req, result, [key]);
    return result;
  }

  private check(req: ModelTurnRequest): void {
    const id = PromptId.safeParse(req.promptId);
    if (!id.success) throw new ModelConfigError('unknown prompt id');
    const prompt = getPrompt(id.data);
    // The system prompt must be the packaged one, so no case or app text can reach it.
    if (
      req.promptVersion !== prompt.version ||
      req.system !== prompt.system ||
      req.outputSchemaRef !== prompt.outputSchemaRef
    ) {
      throw new ModelConfigError(
        `prompt ${id.data} does not match the packaged prompt ${prompt.version}`,
      );
    }
    assertAllowedTools(prompt.role, req.tools);
    if (req.tools.length === 0) throw new ModelConfigError('a turn needs its submit tool');
    if (!isKnownModelId(req.model)) throw new ModelConfigError('unknown model id');
    if (req.model !== this.config.modelTable[id.data]) {
      throw new ModelConfigError(`model for prompt ${id.data} does not match the model table`);
    }
    if (!Number.isInteger(req.maxTurns) || req.maxTurns < 1) {
      throw new ModelConfigError('maxTurns must be a positive integer');
    }
  }

  private readKey(): string {
    const key = this.env()[API_KEY_ENV_VAR];
    if (key === undefined || key.trim() === '') {
      throw new ModelUnconfiguredError(`${API_KEY_ENV_VAR} is not set`);
    }
    // The runtime refuses a key that is not a valid HTTP header value before it sends anything,
    // and reports that as `invalid_request`, after the orchestrator has charged the turn. A key
    // with a trailing newline or CR (a CRLF env file, `$(cat key)`), a space, pasted quotes, or
    // any non-ASCII character is refused here instead, before any charge. The message names the
    // problem, never the value.
    if (!KEY_SHAPE.test(key)) {
      throw new ModelUnconfiguredError(
        `${API_KEY_ENV_VAR} contains whitespace, a line break, or a character that is not printable ASCII; set it to the bare key`,
      );
    }
    return key;
  }

  private log(level: ModelLogEntry['level'], message: string, secrets: readonly string[]): void {
    this.config.log?.({ level, message: redact(message, secrets) });
  }

  private async live(req: ModelTurnRequest, key: string): Promise<ModelTurnResult> {
    const secrets = [key];
    const promptId = PromptId.parse(req.promptId);
    const role = getPrompt(promptId).role;
    const now = this.config.now ?? Date.now;
    const started = now();

    if (await this.config.killSwitch?.()) throw new KillSwitchError();

    const box = new SubmissionBox();
    const tools = buildSubmitTools(ROLE_TOOLS[role], box);
    const workdir = (this.config.makeWorkdir ?? defaultWorkdir)();
    const ac = new AbortController();
    let killed = false;
    let timedOut = false;
    let overBudget = false;
    let authFailed = false;
    let providerError: string | undefined;
    // The provider's own words for the first error, kept raw here and sanitized before use.
    let providerText: string | undefined;
    let result: SDKResultMessage | undefined;
    const seen = new Map<string, Usage>();

    const kill = (): void => {
      killed = true;
      ac.abort();
    };
    this.inflight.add(kill);
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.config.timeoutMs);
    const poll =
      this.config.killSwitch === undefined
        ? undefined
        : setInterval(() => {
            void Promise.resolve(this.config.killSwitch?.()).then(
              (on) => {
                if (on) kill();
              },
              () => kill(),
            );
          }, this.config.killSwitchPollMs ?? 250);

    const options: Options = buildAgentOptions({
      abortController: ac,
      workdir: workdir.path,
      tools,
      system: req.system,
      model: req.model,
      maxTurns: req.maxTurns,
      maxBudgetUsd: req.budget.maxUsd,
      key,
      parentEnv: this.env(),
    });

    const tokens = (): Usage => {
      let inputTokens = 0;
      let outputTokens = 0;
      for (const u of seen.values()) {
        inputTokens += u.inputTokens;
        outputTokens += u.outputTokens;
      }
      return { inputTokens, outputTokens };
    };
    const exceeds = (u: Usage): boolean =>
      u.inputTokens > req.budget.maxInputTokens || u.outputTokens > req.budget.maxOutputTokens;

    // Resolves when the turn is aborted, so a stream that ignores the abort still ends here.
    const aborted = new Promise<'aborted'>((resolve) => {
      if (ac.signal.aborted) resolve('aborted');
      ac.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    let streamError: unknown;
    let iterator: AsyncIterator<SDKMessage> | undefined;
    try {
      iterator = this.transport({ prompt: req.user, options })[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === 'aborted' || next.done === true) break;
        const msg = next.value;
        if (killed) break;
        if (msg.type === 'assistant') {
          if (msg.error === 'authentication_failed') authFailed = true;
          else if (msg.error !== undefined && providerError === undefined) {
            // Any other provider error (overloaded, rate_limit, server_error, billing_error, and
            // the rest) is a call error on its own, whatever the result later says. Only a code
            // from the closed snake_case set goes into the message.
            const code = String(msg.error);
            providerError = /^[a-z_]{1,40}$/.test(code) ? code : 'unrecognised';
            // The runtime puts the provider's error text (for an API error, the status and the
            // provider's message) in the content of this synthetic assistant message.
            const text = messageText((msg.message as { content?: unknown }).content);
            if (text !== '') providerText = text;
          }
          const u = msg.message.usage;
          seen.set(msg.message.id, {
            inputTokens:
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0),
            outputTokens: u.output_tokens ?? 0,
          });
          if (exceeds(tokens())) {
            overBudget = true;
            ac.abort();
            break;
          }
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    } catch (err) {
      streamError = err;
    } finally {
      clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      this.inflight.delete(kill);
      // Ask a stream that is still open to close; never wait on it, since it may be hung.
      void Promise.resolve()
        .then(() => iterator?.return?.())
        .catch(() => undefined);
      workdir.dispose();
    }

    if (killed) throw new KillSwitchError();
    if (authFailed) throw new ModelUnconfiguredError('the provider rejected the API key');

    const wallMs = Math.max(0, Math.round(result?.duration_ms ?? now() - started));
    let used: Usage;
    let usd: number;
    if (result !== undefined) {
      const fromResult = resultUsage(result);
      const fromStream = tokens();
      used = {
        inputTokens: Math.max(fromResult.inputTokens, fromStream.inputTokens),
        outputTokens: Math.max(fromResult.outputTokens, fromStream.outputTokens),
      };
      usd = Number.isFinite(result.total_cost_usd) ? Math.max(0, result.total_cost_usd) : 0;
    } else {
      // Cut off before the runtime reported a cost. The true figure is unknown, so report the
      // whole turn budget rather than a number nobody measured.
      used = tokens();
      usd = req.budget.maxUsd;
    }
    const cost: StageCost = {
      stage: stageFor(promptId),
      attempt: 1,
      inputTokens: toInt(used.inputTokens),
      outputTokens: toInt(used.outputTokens),
      usd,
      wallMs,
    };

    // What a failed call spent, for the orchestrator to settle its up-front charge against.
    // Known when the runtime reported a result. Also known, as zero, when the provider refused
    // the request with a class that is decided before any work (a refused request is not billed)
    // and the stream then ended cleanly with no tokens. Every other class with no result
    // (server_error, overloaded, max_output_tokens, unknown, unrecognised and the rest) may have
    // failed after work started, so its spend is unknown. Unknown (undefined) also for a timeout,
    // an abort or a broken stream: the whole up-front charge stands there.
    const refusedBeforeUsage =
      result === undefined &&
      providerError !== undefined &&
      REFUSED_BEFORE_WORK.has(providerError) &&
      !timedOut &&
      !overBudget &&
      streamError === undefined &&
      used.inputTokens === 0 &&
      used.outputTokens === 0;
    const failureCost: StageCost | undefined =
      result !== undefined ? cost : refusedBeforeUsage ? { ...cost, usd: 0 } : undefined;
    const callError = (message: string, provider?: ProviderFailure): ModelCallError =>
      new ModelCallError(message, {
        ...(failureCost === undefined ? {} : { cost: failureCost }),
        ...(provider === undefined ? {} : { provider }),
      });

    // Only the agent's own behaviour maps to an outcome. A provider failure (wall-clock timeout,
    // a hung or broken stream, a stream with no result, an execution error) is a call error
    // unless the agent had already submitted, so an outage can never read as "no submission"
    // and dismiss a candidate.
    const outcome = ((): ModelTurnResult['outcome'] => {
      if (overBudget) return 'budget-exhausted';
      if (!box.captured) {
        if (timedOut) {
          throw callError('agent turn hit the wall-clock cap before any submission');
        }
        if (providerError !== undefined) {
          const status =
            result?.subtype === 'success' && Number.isInteger(result.api_error_status)
              ? (result.api_error_status as number)
              : undefined;
          const raw =
            providerText ??
            (result?.is_error === true
              ? result.subtype === 'success'
                ? result.result
                : result.errors.join('; ')
              : undefined);
          const message = raw === undefined ? undefined : sanitizeProviderMessage(raw, secrets);
          const provider: ProviderFailure = {
            errorClass: providerError,
            ...(status === undefined ? {} : { status }),
            ...(message === undefined ? {} : { message }),
          };
          const text = `agent turn failed: ${describeProvider(provider)}`;
          this.log('warn', `model turn ${promptId} on ${req.model}: ${text}`, secrets);
          throw callError(text, provider);
        }
        if (streamError !== undefined) {
          throw callError(`agent turn failed: ${describeThrown(streamError, secrets)}`);
        }
      }
      if (exceeds(used) || result?.subtype === 'error_max_budget_usd') return 'budget-exhausted';
      if (box.captured) return 'submitted';
      if (result === undefined) throw callError('agent stream ended without a result');
      // The agent used every turn it had and never called its submit tool.
      if (result.subtype === 'error_max_turns') return 'turn-cap';
      if (result.subtype === 'error_during_execution' || result.is_error) {
        const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
        // Runtime and provider text: only known-safe shapes are shown, as for a provider error.
        const shown = sanitizeProviderMessage(detail, secrets) ?? 'no detail';
        throw callError(`agent turn failed: ${result.subtype}: ${shown}`);
      }
      return 'no-submission';
    })();

    const out: ModelTurnResult = { outcome, cost };
    if (box.captured) {
      // The submission is passed on exactly as the agent sent it: the Judge must run the witness
      // the agent submitted, and the exhibit must match it byte for byte, so no pattern-based
      // redaction ever touches it. The one thing it may never carry is the key itself; a
      // submission containing it is refused, not passed on and not recorded.
      if (containsSecret(box.submission, secrets)) {
        throw new ModelCallError('the agent submission contained the API key and was refused');
      }
      out.submission = box.submission;
    }
    this.log(
      'info',
      `model turn ${promptId} on ${req.model} ended ${outcome}${timedOut ? ' (wall-clock cap)' : ''}`,
      secrets,
    );
    return out;
  }
}
