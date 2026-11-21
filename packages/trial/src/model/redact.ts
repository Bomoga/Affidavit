/**
 * Secret scrubbing for anything the model port logs, throws, records, or returns.
 *
 * The configured key is removed by value. Anything shaped like an Anthropic key is removed by
 * pattern too, so a key that reached the text some other way (an echoed header, an error body)
 * does not survive either.
 */

export const REDACTED = '[redacted]';

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/g;

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  // Longest first, so a secret that contains another is removed whole.
  const ordered = secrets
    .filter((s): s is string => s !== undefined && s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const s of ordered) out = out.split(s).join(REDACTED);
  return out.replace(KEY_SHAPE, REDACTED);
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

/** A short, redacted description of something thrown, for an error message. */
export function describeThrown(err: unknown, secrets: readonly (string | undefined)[]): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const clipped = raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
  return redact(clipped, secrets);
}
