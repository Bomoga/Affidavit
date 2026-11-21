import {
  createSdkMcpServer,
  tool,
  type AnyZodRawShape,
  type HookCallbackMatcher,
  type HookJSONOutput,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { ParamSpace, type SubmitToolName } from '@affidavit/contracts';
import { BALLOT_OPTIONS, PatchSubmission, WitnessSubmission } from '../envelope.js';

/**
 * The in-process tool server that holds the submit tools. It is not an MCP server anyone can
 * configure or reach: it lives in this process, is the only server passed to the SDK, and the SDK
 * is told to ignore every other MCP configuration (`strictMcpConfig`).
 */
export const SUBMIT_SERVER_NAME = 'affidavit';

/** The name the agent runtime gives a submit tool: `mcp__<server>__<tool>`. */
export function qualifiedToolName(name: SubmitToolName): string {
  return `mcp__${SUBMIT_SERVER_NAME}__${name}`;
}

/**
 * Built-in agent tools, listed so they are also disallowed by name. `tools: []` already removes
 * every built-in; this list is a second lock in case a runtime version adds one back by default.
 */
export const DENIED_BUILTIN_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResources',
  'LSP',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'ReadMcpResource',
  'Skill',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
] as const;

interface Composable {
  or(other: Composable): Composable;
  optional(): Composable;
}

/** One raw shape covering every ballot question: each key accepts any option's schema for it. */
function ballotShape(): AnyZodRawShape {
  const keys = new Set<string>();
  for (const o of BALLOT_OPTIONS) for (const k of Object.keys(o.shape)) keys.add(k);
  const out: Record<string, Composable> = {};
  for (const key of keys) {
    const parts = BALLOT_OPTIONS.map(
      (o) => (o.shape as unknown as Record<string, Composable | undefined>)[key],
    );
    const present = parts.filter((p): p is Composable => p !== undefined);
    let merged = present.reduce((a, b) => a.or(b));
    if (present.length < parts.length) merged = merged.optional();
    out[key] = merged;
  }
  return out as unknown as AnyZodRawShape;
}

/**
 * Input shapes from the contract schemas. Prosecution's submission is not a contract object yet
 * (CR-T8), so its tool advertises the contract `ParamSpace` and its description adds `indices`.
 */
function inputShape(name: SubmitToolName): AnyZodRawShape {
  switch (name) {
    case 'submit_witness':
      return WitnessSubmission.shape;
    case 'submit_patch':
      return PatchSubmission.shape;
    case 'submit_ballot':
      return ballotShape();
    case 'submit_counterexample':
      return { choices: ParamSpace };
  }
}

const DESCRIPTIONS: Readonly<Record<SubmitToolName, string>> = {
  submit_witness:
    'Submit the witness family: a template and its finite parameter space. Call it once. The Judge runs it; you do not.',
  submit_counterexample:
    'Submit counterexample parameter choices drawn from the Defense witness family: { choices: [{ name, indices?, values? }] }. Call it once. The Judge runs it; you do not.',
  submit_patch:
    'Submit the patch as a unified diff. Call it once. The Judge verifies it; you do not.',
  submit_ballot: 'Submit your ballot for the question you were asked. Call it once.',
};

/**
 * Holds the one submission a turn may produce. The first call to the turn's submit tool is kept
 * exactly as the agent sent it, before any validation, so a malformed submission reaches the
 * orchestrator and is recorded as inadmissible instead of being bounced back to the agent for a
 * silent second try. Later calls are refused and never replace it.
 */
export class SubmissionBox {
  private value: unknown;
  private filled = false;

  get captured(): boolean {
    return this.filled;
  }
  get submission(): unknown {
    return this.value;
  }

  /** Returns true when this call is the one kept. */
  offer(input: unknown): boolean {
    if (this.filled) return false;
    this.filled = true;
    this.value = input;
    return true;
  }
}

const RECORDED =
  'Submission recorded exactly as sent. Your turn is over: do not call any tool again.';

export interface SubmitToolSet {
  /** Exactly the qualified submit tool names, for `allowedTools`. */
  readonly allowedTools: string[];
  readonly server: McpSdkServerConfigWithInstance;
  readonly hooks: { PreToolUse: HookCallbackMatcher[] };
  /** The tool definitions, so a stubbed transport can call their handlers. */
  readonly definitions: readonly SdkMcpToolDefinition[];
}

/**
 * Builds the submit tools for one turn. The PreToolUse hook sees every tool call before it runs:
 * it keeps the first call to an allowed submit tool and stops the turn, and refuses every other
 * call (a second submission, or any tool that is not on the list).
 */
export function buildSubmitTools(
  names: readonly SubmitToolName[],
  box: SubmissionBox,
): SubmitToolSet {
  const allowed = names.map(qualifiedToolName);
  const definitions = names.map((name) =>
    tool(name, DESCRIPTIONS[name], inputShape(name), (args: unknown) => {
      // Reached only if a runtime ran the tool without the hook; the hook is the primary path.
      const kept = box.offer(args);
      return Promise.resolve({
        content: [{ type: 'text', text: kept ? RECORDED : 'Already submitted. Stop now.' }],
        ...(kept ? {} : { isError: true }),
      });
    }),
  ) as SdkMcpToolDefinition[];

  const deny = (reason: string, stop: boolean): HookJSONOutput => ({
    ...(stop ? { continue: false, stopReason: 'submission recorded' } : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });

  const preToolUse: HookCallbackMatcher = {
    onFailure: 'block',
    hooks: [
      (input) => {
        if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
        if (!allowed.includes(input.tool_name)) {
          return Promise.resolve(deny('This tool is not available. Use your submit tool.', false));
        }
        if (!box.offer(input.tool_input)) {
          return Promise.resolve(deny('Already submitted. Stop now.', true));
        }
        return Promise.resolve(deny(RECORDED, true));
      },
    ],
  };

  return {
    allowedTools: allowed,
    server: createSdkMcpServer({ name: SUBMIT_SERVER_NAME, version: '1.0.0', tools: definitions }),
    hooks: { PreToolUse: [preToolUse] },
    definitions,
  };
}
