import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { PromptId, type CaseStage, type StageCost } from '@affidavit/contracts';
import { getPrompt } from '@affidavit/prompts';
import { KillSwitchError, type ModelTurnRequest, type ModelTurnResult } from '../orchestrator.js';
import { ROLE_TOOLS, assertAllowedTools } from '../roles.js';
import { ModelCallError, ModelConfigError, ModelUnconfiguredError } from './errors.js';
import { isKnownModelId, type ModelTable } from './models.js';
import type { PreflightModelPort } from './preflight.js';
import { FileRecordingStore, type RecordingStore } from './recordings.js';
import { clipRedacted, describeThrown, redact, redactDeep } from './redact.js';
import {
  DENIED_BUILTIN_TOOLS,
  SUBMIT_SERVER_NAME,
  SubmissionBox,
  buildSubmitTools,
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
function childEnv(key: string, workdir: string, parent: Env): Record<string, string> {
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
    this.recordings =
      config.recordings ?? (config.mode === 'live' ? undefined : new FileRecordingStore());
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

    const options: Options = {
      abortController: ac,
      cwd: workdir.path,
      additionalDirectories: [],
      // No built-in tools at all; the submit tools are the only tools the agent has.
      tools: [],
      allowedTools: tools.allowedTools,
      disallowedTools: [...DENIED_BUILTIN_TOOLS],
      // Anything not pre-approved is denied; nothing can prompt, and nothing runs code.
      permissionMode: 'dontAsk',
      mcpServers: { [SUBMIT_SERVER_NAME]: tools.server },
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      agents: {},
      hooks: tools.hooks,
      systemPrompt: req.system,
      model: req.model,
      maxTurns: req.maxTurns,
      maxBudgetUsd: req.budget.maxUsd,
      persistSession: false,
      enableFileCheckpointing: false,
      includePartialMessages: false,
      env: childEnv(key, workdir.path, this.env()),
      stderr: () => undefined,
    };

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

    let streamError: unknown;
    try {
      for await (const msg of this.transport({ prompt: req.user, options })) {
        if (killed) break;
        if (msg.type === 'assistant') {
          if (msg.error === 'authentication_failed') authFailed = true;
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
      workdir.dispose();
    }

    if (killed) throw new KillSwitchError();
    if (authFailed) throw new ModelUnconfiguredError('the provider rejected the API key');
    if (streamError !== undefined && !timedOut && !overBudget) {
      throw new ModelCallError(`agent turn failed: ${describeThrown(streamError, secrets)}`);
    }

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

    const outcome = ((): ModelTurnResult['outcome'] => {
      if (overBudget || exceeds(used) || result?.subtype === 'error_max_budget_usd') {
        return 'budget-exhausted';
      }
      if (box.captured) return 'submitted';
      if (timedOut || result?.subtype === 'error_max_turns') return 'turn-cap';
      return 'no-submission';
    })();

    if (outcome === 'no-submission') {
      if (result === undefined) {
        throw new ModelCallError('agent stream ended without a result');
      }
      if (result.subtype === 'error_during_execution' || result.is_error) {
        const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
        // Redacted whole, then clipped: never the other way round.
        throw new ModelCallError(`agent turn failed: ${clipRedacted(detail, secrets)}`);
      }
    }

    this.log(
      'info',
      `model turn ${promptId} on ${req.model} ended ${outcome}${timedOut ? ' (wall-clock cap)' : ''}`,
      secrets,
    );
    const out: ModelTurnResult = { outcome, cost };
    // Redacted like everything else that leaves the port: the submission ends up in events.
    if (box.captured) out.submission = redactDeep(box.submission, secrets);
    return out;
  }
}
