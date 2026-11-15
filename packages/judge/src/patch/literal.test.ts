import { describe, expect, it } from 'vitest';
import type { ParamSpace } from '@affidavit/contracts';
import { findLiteralSpecialCases, paramLiterals, stringLiterals } from './literal.js';

const PAYLOADS: ParamSpace = [{ name: 'payload', values: ["'", "1' OR '1'='1", "1'--"] }];
const at = (text: string, path = 'app/data/allocations-dao.js') => [{ path, text }];
const hits = (text: string, params: ParamSpace = PAYLOADS, path?: string) =>
  findLiteralSpecialCases(at(text, path), params).length;

describe('literal-only-patch detection', () => {
  it.each([
    `if (id === "1' OR '1'='1") return res.status(400).end();`,
    `if (["1'--"].includes(id)) throw new Error('no');`,
    `if (id.indexOf('1\\'--') !== -1) return;`,
    `if (/1' OR '1'='1/.test(id)) return;`,
    `const BLOCKED = new Set(["1' OR '1'='1", "1'--"]);`,
    `if (id.includes("OR '1'='1")) return;`,
  ])('flags special-casing a witness payload: %s', (line) => {
    expect(hits(line)).toBe(1);
  });

  it.each([
    `const t = parseInt(threshold, 10);`,
    `return { $and: [{ userId: parsedUserId }, { stocks: { $gt: t } }] };`,
    `const safe = id.replace(/'/g, "''");`,
    `db.query('SELECT * FROM items WHERE id = ?', [id]);`,
    `if (!/^[0-9]+$/.test(id)) return res.status(400).end('bad id');`,
  ])('passes a real fix: %s', (line) => {
    expect(hits(line)).toBe(0);
  });

  it('ignores comment lines and test files', () => {
    expect(hits(`// blocks payloads like 1' OR '1'='1`)).toBe(0);
    expect(
      hits(`expect(await get("1' OR '1'='1")).toBe(400);`, PAYLOADS, 'test/sqli.test.js'),
    ).toBe(0);
    expect(hits(`get("1'--")`, PAYLOADS, 'app/__tests__/x.js')).toBe(0);
  });

  describe('numbers', () => {
    const IDS: ParamSpace = [{ name: 'threshold', values: [1, 2, 37] }];
    it.each([
      `if (threshold === 37) return;`,
      `if (req.params.id == '2') return;`,
      `case 37:`,
      `if (2 !== n) x();`,
    ])('flags equality with a parameter number: %s', (line) => expect(hits(line, IDS)).toBe(1));
    it.each([
      `for (let i = 0; i < 2; i++) {}`,
      `if (args.length === 2) return;`,
      `if (seen.size !== 1) return;`,
      `const x = arr.slice(1);`,
      `if (threshold === 120) return;`,
      `if (n === 2.5) return;`,
    ])('does not flag an unrelated number: %s', (line) => expect(hits(line, IDS)).toBe(0));
  });

  it('collects strings, object keys and numbers from nested values', () => {
    const p: ParamSpace = [{ name: 'q', values: [{ $where: 'sleep(1)' }, [7, 'x'], 'ok'] }];
    expect(paramLiterals(p)).toEqual({ strings: ['$where', 'sleep(1)', 'ok'], numbers: [7] });
    expect(hits(`if (key === '$where') delete q[key];`, p)).toBe(1);
  });

  it('decodes escapes in string literals', () => {
    expect(stringLiterals(String.raw`a("\x31' OR '1'='1", 'b', \`c\${d}\`)`)).toEqual([
      "1' OR '1'='1",
      'b',
    ]);
  });
});
