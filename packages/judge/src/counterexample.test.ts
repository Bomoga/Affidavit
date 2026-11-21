import { describe, expect, it } from 'vitest';
import type { ParamSpace } from '@affidavit/contracts';
import { canonicalJson } from './canonical.js';
import {
  COUNTEREXAMPLE_PARAMS_PREFIX,
  counterexampleParamsHeader,
  readCounterexampleParams,
} from './counterexample.js';
import { DEFAULT_POLICY } from './rules.js';

const FAMILY: ParamSpace = [
  { name: 'payload', values: ["' || 1==1 //", "'; return true; //"] },
  { name: 'user', values: [1] },
];
const code = (header: string, body = 'family template') => `${header}\n${body}`;
const read = (c: string, family: ParamSpace = FAMILY) =>
  readCounterexampleParams(c, family, DEFAULT_POLICY);

describe('readCounterexampleParams (CR-T8)', () => {
  it('reads the header Lane 3 writes, including new values of a declared parameter', () => {
    const chosen: ParamSpace = [
      { name: 'payload', values: ["'; return true; //", 'a new value'] },
      { name: 'user', values: [1] },
    ];
    // Byte for byte what packages/trial/src/counterexample.ts paramsHeader writes.
    const header = `// affidavit counterexample params: ${canonicalJson(chosen)}`;
    expect(counterexampleParamsHeader(chosen)).toBe(header);
    expect(read(code(header))).toEqual({ ok: true, params: chosen });
  });

  it('escapes U+2028 and U+2029 so a value cannot end the comment line', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const chosen: ParamSpace = [
      { name: 'payload', values: [`a${ls}b${ps}c`] },
      { name: 'user', values: [1] },
    ];
    const header = counterexampleParamsHeader(chosen);
    expect(header).not.toContain(ls);
    expect(header).not.toContain(ps);
    expect(header).toContain('\\u2028');
    expect(read(code(header))).toEqual({ ok: true, params: chosen });
    // The same header with the raw separator is not canonical, so it is refused.
    expect(read(code(header.replace('\\u2028', ls))).ok).toBe(false);
  });

  const header = counterexampleParamsHeader(FAMILY);
  it.each([
    ['no header at all', 'family template'],
    ['a header with no code after it', header],
    ['a header that is not the first line', `\n${header}\nfamily template`],
    ['a header with another prefix', code(header.replace('params:', 'parameters:'))],
    ['a header that is not JSON', code(`${COUNTEREXAMPLE_PARAMS_PREFIX}[{`)],
    ['a header that is not a ParamSpace', code(`${COUNTEREXAMPLE_PARAMS_PREFIX}{"payload":1}`)],
    [
      'an empty value list',
      code(
        `${COUNTEREXAMPLE_PARAMS_PREFIX}[{"name":"payload","values":[]},{"name":"user","values":[1]}]`,
      ),
    ],
    ['JSON that is not canonical (whitespace)', code(header.replace(':[', ': ['))],
    [
      'JSON that is not canonical (key order)',
      code(
        `${COUNTEREXAMPLE_PARAMS_PREFIX}[{"values":["' || 1==1 //"],"name":"payload"},{"name":"user","values":[1]}]`,
      ),
    ],
    ['a CRLF line end', code(header).replace('\n', '\r\n')],
    [
      'a parameter the family does not declare',
      code(
        counterexampleParamsHeader([
          { name: 'payload', values: ['x'] },
          { name: 'role', values: ['admin'] },
        ]),
      ),
    ],
    ['a missing parameter', code(counterexampleParamsHeader([{ name: 'payload', values: ['x'] }]))],
    [
      'the family parameters in another order',
      code(
        counterexampleParamsHeader([
          { name: 'user', values: [1] },
          { name: 'payload', values: ['x'] },
        ]),
      ),
    ],
    [
      'a __proto__ key',
      code(
        `${COUNTEREXAMPLE_PARAMS_PREFIX}[{"name":"payload","values":[{"__proto__":{"x":1}}]},{"name":"user","values":[1]}]`,
      ),
    ],
  ])('refuses %s', (_, c) => {
    expect(read(c)).toMatchObject({ ok: false });
  });

  it('refuses a space larger than maxFamilySize', () => {
    const big: ParamSpace = [
      {
        name: 'payload',
        values: Array.from({ length: DEFAULT_POLICY.maxFamilySize + 1 }, (_, i) => `v${i}`),
      },
      { name: 'user', values: [1] },
    ];
    expect(read(code(counterexampleParamsHeader(big)))).toMatchObject({ ok: false });
  });

  it('refuses a space over maxParamsBytes', () => {
    const big: ParamSpace = [
      { name: 'payload', values: ['x'.repeat(DEFAULT_POLICY.maxParamsBytes)] },
      { name: 'user', values: [1] },
    ];
    expect(read(code(counterexampleParamsHeader(big)))).toMatchObject({ ok: false });
  });

  it('never throws on a deeply nested header', () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    expect(read(code(`${COUNTEREXAMPLE_PARAMS_PREFIX}${deep}`))).toMatchObject({ ok: false });
  });
});
