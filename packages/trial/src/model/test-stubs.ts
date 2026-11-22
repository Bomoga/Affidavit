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

/**
 * Credential-shaped samples a witness might quote from a target repo. Each is built by
 * concatenation so no token-shaped literal sits in the source for a secret scanner to flag.
 * `value` is the part that must never be printed or recorded without opt-in.
 */
export const CREDENTIAL_SAMPLES: readonly { kind: string; text: string; value: string }[] = (() => {
  const s = (kind: string, prefix: string, value: string, suffix = '') => ({
    kind,
    text: `${prefix}${value}${suffix}`,
    value,
  });
  const jwt = `${'ey' + 'J'}hbGciOiJIUzI1NiJ9.${'ey' + 'J'}zdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw`;
  return [
    s('aws access key id', 'const id = "', 'AK' + 'IA' + 'Q3EGRX7MBDEXAMPL', '";'),
    s('aws sts key id', 'id=', 'AS' + 'IA' + 'Y34FZKBOKMUTVV7A'),
    s(
      'aws secret access key',
      'aws_secret_access_key = "',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY',
      '"',
    ),
    s('github pat', 'token: ', 'gh' + 'p_' + 'R4nd0mT0k3nV4lu3F0rT3st1ngPurp0s3s12'),
    s('github oauth', 'x ', 'gh' + 'o_' + 'R4nd0mT0k3nV4lu3F0rT3st1ngPurp0s3s12'),
    s('github fine-grained', 'x ', 'github' + '_pat_' + '11ABCDEFG0123456789_abcdefghijklmnop'),
    s('slack', 'x ', 'xo' + 'xb-' + '1234567890-0987654321-AbCdEfGhIjKlMnOp'),
    s('stripe live', 'x ', 'sk' + '_live_' + '51H8abcdefghijklmnopqrstu'),
    s('stripe restricted', 'x ', 'rk' + '_live_' + '51H8abcdefghijklmnopqrstu'),
    s('google api key', 'key ', 'AI' + 'za' + 'SyA1234567890abcdefghijklmnopqrstu-_'),
    s('npm token', 'x ', 'np' + 'm_' + 'abcdefghijklmnopqrstuvwxyz0123456789'),
    s('jwt', 'GET / HTTP/1.1\nCookie: session=', jwt),
    s(
      'pem private key',
      'const k = `',
      '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7bq9\n-----END RSA PRIVATE KEY-----',
      '`;',
    ),
    s('url userinfo', 'mongodb://admin:', 'S3cr3tPassw0rd', '@db.internal:27017/app'),
    s('password assignment', 'password=', 'hunter2hunter2'),
    s('quoted password', 'const password = "', 'correct horse battery', '";'),
    s('secret json', '{"client_secret": "', 'q9w8e7r6t5y4u3i2', '"}'),
    s('passwd yaml', "passwd: '", 'pa55w0rd-long', "'"),
    s('authorization assignment', 'authorization=', 'Zm9vOmJhcmJhenF1eA'),
    s('slack app token', 'x ', 'xa' + 'pp-' + '1-A0123456789-0123456789012-abcdef'),
    s(
      'slack webhook',
      'POST https://hooks.slack' + '.com/services/',
      'T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    ),
    s('stripe test secret', 'x ', 'sk' + '_test_' + '51H8abcdefghijklmnopqrstu'),
    s('stripe test restricted', 'x ', 'rk' + '_test_' + '51H8abcdefghijklmnopqrstu'),
    s('stripe live publishable', 'x ', 'pk' + '_live_' + '51H8abcdefghijklmnopqrstu'),
    s('google oauth client secret', 'x ', 'GOC' + 'SPX-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz12'),
    s('openai project key', 'x ', 'sk' + '-proj-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
    s('openai key', 'x ', 'sk' + '-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij'),
    s('unquoted yaml password', 'password: ', 'hunter22'),
    s('spaced uppercase password', 'PASSWORD = ', 's3cr3t!'),
    s('quoted password with $ inside', 'const password = "', 'pa$$w0rd!xyz', '";'),
    s('quoted secret longer than 256', 'secret = "', 'q1w2e3r4'.repeat(50), '"'),
    s(
      'PEM body of 20 KB without END',
      '',
      `-----BEGIN ${'PRIVATE KEY'}-----\n${`${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'.padEnd(64, 'A')}\n`.repeat(320)}`,
      '\nafter the blank line',
    ),
    s('5000-char bearer header', 'Authorization: Bearer ', 'Ab9-'.repeat(1250)),
    s('5000-char bare bearer', 'curl -H x Bearer ', 'Zz8_'.repeat(1250)),
    s('5000-char token query', 'GET /x?token=', 'Qq7.'.repeat(1250), ' HTTP/1.1'),
    s(
      'oversized JWT',
      'Cookie: s=',
      `${'ey' + 'J'}${'h'.repeat(300)}.${'ey' + 'J'}${'p'.repeat(10_000)}.${'s'.repeat(500)}`,
    ),
    s('hyphen-prefixed jwt', 'x-', jwt),
    s('bearer JWT with dots', 'Authorization: Bearer ', jwt),
    s('quoted spaced password', 'password = "', 'hunter2hunter2', '"'),
    s('django SECRET_KEY', "SECRET_KEY = '", 'django-insecure-abc123xyz789', "'"),
    s(
      'SECRET_KEY_BASE hex',
      'SECRET_KEY_BASE=',
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    ),
    s('PRIVATE_KEY quoted', 'PRIVATE_KEY="', 'MIIBVgIBADANBgkqhkiG9w0', '"'),
    s('ENCRYPTION_KEY hex32', 'ENCRYPTION_KEY=', '0123456789abcdef0123456789abcdef'),
    s('SIGNING_KEY yaml', 'SIGNING_KEY: "', 'sig-0123456789-abcdef', '"'),
    s('camelCase secretKey', 'secretKey: "', 'Xy7Qp2Lm9Rt4Vb8N', '"'),
    s('prefixed FOO_SECRET_KEY', 'FOO_SECRET_KEY=', 'f00b4r-s3cr3t-v4lu3'),
    s(
      'private_key_id json',
      '"private_key_id": "',
      '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      '"',
    ),
    s('accessToken camelCase', 'accessToken: "', 'at-9876543210-zyxwvu', '"'),
    s('redis URL with empty user', 'redis://:', 'R3d1sP4ssw0rd', '@cache:6379/0'),
    s('curl basic auth', 'curl -u admin:', 'Curl-P4ss-2024', ' https://api.example.com'),
    s('curl quoted basic auth', 'curl -s --user "svc:', 'Qu0ted-P4ss!', '" https://x'),
    s(
      'azure storage account key',
      'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=',
      'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4==',
      ';EndpointSuffix=core.windows.net',
    ),
    s('numeric password', 'password=', '12345678'),
    s('quoted numeric PIN', 'PIN: "', '123456', '"'),
    s('numeric api_key', 'api_key = ', '12345678901234'),
    s('numeric otp', 'otp: ', '987654'),
    s('numeric prefixed password', 'DB_PASSWORD=', '20242024'),
    s('letters-only bearer', 'Authorization: Bearer ', 'abcdefghijklmnop'),
    s('dotted opaque bearer', 'curl -H x Bearer ', 'abcdefghij.klmnopqrst.uvwxyzab'),
    s('letters-only api key', 'x-api-key: ', 'SomeLongLettersOnlyToken'),
    s('dotted opaque authorization', 'authorization: ', 'opaque.dotted.token.value.here'),
    s(
      'literal behind a member chain call',
      'apiKey: config.apiKey.concat(',
      "'abcdefgh12345678'",
      ')',
    ),
    s('literal fallback after ||', 'token = process.env.X || ', "'abcdefgh12345678'", ';'),
    s('literal fallback after ??', 'const secret = opts.secret ?? ', '"zyxwvuts98765432"', ';'),
    s('quoted literal with interpolation', 'password = "', 'hunter2hunter2${x}', '"'),
    s('quoted literal with dangling interpolation', "secret = '", 'sk_live_abcdef${', "'"),
    s('Bearer- prefixed jwt', 'Authorization: Bearer-', jwt),
    s(
      'encrypted PEM with headers and a blank line',
      'const key = `',
      [
        `-----BEGIN ${'RSA PRIVATE KEY'}-----`,
        'Proc-Type: 4,ENCRYPTED',
        'DEK-Info: AES-128-CBC,2D5F3A1B9C8E7D6F0A1B2C3D4E5F6A7B',
        '',
        'k3X9vQ2mL8pR4tY6uW0zA1bC5dE7fG9hJ2kL4mN6pQ8rS0tU2vW4xY6zA8bC0dE2',
        'fG4hJ6kL8mN0pQ2rS4tU6vW8xY0zA2bC4dE6fG8hJ0kL2mN4pQ6rS8tU0vW2xY4z',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n'),
      '`;\nconst next = 1;',
    ),
    s(
      'PEM with CRLF line endings',
      '',
      [
        `-----BEGIN ${'PRIVATE KEY'}-----`,
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7crlfcrlfcrlf',
        '',
        'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4',
        '-----END PRIVATE KEY-----',
      ].join('\r\n'),
      '\r\nrest',
    ),
    s('long URL userinfo password', 'postgres://svc:', 'Pw9'.repeat(150), '@db:5432/app'),
    s('long URL userinfo user', `postgres://${'u'.repeat(300)}:`, 'Pw9Pw9Pw9', '@db/app'),
  ];
})();

/** One MB inputs built to make a backtracking pattern blow up. Every scan must stay linear. */
export const HOSTILE_INPUTS: readonly { kind: string; text: string }[] = (() => {
  const MB = 1024 * 1024;
  const fill = (unit: string, prefix = '') =>
    (prefix + unit.repeat(Math.ceil(MB / unit.length))).slice(0, MB);
  return [
    { kind: 'repeated eyJ.', text: fill('eyJ.') },
    { kind: 'repeated eyJ-', text: fill('eyJ-') },
    { kind: 'repeated half JWT', text: fill('eyJabcdefgh.eyJ') },
    { kind: 'repeated xoxb-', text: fill('xo' + 'xb-') },
    { kind: 'password=a.a.a.', text: fill('a.', 'password=') },
    { kind: 'repeated password=', text: fill('password=') },
    { kind: 'repeated password: ', text: fill('password: ') },
    { kind: 'repeated secret_key_', text: fill('secret_key_') },
    { kind: 'max_tokens and digits', text: fill('1', 'max_tokens: ') },
    { kind: 'pin= and digits', text: fill('1', 'pin=') },
    { kind: 'repeated pin: ', text: fill('pin: ') },
    { kind: 'repeated _count= ', text: fill('x_count= 1') },
    { kind: 'repeated curl -u ', text: fill('curl -u ') },
    { kind: 'curl -u and colons', text: fill('a:', 'curl -u ') },
    { kind: 'AccountKey= and base64', text: fill('A', 'AccountKey=') },
    { kind: 'repeated ://:', text: fill('://:') },
    { kind: 'authorization: and spaces', text: fill(' ', 'authorization:') },
    { kind: 'authorization: and tabs', text: fill('\t', 'Authorization: Bearer') },
    { kind: 'repeated AKIA', text: fill('AK' + 'IA') },
    { kind: 'repeated -----BEGIN ', text: fill('-----BEGIN ') },
    { kind: 'repeated PEM header', text: fill('-----BEGIN ' + 'RSA PRIVATE KEY-----') },
    { kind: 'base64 run', text: fill('QUJDREVGR0hJSktM+/') },
    { kind: 'letters run', text: fill('a') },
    { kind: 'repeated ://', text: fill('://') },
    { kind: 'repeated a://u:', text: fill('a://u:') },
    { kind: 'repeated Bearer ', text: fill('Bearer ') },
    { kind: 'repeated aws=', text: fill('aws=') },
    { kind: 'repeated sk-', text: fill('sk-') },
    { kind: 'repeated ghp_', text: fill('gh' + 'p_') },
    { kind: 'repeated ?token=', text: fill('?token=') },
    { kind: 'repeated slack hook path', text: fill('hooks.slack' + '.com/services/') },
    { kind: 'repeated secret="', text: fill('secret="') },
    { kind: 'one long quoted value', text: fill('a', 'password="') },
    { kind: 'one long JWT header run', text: fill('a', 'ey' + 'J') },
    { kind: 'one long bearer run', text: fill('Ab9-', 'Bearer ') },
    { kind: 'repeated ://a:', text: fill('://a:') },
    { kind: 'one long userinfo run', text: fill('a', 'x://') },
    {
      kind: 'PEM headers between blank lines',
      text: fill(`-----BEGIN ${'RSA PRIVATE KEY'}-----\n\n`),
    },
    {
      kind: 'PEM header and many lines',
      text: fill('QUJD\n', `-----BEGIN ${'PRIVATE KEY'}-----\n`),
    },
    { kind: 'repeated eyJ segments', text: fill('eyJaaaaaaaaa.') },
    { kind: 'hyphen run of -eyJ', text: fill('-eyJ') },
    { kind: 'repeated fallback chains', text: fill('token = x || ') },
    { kind: 'repeated interpolations in quotes', text: fill('${a}', 'secret = "') },
    { kind: 'repeated member chains', text: fill('.a', 'api_key = process.env') },
    { kind: 'hyphen run of a-eyJ', text: fill('a-eyJ') },
    { kind: 'eyJ then a hyphen run', text: fill('-', 'eyJ') },
    { kind: 'repeated -eyJ half JWT', text: fill('-eyJabcdefgh.eyJ') },
    { kind: 'PEM header then blank lines', text: fill('\n', `-----BEGIN ${'PRIVATE KEY'}-----`) },
    { kind: 'repeated CRLF PEM headers', text: fill(`-----BEGIN ${'PRIVATE KEY'}-----\r\n\r\n`) },
  ];
})();

/** Ordinary code and short values that must not be treated as credentials. */
export const NOT_CREDENTIALS: readonly string[] = [
  'const password = req.body.password;',
  'if (user.password === password) return token;',
  'const token = getToken(req);',
  'secret = process.env.SECRET',
  'password=abc12',
  "const password = 'short';",
  'const password = userPassword;',
  'password: string;',
  'curl -H "Authorization: Bearer $TOKEN" https://api.example.com',
  "headers.Authorization = 'Bearer ' + token;",
  'const password = "${PASSWORD}";',
  'GET /items?token={{token}} HTTP/1.1',
  'password = req.body.password',
  'api_key = process.env.KEY',
  'access_token = process.env.X',
  'authorization: process.env.AUTH',
  'apiKey: config.apiKey',
  'const headers = { Authorization: `Bearer ${token}` };',
  'x-api-key: headers["x-api-key"]',
  "x-api-key: headers['x-api-key']",
  'const key = process.env.SECRET_KEY;',
  'key = settings.SECRET_KEY',
  "key = os.environ['SECRET_KEY']",
  "key = getenv('SECRET_KEY')",
  "SECRET_KEY = os.environ['SECRET_KEY']",
  'SECRET_KEY = process.env.SECRET_KEY',
  'max_tokens: 100000',
  'timeout=30000',
  'auth_tokens = 12345678',
  'token_count: 1234567',
  'session_timeout = 3600000',
  'spin: 123456',
  'curl -u "$USER:$PASS" https://x',
  'redis://cache:6379/0',
  'const auth = { authorization: req.headers.authorization };',
  'authorization: req.headers.authorization',
  'const token = `${prefix}${suffix}`;',
  'secret = `${a}-${b}`',
  'password: "$DB_PASSWORD"',
  'PASSWORD = process.env.DB_PASSWORD',
  'GET /login?user={{u}}&next=/home HTTP/1.1',
  'https://example.com/path@section',
];

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
  /** Text content, as the runtime puts the provider's error text on a synthetic message. */
  text?: string,
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
      content: text === undefined ? [] : [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    ...(error === undefined ? {} : { error }),
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: 's',
  } as unknown as SDKMessage;
}

/**
 * What the runtime (claude-agent-sdk 0.3.318) yields for a response that ended with
 * `stop_reason: "refusal"`: a synthetic assistant message with error `invalid_request`, the
 * refusal text as content, and the response's stop_reason and stop_details kept on the message.
 */
export function refusalAssistant(
  opts: { category?: unknown; explanation?: string; text?: string; withDetails?: boolean } = {},
): SDKMessage {
  const base = assistant(
    'm-refused',
    0,
    0,
    'invalid_request',
    opts.text ??
      "API Error: Claude Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Claude Opus 5.5.",
  ) as unknown as { message: Record<string, unknown> };
  base.message.stop_reason = 'refusal';
  base.message.stop_details =
    opts.withDetails === false
      ? null
      : {
          ...(opts.category === undefined ? { category: 'cyber' } : { category: opts.category }),
          explanation: opts.explanation ?? null,
        };
  return base as unknown as SDKMessage;
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
    apiErrorStatus?: number;
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
    ...(opts.apiErrorStatus === undefined ? {} : { api_error_status: opts.apiErrorStatus }),
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
