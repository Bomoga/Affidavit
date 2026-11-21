/**
 * Secret scrubbing for anything the model port logs or throws, and for every recorded field
 * except the agent submission (see `containsSecret`).
 *
 * The configured key is removed by value. Anything shaped like an Anthropic key, and the value of
 * any header, assignment, bearer token, or URL parameter that carries a credential, is removed by
 * pattern too, so a key that reached the text some other way (an echoed header, an error body, a
 * request URL) does not survive either.
 *
 * Text is always redacted whole before it is shortened. Clipping first could cut a key so that
 * the part left behind no longer matches anything and leaks as a fragment.
 */

export const REDACTED = '[redacted]';

/** Characters a credential value runs to, in headers, JSON, and assignments. */
const VALUE = String.raw`[^\s"',;&}\]]+`;

const PATTERNS: readonly [RegExp, string][] = [
  // Anthropic-shaped keys anywhere.
  [/sk-ant-[A-Za-z0-9_-]{4,}/g, REDACTED],
  // Authorization headers and assignments, with or without a scheme.
  [
    new RegExp(String.raw`(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)?\s*)${VALUE}`, 'gi'),
    `$1${REDACTED}`,
  ],
  // Key and token headers or assignments: x-api-key, ANTHROPIC_API_KEY, api_key, access_token.
  [
    new RegExp(
      String.raw`((?:x-api-key|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)${VALUE}`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
  // A bare bearer token.
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // Credential-looking URL query parameters.
  [/([?&](?:key|token|auth|sig|signature)=)[^&\s"'#]+/gi, `$1${REDACTED}`],
  // PEM private key blocks, whole (or from the header on, if the block is cut).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // AWS access key ids, and secret access keys next to the word aws.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, REDACTED],
  [/(aws[\w-]{0,30}["']?\s*[:=]\s*["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi, `$1${REDACTED}`],
  // GitHub, Slack, Stripe, Google and npm tokens.
  [/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}/g, REDACTED],
  // A JWT anywhere (header.payload.signature).
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED],
  // Credentials in a URL's userinfo: scheme://user:pass@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi, `$1${REDACTED}`],
  // Password, secret, token, api key or authorization assigned a literal of 8+ characters:
  // quoted (`password = "..."`, `"client_secret": "..."`), or unquoted with no spaces around
  // `=` (`password=...` in config and query strings). Code such as
  // `password = req.body.password` or `token = getToken()` has no literal and is left alone.
  [
    /((?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*)(["'`])[^"'`\n]{8,}?\2/gi,
    `$1$2${REDACTED}$2`,
  ],
  [
    /((?:password|passwd|secret|token|api[_-]?key|authorization)=)(?![\w$]+(?:\.[\w$]+)+(?![\w$]))(?![\w$.]+\()[^\s"'`&;,)}\]]{8,}/gi,
    `$1${REDACTED}`,
  ],
];

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  // Longest first, so a secret that contains another is removed whole.
  const ordered = secrets
    .filter((s): s is string => s !== undefined && s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const s of ordered) out = out.split(s).join(REDACTED);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
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

/**
 * True when any string or key in a JSON-like value contains one of the exact secret values.
 * This is the only check applied to an agent submission: submissions are never rewritten, since
 * the Judge must run exactly what the agent sent, so pattern-shaped text (a bearer token or a
 * `?token=` parameter in a witness) passes through untouched.
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
