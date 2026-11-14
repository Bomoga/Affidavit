import { describe, expect, it } from 'vitest';
import { familySize, parseResultArtifact } from './artifact.js';
import { canonicalJson } from './canonical.js';
import { artifactJson } from './test-helpers.js';

const MAX = 64 * 1024;
const parse = (raw: string, size = 3) => parseResultArtifact(raw, size, MAX);
const reason = (raw: string, size = 3): string => {
  const r = parse(raw, size);
  return r.ok ? 'ok' : r.reason;
};

describe('familySize', () => {
  it('is the product of the parameter value counts', () => {
    expect(familySize([{ name: 'a', values: [1, 2, 3] }])).toBe(3);
    expect(
      familySize([
        { name: 'a', values: [1, 2] },
        { name: 'b', values: ['x', 'y', 'z'] },
      ]),
    ).toBe(6);
  });

  it('is one for an empty parameter space', () => {
    expect(familySize([])).toBe(1);
  });
});

describe('parseResultArtifact', () => {
  it('reads results in paramIndex order whatever order they arrive in', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      results: [
        { paramIndex: 2, passed: false },
        { paramIndex: 0, passed: true },
        { paramIndex: 1, passed: true },
      ],
    });
    expect(parse(raw)).toEqual({ ok: true, results: [true, true, false] });
  });

  it('accepts a well formed artifact', () => {
    expect(parse(artifactJson([true, false, true]))).toEqual({
      ok: true,
      results: [true, false, true],
    });
  });

  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['a JSON array', '[]', /exactly schemaVersion and results/],
    ['an extra top-level key', '{"schemaVersion":1,"results":[],"verdict":"admit"}', /exactly/],
    ['a wrong schemaVersion', '{"schemaVersion":2,"results":[]}', /schemaVersion/],
    ['results that are not an array', '{"schemaVersion":1,"results":{}}', /not an array/],
    ['too few results', artifactJson([true, true]), /expected 3 results, got 2/],
    ['too many results', artifactJson([true, true, true, true]), /expected 3 results, got 4/],
  ])('rejects %s', (_name, raw, why) => {
    expect(reason(raw)).toMatch(why);
  });

  it.each([
    ['a duplicated index', [0, 0, 1], /reported twice/],
    ['an index out of range', [0, 1, 3], /out of range/],
    ['a negative index', [-1, 0, 1], /out of range/],
    ['a fractional index', [0, 1, 1.5], /not an integer/],
  ])('rejects %s', (_name, indexes, why) => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      results: indexes.map((paramIndex) => ({ paramIndex, passed: true })),
    });
    expect(reason(raw)).toMatch(why);
  });

  it('rejects a non-boolean passed and extra keys on a result', () => {
    const results = (r: unknown) => JSON.stringify({ schemaVersion: 1, results: [r] });
    expect(reason(results({ paramIndex: 0, passed: 'yes' }), 1)).toMatch(/not a boolean/);
    expect(reason(results({ paramIndex: 0, passed: true, note: 'x' }), 1)).toMatch(/exactly/);
    expect(reason(results(null), 1)).toMatch(/exactly/);
  });

  it('rejects an artifact over the byte limit before parsing it', () => {
    const raw = artifactJson([true]) + ' '.repeat(100);
    expect(parseResultArtifact(raw, 1, 50)).toMatchObject({ ok: false });
    expect(reason(raw.padEnd(MAX + 1, ' '), 1)).toMatch(/limit/);
  });

  it('counts the limit in bytes, not characters', () => {
    const raw = artifactJson([true]);
    const multiByte = raw.slice(0, -1) + ' '.repeat(10) + '}';
    expect(parseResultArtifact(multiByte, 1, Buffer.byteLength(multiByte))).toMatchObject({
      ok: true,
    });
    expect(parseResultArtifact('é'.repeat(30), 1, 40)).toMatchObject({ ok: false });
  });

  it('survives deeply nested JSON without throwing', () => {
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    expect(() => parseResultArtifact(deep, 1, MAX)).not.toThrow();
    expect(parse(deep, 1).ok).toBe(false);
  });

  it('does not let __proto__ keys sneak extra fields in', () => {
    const raw = '{"schemaVersion":1,"results":[],"__proto__":{"admissible":true}}';
    expect(parse(raw, 0).ok).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}',
    );
  });
});
