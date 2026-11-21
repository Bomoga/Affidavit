/**
 * Secret scrubbing for anything the model port logs or throws, and the credential check that
 * decides whether a submission may be recorded (`detectCredential`). One pattern set serves both.
 *
 * The configured key is removed by value. Anything shaped like a known credential (Anthropic,
 * OpenAI, AWS, GitHub, Slack, Stripe, Google and npm tokens, JWTs, PEM private keys, credentials
 * in a URL, bearer and key headers, and password, secret or token assignments with a literal
 * value) is removed by pattern too.
 *
 * The text scanned can be shaped by untrusted repo content, so every pattern is linear: each
 * starts at a literal prefix, every repetition is bounded, no two unbounded quantifiers sit next
 * to each other, and a body that must be followed by a suffix is matched atomically (lookahead
 * plus backreference) so a failed match never backtracks through it. On top of that, text over
 * `MAX_REDACT_CHARS` is never scanned in one run, and every scan has a work budget that fails
 * closed: logs and errors get `OVERSIZED`, and a recording is refused.
 *
 * Text is always redacted whole before it is shortened. Clipping first could cut a key so that
 * the part left behind no longer matches anything and leaks as a fragment.
 */

export const REDACTED = '[redacted]';
/** What a log line or error message becomes when it is too large or too slow to scan. */
export const OVERSIZED = '[redacted: oversized]';
/** Longest text `redact` scans; anything longer is replaced by `OVERSIZED`. */
export const MAX_REDACT_CHARS = 256 * 1024;
/** Longest string `detectCredential` scans at all; a longer one fails closed. */
export const MAX_SCAN_CHARS = 8 * 1024 * 1024;
/** `detectCredential` scans longer strings in windows of this size (bounded patterns only)... */
export const SCAN_WINDOW_CHARS = 64 * 1024;
/** ...overlapping by this much, more than the longest bounded match below. */
export const SCAN_OVERLAP_CHARS = 8 * 1024;
/** Default work budget for one `redact` or `detectCredential` call. */
export const DEFAULT_SCAN_BUDGET_MS = 2_000;

export interface ScanBudget {
  budgetMs?: number;
  now?: () => number;
}

/**
 * A literal credential body in a header or bearer token: never `$VAR`, a quote, or code. At
 * least 8 characters, then the whole rest of the run, so a long value leaves nothing behind.
 * Nothing follows it in any pattern, so the trailing run never backtracks.
 */
const TOKEN = String.raw`[A-Za-z0-9._~+/=-]{8}[A-Za-z0-9._~+/=-]*`;
/**
 * Not a literal: a member-access chain (`process.env.KEY`, `config.apiKey`, `headers["x"]`) or a
 * bare identifier with no digit (`authHeader`), ending where the token would end. Each accessor
 * starts with `.` or `[`, which the identifier part excludes, so the split is unique and the
 * bounded check stays linear. A real JWT is still caught by its own pattern.
 */
const ROOTS = String.raw`(?:process\.env|import\.meta\.env|globalThis|window|config|request|req|headers|ctx|this|self|env|secrets|settings|options|opts|args|params|props|state)`;
const ACCESSOR = String.raw`(?:\.[A-Za-z_$][\w$]{0,64}|\[[^\]\n]{0,128}\])`;
/** Where an expression ends in code: `;`, `)`, `,`, `}`, `]`, a call, `||`, `??`, `&&`, end of line. */
const CODE_END = String.raw`[ \t]{0,16}(?:[;),}\]\(]|\|\||\?\?|&&|\r?\n|$)`;
/**
 * Not a literal: only a member chain rooted at a known accessor (`process.env.KEY`,
 * `config.apiKey`, `headers['x-api-key']`, `req.headers.authorization`) that ends where code
 * ends. Anything else in a header or bearer position, letters-only and dotted opaque tokens
 * included, is a credential. The root is a fixed word followed directly by an accessor or the
 * end, and each accessor starts with `.` or `[`, so the check is linear.
 */
