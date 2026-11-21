import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body, hex) in constant
 * time. Anything malformed is a failure. Runs before the body is parsed.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | string[] | undefined,
): boolean {
  if (typeof header !== 'string') return false;
  const m = SIGNATURE_RE.exec(header);
  if (!m?.[1]) return false;
  const given = Buffer.from(m[1], 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signGithubBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export const GITHUB_EVENT_RE = /^[a-z_]{1,64}$/;
export const GITHUB_DELIVERY_RE = /^[A-Za-z0-9-]{1,64}$/;
