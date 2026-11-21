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
 * It covers every tool input type in the SDK 0.3.318 `sdk-tools.d.ts`, plus the runtime tools
 * that have no input type there (shells, tool search, messaging, task output).
 */
export const DENIED_BUILTIN_TOOLS = [
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'ClaudeDesign',
  'Config',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResources',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'OfferChromeSetup',
  'PowerShell',
  'Projects',
  'ProposeGoal',
  'ProposeSkills',
  'PushNotification',
  'Read',
  'ReadMcpResource',
  'ReadMcpResourceDir',
  'ReadMcpResourceTool',
  'ReadNotifications',
  'RefreshMcpTools',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'ShowOnboardingRolePicker',
  'Skill',
  'SlashCommand',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
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
function contractShape(name: SubmitToolName): AnyZodRawShape {
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

/** Any JSON value, from the contract schemas (zod is not a dependency of this package). */
const ANY_JSON = ParamSpace.element.shape.values.element as unknown as Composable;

/**
 * The input shape a submit tool advertises. Each field is its contract schema OR any JSON value,
 * and optional, so a runtime that validates tool input before the PreToolUse hook can never bounce
 * a malformed first call back to the agent for a quiet retry: every call reaches the hook, which
 * records it raw. The contract schema still leads each field, so the agent sees the real shape;
 * the orchestrator validates the submission against the contract afterwards.
 */
export function submitInputShape(name: SubmitToolName): AnyZodRawShape {
  const out: Record<string, Composable> = {};
  for (const [key, field] of Object.entries(contractShape(name) as Record<string, Composable>)) {
    out[key] = field.or(ANY_JSON).optional();
  }
  return out as unknown as AnyZodRawShape;
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
  readonly hooks: {
    PreToolUse: HookCallbackMatcher[];
    PostToolUse: HookCallbackMatcher[];
    PostToolUseFailure: HookCallbackMatcher[];
  };
  /** The tool definitions, so a stubbed transport can call their handlers. */
  readonly definitions: readonly SdkMcpToolDefinition[];
}

const STOP = { continue: false, stopReason: 'submission recorded' } as const;

/**
 * Builds the submit tools for one turn. The first call to an allowed submit tool is terminal on
 * every path the runtime can take:
 * - PreToolUse (the primary path) keeps it raw, refuses to run it, and stops the turn;
 * - if a runtime bounced it on input validation before PreToolUse, PostToolUseFailure keeps it
 *   raw and stops the turn;
 * - if a runtime ran the handler without the hook, the handler keeps it and PostToolUse stops
 *   the turn.
 * Every other call (a second submission, or any tool not on the list) is refused.
 */
export function buildSubmitTools(
  names: readonly SubmitToolName[],
  box: SubmissionBox,
): SubmitToolSet {
  const allowed = names.map(qualifiedToolName);
  const definitions = names.map((name) =>
    tool(
      name,
      DESCRIPTIONS[name],
      submitInputShape(name),
      (args: unknown) => {
        const kept = box.offer(args);
        return Promise.resolve({
          content: [{ type: 'text', text: kept ? RECORDED : 'Already submitted. Stop now.' }],
          ...(kept ? {} : { isError: true }),
        });
      },
      // Never deferred behind tool search: `tools: []` removes the search tool, so a deferred
      // submit tool could never be found.
      { alwaysLoad: true },
    ),
  ) as SdkMcpToolDefinition[];

  const deny = (reason: string, stop: boolean): HookJSONOutput => ({
    ...(stop ? STOP : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });

  const afterCall: HookCallbackMatcher = {
    onFailure: 'block',
    hooks: [
      (input) => {
        if (input.hook_event_name === 'PostToolUseFailure') {
          if (!allowed.includes(input.tool_name)) return Promise.resolve({});
          // Bounced before PreToolUse (for example on input validation): the raw call is the
          // submission, and there is no second try.
          box.offer(input.tool_input);
          return Promise.resolve(STOP);
        }
        if (input.hook_event_name === 'PostToolUse') {
          if (!allowed.includes(input.tool_name)) return Promise.resolve({});
          box.offer(input.tool_input);
          return Promise.resolve(STOP);
        }
        return Promise.resolve({});
      },
    ],
  };

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
    server: createSdkMcpServer({
      name: SUBMIT_SERVER_NAME,
      version: '1.0.0',
      tools: definitions,
      alwaysLoad: true,
    }),
    hooks: { PreToolUse: [preToolUse], PostToolUse: [afterCall], PostToolUseFailure: [afterCall] },
    definitions,
  };
}