const NONLITERAL = String.raw`(?!${ROOTS}${ACCESSOR}{0,16}(?![\w$])(?=${CODE_END}))`;
const TOKEN_LIT = `${NONLITERAL}${TOKEN}`;
/** One literal character in a quoted body: anything but a quote, newline, or `${`. */
const LIT = String.raw`(?:[^"'\x60\n$]|\$(?!\{))`;
/**
 * A quoted body is a placeholder, not a literal, when it is one interpolation (`"${PASSWORD}"`),
 * one `$VAR`, a template literal starting with `${`, or has no run of 8 literal characters
 * outside interpolations (`` `Bearer ${token}` ``). `"hunter2hunter2${x}"` is still a literal.
 * The run search is a lazy bounded loop whose two branches start differently, so it is linear.
 */
const QUOTED_LITERAL = String.raw`(?!\$\{[^}\n]{0,128}\}["'\x60])(?!\$[A-Za-z_][\w]{0,64}["'\x60])(?!(?<=\x60)\$\{)(?=(?:\$\{[^}\n]{0,128}\}|${LIT}){0,256}?${LIT}{8})`;
/** A base64url run, matched atomically (lookahead plus backreference) so it never backtracks. */
const B64URL_RUN = (group: number) => `(?=([A-Za-z0-9_-]*))\\${group}`;
/** A JWT header run (group 1), atomic, that never runs into the next `-eyJ` start. */
const HEADER_RUN = String.raw`(?=((?:[A-Za-z0-9_]|-(?!eyJ))*))\1`;
/**
 * Credential-bearing names. The search is unanchored, so any prefix matches (FOO_SECRET_KEY,
 * client_secret); a bounded suffix covers SECRET_KEY_BASE, secretKey and private_key_id.
 */
const KEYS = String.raw`(?:(?:password|passwd|secret|token|api[_-]?key|authorization|(?:private|signing|encryption|secret|master|session|jwt|auth|access|refresh|client|webhook)[_-]?(?:key|secret|token|password))[\w.-]{0,32})`;
/**
 * Count-like names whose all-digit value is a number, not a secret (`max_tokens: 100000`). Only
 * these names exempt an all-digit value; `password=12345678` is still a credential.
 */
const COUNT_LIKE = String.raw`(?:tokens|_count|_limit|_size|_length|_ms|_seconds|(?<![A-Za-z0-9])(?:port|timeout|retries|ttl))`;
/** Short credential names (pin, otp, pwd, key) flagged when assigned 6+ digits. */
const NUMERIC_KEYS = String.raw`(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api[_-]?key|token|key|pin|otp|auth)`;
/** Characters an unquoted literal value runs to. Stops at code punctuation. */
const UNQUOTED = String.raw`[^\s"'\x60,;(){}\[\]<>=:]`;

interface Pattern {
  re: RegExp;
  replacement: string;
  /**
   * The match can be longer than a scan window (an unbounded JWT, userinfo or PEM body), so
   * `detectCredential` runs it over the whole string, never window by window. It is linear, so
   * this costs one pass.
   */
  whole?: boolean;
}

const p = (source: string, flags: string, replacement = REDACTED, whole = false): Pattern => ({
  re: new RegExp(source, `g${flags}`),
  replacement,
  whole,
});

