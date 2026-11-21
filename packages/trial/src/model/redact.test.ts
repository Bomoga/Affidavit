import { describe, expect, it } from 'vitest';
import {
  MAX_REDACT_CHARS,
  MAX_SCAN_CHARS,
  OVERSIZED,
  REDACTED,
  clipRedacted,
  describeThrown,
  detectCredential,
  redact,
  redactDeep,
} from './redact.js';
import { CANARY_KEY, CREDENTIAL_SAMPLES, HOSTILE_INPUTS, NOT_CREDENTIALS } from './test-stubs.js';

describe('third-party credential forms', () => {
  for (const sample of CREDENTIAL_SAMPLES) {
    it(`redacts a ${sample.kind}`, () => {
      const out = redact(sample.text);
      expect(out).not.toContain(sample.value);
      // No partial value is left behind after a bounded match.
      expect(out).not.toContain(sample.value.slice(-16));
      expect(out).toContain(REDACTED);
      expect(detectCredential({ template: sample.text })).toBe('credential');
    });
  }

  for (const text of NOT_CREDENTIALS) {
    it(`leaves ordinary text alone: ${text}`, () => {
      expect(redact(text)).toBe(text);
      expect(detectCredential({ template: text })).toBe('clean');
    });
  }
});

describe('linear-time scanning of hostile input', () => {
  for (const { kind, text } of HOSTILE_INPUTS) {
    it(`detects on 1 MB of ${kind} in under a second`, () => {
      const t0 = performance.now();
      const verdict = detectCredential({ template: text });
      expect(performance.now() - t0, kind).toBeLessThan(1000);
      expect(['clean', 'credential']).toContain(verdict);
    });

    it(`redacts the largest scannable slice of ${kind} in under a second`, () => {
      const slice = text.slice(0, MAX_REDACT_CHARS);
      const t0 = performance.now();
      redact(slice);
      expect(performance.now() - t0, kind).toBeLessThan(1000);
    });
  }

  it('replaces text over the redaction cap with a fixed marker instead of scanning it', () => {
    const big = `${'x'.repeat(MAX_REDACT_CHARS)}${CANARY_KEY}`;
    expect(redact(big)).toBe(OVERSIZED);
    expect(clipRedacted(big, [])).toBe(OVERSIZED);
  });

  it('finds a credential deep inside a 1 MB string, across window boundaries', () => {
    const value = CREDENTIAL_SAMPLES[0]!.text;
    for (const at of [0, 64 * 1024 - 10, 200 * 1024 + 3, 1024 * 1024 - value.length]) {
      const text = `${'x '.repeat(at / 2)}${' '.repeat(at % 2)}${value}`.padEnd(1024 * 1024, ' ');
      expect(detectCredential({ t: text }), `at ${at}`).toBe('credential');
    }
  });

  const LONG_RUNS: readonly [string, string][] = [
    [
      'JWT with a 70K header',
      `${'ey' + 'J'}${'a'.repeat(70_000)}.${'ey' + 'J'}${'b'.repeat(20)}.sig`,
    ],
    ['userinfo with a 70K password', `https://u:${'p'.repeat(70_000)}@h`],
    ['userinfo with a 70K user', `https://${'u'.repeat(70_000)}:pw@h`],
  ];
  for (const size of [400 * 1024, 2 * 1024 * 1024]) {
    for (const [kind, token] of LONG_RUNS) {
      it(`finds a ${kind} inside a ${size / 1024} KB string, in under a second`, () => {
        const pad = ' '.repeat(Math.floor((size - token.length) / 2));
        const text = `${pad}${token}${pad}`;
        const t0 = performance.now();
        expect(detectCredential({ t: text })).toBe('credential');
        expect(performance.now() - t0).toBeLessThan(1000);
      });
    }
  }

  it('fails closed on a string over the hard scan cap', () => {
    expect(detectCredential({ t: ' '.repeat(MAX_SCAN_CHARS + 1) })).toBe('over-budget');
  });

  it('fails closed when the scan exceeds its work budget', () => {
    let t = 0;
    const now = () => (t += 100);
    expect(detectCredential({ a: 'x'.repeat(300 * 1024) }, { budgetMs: 150, now })).toBe(
      'over-budget',
    );
    let t2 = 0;
    const slow = () => (t2 += 10_000);
    expect(redact('some text', [], { budgetMs: 1, now: slow })).toBe(OVERSIZED);
  });
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
