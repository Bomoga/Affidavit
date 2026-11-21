// Test helpers for the model port. Not exported from the package entry point. Nothing here
// reaches the network: the stub transport only reads the options it is given and yields
// scripted messages.
import { existsSync, readdirSync } from 'node:fs';
import type {
  HookInput,
  HookJSONOutput,
  Options,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PromptId } from '@affidavit/contracts';
import { renderPrompt } from '@affidavit/prompts';
import type { ModelTurnRequest } from '../orchestrator.js';
import { ROLE_TOOLS } from '../roles.js';
import { DEFAULT_MODEL_TABLE } from './models.js';

/** A key-shaped canary. Tests grep every output for it. */
export const CANARY_KEY = 'sk-ant-api03-CANARY-0123456789abcdefghij-DO-NOT-LEAK';

export interface StubCall {
  prompt: string;
  options: Options;
  /** True when the cwd existed and was empty when the turn started. */
  cwdEmpty: boolean;
}

export interface Harness {
  options: Options;
  /** Runs the PreToolUse hooks the port registered, as the runtime would before a tool call. */
  callTool(name: string, input: unknown): Promise<HookJSONOutput[]>;
}

export type Script = (h: Harness) => AsyncGenerator<SDKMessage, void, unknown>;

/**
 * Mimics a runtime that validates tool input before any PreToolUse hook. Returns an error
 * message to bounce the call (the runtime then fires PostToolUseFailure, not PreToolUse), or
 * undefined to let it through.
 */
export type PreValidate = (toolName: string, input: unknown) => string | undefined;

export interface StubOptions {
  preValidate?: PreValidate;
}

/** A validator that checks each field against the advertised input shape, as the runtime does. */
export function shapeValidator(shapeOf: (toolName: string) => object | undefined): PreValidate {
  return (toolName, input) => {
    const shape = shapeOf(toolName) as
      Record<string, { safeParse(v: unknown): { success: boolean } }> | undefined;
    if (shape === undefined) return undefined;
    if (typeof input !== 'object' || input === null) return 'input must be an object';
    const rec = input as Record<string, unknown>;
    for (const [key, schema] of Object.entries(shape)) {
      if (!schema.safeParse(rec[key]).success) return `InputValidationError: ${key} is invalid`;
    }
    return undefined;
  };
}

export function stubTransport(script: Script, stubOptions: StubOptions = {}) {
  const calls: StubCall[] = [];
  const transport = (params: { prompt: string; options: Options }): AsyncIterable<SDKMessage> => {
    const { options } = params;
    const cwd = options.cwd;
    const cwdEmpty = cwd !== undefined && existsSync(cwd) && readdirSync(cwd).length === 0;
    calls.push({ prompt: params.prompt, options, cwdEmpty });
    let n = 0;
    const fire = async (
      event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
      extra: Record<string, unknown>,
      outs: HookJSONOutput[],
    ): Promise<void> => {
      for (const m of options.hooks?.[event] ?? []) {
        for (const hook of m.hooks) {
          const id = `t${n++}`;
          const hookInput = {
            hook_event_name: event,
            tool_use_id: id,
            session_id: 's',
            transcript_path: '',
            cwd: options.cwd ?? '',
            ...extra,
          } as HookInput;
          outs.push(await hook(hookInput, id, { signal: new AbortController().signal }));
        }
      }
    };
    const harness: Harness = {
      options,
      async callTool(name, input) {
        const outs: HookJSONOutput[] = [];
        const invalid = stubOptions.preValidate?.(name, input);
        if (invalid !== undefined) {
          // Bounced before any PreToolUse hook, as a validating runtime would.
          await fire(
            'PostToolUseFailure',
            { tool_name: name, tool_input: input, error: invalid },
            outs,
          );
          return outs;
        }
        await fire('PreToolUse', { tool_name: name, tool_input: input }, outs);
        const denied = outs.some(
          (o) =>
            (o as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
              ?.permissionDecision === 'deny',
        );
        if (!denied) {
          await fire(
            'PostToolUse',
            { tool_name: name, tool_input: input, tool_response: { content: [] } },
            outs,
          );
        }
        return outs;
      },
    };
    return script(harness);
  };
  return { transport, calls };
}

export function assistant(
  id: string,
  inputTokens: number,
  outputTokens: number,
  error?: string,
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [],
    },
    parent_tool_use_id: null,
    ...(error === undefined ? {} : { error }),
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: 's',
  } as unknown as SDKMessage;
}

export function result(
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution',
  opts: {
    usd?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    errors?: string[];
    isError?: boolean;
    text?: string;
  } = {},
): SDKMessage {
  const input = opts.input ?? 100;
  const output = opts.output ?? 50;
  return {
    type: 'result',
    subtype,
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: opts.isError ?? subtype !== 'success',
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: opts.usd ?? 0.0123,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: opts.cacheRead ?? 0,
        cacheCreationInputTokens: 0,
      },
    },
    permission_denials: [],
    errors: opts.errors ?? [],
    result: opts.text ?? '',
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 's',
  } as unknown as SDKMessage;
}

export const ROLE_OF_PROMPT: Readonly<Record<PromptId, keyof typeof ROLE_TOOLS>> = {
  defense: 'defense',
  'defense-second-attempt': 'defense',
  prosecution: 'prosecution',
  remedy: 'remedy',
  'juror-security': 'juror',
  'juror-maintainability': 'juror',
  'juror-blast-radius': 'juror',
};

/** A request exactly as a handler would build it from the packaged prompt. */
export function requestFor(
  promptId: PromptId,
  user = 'case data',
  overrides: Partial<ModelTurnRequest> = {},
): ModelTurnRequest {
  const rendered = renderPrompt(promptId, [{ label: 'candidate', content: user }]);
  return {
    promptId,
    promptVersion: rendered.version,
    model: DEFAULT_MODEL_TABLE[promptId],
    system: rendered.system,
    user: rendered.user,
    tools: [...ROLE_TOOLS[ROLE_OF_PROMPT[promptId]]],
    outputSchemaRef: rendered.outputSchemaRef,
    maxTurns: 3,
    budget: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxUsd: 0.5 },
    ...overrides,
  };
}

export const GOOD_WITNESS = {
  template: 'GET /api/items?id={{id}}',
  params: [{ name: 'id', values: ["1' OR '1'='1"] }],
};