const PATTERNS: readonly Pattern[] = [
  // Anthropic and OpenAI keys.
  p(String.raw`sk-ant-[A-Za-z0-9_-]{4,512}`, ''),
  p(String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{20,512}`, ''),
  // AWS access key ids, and secret access keys next to the word aws.
  p(String.raw`\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b`, ''),
  p(
    String.raw`(\baws[A-Za-z0-9_-]{0,30}["']?[ \t]{0,16}[:=][ \t]{0,16}["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
    'i',
    `$1${REDACTED}`,
  ),
  // GitHub, Slack, Stripe, Google and npm tokens.
  p(String.raw`\b(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})`, ''),
  p(String.raw`\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,255}`, ''),
  p(
    String.raw`(hooks\.slack\.com/(?:services|workflows|triggers)/)[A-Za-z0-9_/-]{8,255}`,
    'i',
    `$1${REDACTED}`,
  ),
  p(String.raw`\b(?:sk_live|sk_test|rk_live|rk_test|pk_live)_[A-Za-z0-9]{10,255}`, ''),
  p(String.raw`\bAIza[0-9A-Za-z_-]{35}`, ''),
  p(String.raw`\bGOCSPX-[A-Za-z0-9_-]{20,255}`, ''),
  p(String.raw`\bnpm_[A-Za-z0-9]{36}`, ''),
  // A JWT anywhere (header.payload.signature), of any length. A match starts only where a
  // base64url run starts (lookbehind), and each segment is one atomic run, so every character
  // is visited a bounded number of times however long the token is: no bound to fail open on.
  // A hyphen may precede the token (`x-eyJ...`). The header run stops before any `-eyJ`, which
  // is a start of its own, so the runs scanned from successive starts never overlap.
  p(
    String.raw`(?<![A-Za-z0-9_])eyJ(?=[A-Za-z0-9_-]{8})${HEADER_RUN}\.eyJ(?=[A-Za-z0-9_-]{8})${B64URL_RUN(2)}(?:\.[A-Za-z0-9_-]*)?`,
    '',
    REDACTED,
    true,
  ),
  // PEM private key blocks, blank lines and CRLF included (an encrypted PEM has `Proc-Type` and
  // `DEK-Info` headers and a blank line before its body): through the END line, or to the end of
  // the text when there is none. The lazy scan for END and the fallback each visit every
  // character once, and a match consumes everything it scanned, so the cost stays linear.
  p(
    String.raw`-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----|[\s\S]*)`,
    '',
  ),
  // Credentials in a URL's userinfo: scheme://user:pass@host, of any length. Anchored on the
  // literal `://`; user and password are atomic runs that cannot cross another `://`.
  // The user may be empty (redis://:pass@host).
  p(String.raw`(://(?=([^\s/:@]*))\2:)(?=([^\s/@]+))\3(?=@)`, '', `$1${REDACTED}`, true),
  // curl basic auth: `curl -u user:pass` or `--user "user:pass"`, not `"$USER:$PASS"`. The span
  // from `curl` to the flag is lazy and bounded, so each start costs a constant.
  p(
    String.raw`(\bcurl\b[^\n]{0,256}?[ \t](?:-u|--user)[ \t]{1,16}["']?)(?![$])[^\s:'"]{1,128}:(?![$])[^\s'"]{1,256}`,
    'i',
    `$1${REDACTED}`,
  ),
  // Azure storage and service bus connection strings.
  p(
    String.raw`(\b(?:Account|SharedAccess)Key=)[A-Za-z0-9+/]{20}[A-Za-z0-9+/=]{0,512}`,
    'i',
    `$1${REDACTED}`,
  ),
  // Authorization headers and assignments, with or without a scheme, with a literal value.
  p(
    String.raw`(\bauthorization["']?[ \t]{0,16}[:=][ \t]{0,16}["']?(?:(?:bearer|basic|token)[ \t]{1,16})?)${TOKEN_LIT}`,
    'i',
    `$1${REDACTED}`,
  ),
  // Key and token headers or assignments: x-api-key, ANTHROPIC_API_KEY, api_key, access_token.
  p(
    String.raw`((?:x-api-key|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token)["']?[ \t]{0,16}[:=][ \t]{0,16}["']?)${TOKEN_LIT}`,
    'i',
    `$1${REDACTED}`,
  ),
  // A bare bearer token with a literal value (not `$TOKEN`, not `' + token`).
  p(String.raw`(\bbearer[ \t]{1,16})${TOKEN_LIT}`, 'i', `$1${REDACTED}`),
  // Credential-looking URL query parameters (not `{{placeholders}}` or `$vars`).
  p(
    String.raw`([?&](?:key|token|auth|sig|signature)=)[^&\s"'#$<>{}][^&\s"'#<>{}]*`,
    'i',
    `$1${REDACTED}`,
  ),
  // Password, secret, token, api key or authorization assigned a quoted literal of 8+
  // characters (see QUOTED_LITERAL for what counts as a placeholder instead).
  p(
    String.raw`(${KEYS}["']?[ \t]{0,16}[:=][ \t]{0,16})(["'\x60])${QUOTED_LITERAL}[^"'\x60\n]{8,256}\2`,
    'i',
    `$1$2${REDACTED}$2`,
  ),
  // A quoted literal too long for the bound above is a credential too: redact the whole run.
  p(
    String.raw`(${KEYS}["']?[ \t]{0,16}[:=][ \t]{0,16})(["'\x60])${QUOTED_LITERAL}[^"'\x60\n]{257}[^"'\x60\n]*`,
    'i',
    `$1$2${REDACTED}`,
  ),
  // A literal behind a placeholder makes the whole expression a credential: a fallback
  // (`process.env.X || '...'`, `?? '...'`), a concatenation, or `.concat('...')`. The code part
  // is a lazy bounded run that cannot cross a quote, so the first literal on the line is used.
  p(
    String.raw`(${KEYS}["']?[ \t]{0,16}[:=][ \t]{0,16}[^\n"'\x60;]{0,256}?(?:\|\||\?\?|\.concat\(|\+)[ \t]{0,16})(["'\x60])${QUOTED_LITERAL}[^"'\x60\n]{8,256}\2`,
    'i',
    `$1$2${REDACTED}$2`,
  ),
  // ...or an unquoted literal of 6+ characters that holds a digit or symbol, is not a `$var`,
  // and is not a member expression or call: `password: hunter22` and `PASSWORD = s3cr3t!` are
  // caught, `password = req.body.password`, `token = getToken()` and `max_tokens: 100000` are not.
  p(
    String.raw`(${KEYS}["']?[ \t]{0,16}[:=][ \t]{0,16})(?![$])(?:(?<!${COUNT_LIKE}["']?[ \t]{0,16}[:=][ \t]{0,16})|(?![0-9]{1,256}(?!${UNQUOTED})))(?![A-Za-z_$][\w$]{0,64}(?:\.[\w$]{1,64}){1,16}(?![\w$]))(?=${UNQUOTED}{0,255}[0-9!@#%^*+/~-])${UNQUOTED}{6,256}`,
    'i',
    `$1${REDACTED}`,
  ),
  // A credential name immediately before the separator (so `tokens` and `token_count` never
  // match) assigned 6+ digits, quoted or not: `password=12345678`, `PIN: "123456"`.
  p(
    String.raw`(${NUMERIC_KEYS}["']?[ \t]{0,16}[:=][ \t]{0,16}["'\x60]?)[0-9]{6,256}(?![0-9])`,
    'i',
    `$1${REDACTED}`,
  ),
];

/** The same patterns without the global flag, for a stateless `test`. */
const detector = ({ re }: Pattern) => new RegExp(re.source, re.flags.replace('g', ''));
const WHOLE_DETECTORS: readonly RegExp[] = PATTERNS.filter((x) => x.whole).map(detector);
const WINDOW_DETECTORS: readonly RegExp[] = PATTERNS.filter((x) => !x.whole).map(detector);

const clock = (b: ScanBudget) => b.now ?? (() => performance.now());

export function redact(
  text: string,
  secrets: readonly (string | undefined)[] = [],
  budget: ScanBudget = {},
): string {
  if (text.length > MAX_REDACT_CHARS) return OVERSIZED;
  const now = clock(budget);
  const limit = budget.budgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  const started = now();
  let out = text;
  // Longest first, so a secret that contains another is removed whole.
  const ordered = secrets
    .filter((s): s is string => s !== undefined && s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const s of ordered) out = out.split(s).join(REDACTED);
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
    if (now() - started > limit) return OVERSIZED;
  }
  return out;
}

/** Redacts the whole text, then shortens it to `max` characters. Never the other way round. */
export function clipRedacted(
  text: string,
  secrets: readonly (string | undefined)[],
  max = 500,
): string {
  const clean = redact(text, secrets);
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** Deep copy of a JSON-like value with every string redacted. Keys are redacted too. */
export function redactDeep(value: unknown, secrets: readonly (string | undefined)[] = []): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[redact(k, secrets)] = redactDeep(v, secrets);
    }
    return out;
  }
  return value;
}

