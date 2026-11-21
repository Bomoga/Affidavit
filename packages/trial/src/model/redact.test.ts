import { describe, expect, it } from 'vitest';
import { REDACTED, clipRedacted, describeThrown, redact, redactDeep } from './redact.js';
import { CANARY_KEY, CREDENTIAL_SAMPLES, NOT_CREDENTIALS } from './test-stubs.js';

describe('third-party credential forms', () => {
  for (const sample of CREDENTIAL_SAMPLES) {
    it(`redacts a ${sample.kind}`, () => {
      const out = redact(sample.text);
      expect(out).not.toContain(sample.value);
      expect(out).toContain(REDACTED);
    });
  }

  for (const text of NOT_CREDENTIALS) {
    it(`leaves ordinary text alone: ${text}`, () => {
      expect(redact(text)).toBe(text);
    });
  }
});

/** Every substring of the key of this length or more counts as a leak. */
const FRAGMENT = 6;
function leaksKey(text: string, key = CANARY_KEY): boolean {
  for (let i = 0; i + FRAGMENT <= key.length; i++) {
    if (text.includes(key.slice(i, i + FRAGMENT))) return true;
  }
  return false;
}

describe('redact before clip', () => {
  it('a key straddling the clip position never leaves a fragment, at any offset', () => {
    for (let offset = 500 - CANARY_KEY.length - 2; offset <= 502; offset++) {
      const raw = `${'x'.repeat(offset)}${CANARY_KEY}${'y'.repeat(200)}`;
      const err = new Error(raw);
      const out = describeThrown(err, [CANARY_KEY]);
      expect(leaksKey(out), `offset ${offset}`).toBe(false);
      const clipped = clipRedacted(raw, [CANARY_KEY], 500);
      expect(leaksKey(clipped), `clip offset ${offset}`).toBe(false);
    }
  });

  it('a key that is not in the secret list is still caught when it straddles the cut', () => {
    for (let offset = 470; offset <= 502; offset++) {
      const raw = `${'x'.repeat(offset)}${CANARY_KEY}`;
      expect(leaksKey(clipRedacted(raw, [], 500)), `offset ${offset}`).toBe(false);
    }
  });

  it('clips to the limit after redaction and marks the cut', () => {
    const out = clipRedacted(`${CANARY_KEY} ${'z'.repeat(1000)}`, [CANARY_KEY], 100);
    expect(out.startsWith(REDACTED)).toBe(true);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBe(103);
  });
});

describe('header, URL and bearer forms', () => {
  const opaque = 'opaque-token-value-1234567890';
  const cases = [
    `x-api-key: ${opaque}`,
    `X-Api-Key=${opaque}`,
    `"x-api-key":"${opaque}"`,
    `Authorization: Bearer ${opaque}`,
    `authorization=bearer ${opaque}`,
    `Bearer ${opaque}`,
    `https://api.example.com/v1?api_key=${opaque}&x=1`,
    `https://api.example.com/v1?key=${opaque}`,
    `ANTHROPIC_API_KEY=${opaque}`,
    `anthropic-api-key: "${opaque}"`,
  ];
  for (const text of cases) {
    it(`redacts the value in ${text.replace(opaque, '<value>')}`, () => {
      const out = redact(text);
      expect(out).not.toContain(opaque);
      expect(out).toContain(REDACTED);
    });
  }

  it('redacts sk-ant shaped keys and the configured key by value', () => {
    expect(redact(`k=${CANARY_KEY}`)).not.toContain('CANARY');
    expect(redact('plain abcdefgh secret', ['abcdefgh'])).toBe(`plain ${REDACTED} secret`);
  });

  it('redactDeep reaches nested strings and keys', () => {
    const out = JSON.stringify(
      redactDeep({ [CANARY_KEY]: [{ h: `Bearer ${opaque}` }] }, [CANARY_KEY]),
    );
    expect(out).not.toContain(opaque);
    expect(leaksKey(out)).toBe(false);
  });
});