export type CredentialScan = 'clean' | 'credential' | 'over-budget';

/**
 * Whether any string or key in a JSON-like value looks like a credential, by the same patterns
 * `redact` uses. Strings over `MAX_REDACT_CHARS` are scanned in overlapping windows, never in one
 * regex run. Running past the work budget returns `over-budget`, which callers treat as a
 * refusal.
 */
export function detectCredential(value: unknown, budget: ScanBudget = {}): CredentialScan {
  const now = clock(budget);
  const limit = budget.budgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  const started = now();
  const scan = (text: string): CredentialScan => {
    // Hard cap: a string this large is never scanned at all; it fails closed.
    if (text.length > MAX_SCAN_CHARS) return 'over-budget';
    // Unbounded patterns run once over the whole string (each is a single linear pass), so a
    // token longer than a window is never split and missed.
    for (const re of WHOLE_DETECTORS) {
      if (re.test(text)) return 'credential';
      if (now() - started > limit) return 'over-budget';
    }
    const step = SCAN_WINDOW_CHARS - SCAN_OVERLAP_CHARS;
    const whole = text.length <= MAX_REDACT_CHARS;
    for (let at = 0; at < text.length || at === 0; at += step) {
      const window = whole ? text : text.slice(at, at + SCAN_WINDOW_CHARS);
      for (const re of WINDOW_DETECTORS) {
        if (re.test(window)) return 'credential';
        if (now() - started > limit) return 'over-budget';
      }
      if (whole || at + SCAN_WINDOW_CHARS >= text.length) break;
    }
    return 'clean';
  };
  const walk = (v: unknown): CredentialScan => {
    if (typeof v === 'string') return scan(v);
    const items: unknown[] = Array.isArray(v)
      ? v
      : v !== null && typeof v === 'object'
        ? Object.entries(v as Record<string, unknown>).flat()
        : [];
    for (const item of items) {
      const r = walk(item);
      if (r !== 'clean') return r;
    }
    return 'clean';
  };
  return walk(value);
}

/**
 * True when any string or key in a JSON-like value contains one of the exact secret values.
 * This is the only check applied to a live agent submission: submissions are never rewritten,
 * since the Judge must run exactly what the agent sent, so pattern-shaped text (a bearer token or
 * a `?token=` parameter in a witness) passes through untouched.
 */
export function containsSecret(value: unknown, secrets: readonly (string | undefined)[]): boolean {
  const live = secrets.filter((s): s is string => s !== undefined && s.length > 0);
  if (live.length === 0) return false;
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') return live.some((s) => v.includes(s));
    if (Array.isArray(v)) return v.some(walk);
    if (v !== null && typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>).some(([k, x]) => walk(k) || walk(x));
    }
    return false;
  };
  return walk(value);
}

/** A short, redacted description of something thrown, for an error message. */
export function describeThrown(err: unknown, secrets: readonly (string | undefined)[]): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return clipRedacted(raw, secrets);
}
