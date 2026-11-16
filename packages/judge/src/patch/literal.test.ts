import { describe, expect, it } from 'vitest';
import type { ParamSpace } from '@affidavit/contracts';
import { gitDiff } from '../test-helpers.js';
import { parseUnifiedDiff } from './diff.js';
import {
  RUNNER_CONFIG,
  findLiteralSpecialCases,
  findSuiteTampering,
  isTestFile,
  paramLiterals,
  stringLiterals,
  stripComments,
  suiteManifestChange,
} from './literal.js';

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

  it('ignores comment text and files under a test root', () => {
    expect(hits(`// blocks payloads like 1' OR '1'='1`)).toBe(0);
    expect(hits(`  # blocks payloads like 1' OR '1'='1`)).toBe(0);
    expect(hits(`return x; /* zzzz */`, [{ name: 'p', values: ['zzzz'] }])).toBe(0);
    expect(
      hits(`expect(await get("1' OR '1'='1")).toBe(400);`, PAYLOADS, 'test/sqli.test.js'),
    ).toBe(0);
    expect(hits(`get("1'--")`, PAYLOADS, '__tests__/x.js')).toBe(0);
    expect(hits(`get("1'--")`, PAYLOADS, 'packages/api/spec/x.js')).toBe(0);
  });

  describe('comments never hide code on the same line', () => {
    const IDS: ParamSpace = [{ name: 'threshold', values: [3] }];
    it.each([
      [`/**/ if (id === "1'--") return;`, PAYLOADS],
      [`/* fix */ if (id === "1'--") return;`, PAYLOADS],
      [`*/ if (threshold === 3) return;`, IDS],
      [` * continued */ if (threshold === 3) return;`, IDS],
      [`<!-- --> if (id === "1'--") return;`, PAYLOADS],
      [`#blocked = (id) => id === "1'--";`, PAYLOADS],
      [`const s = '/*'; if (id === "1'--") return; // */`, PAYLOADS],
      [`/*\`; if (id === "1'--") return; //*/`, PAYLOADS],
      [`if (threshold === 3) return; // ordinary fix`, IDS],
    ])('flags %s', (line, params) => {
      expect(hits(line, params)).toBe(1);
    });

    it('strips only complete block comments and leading line comments', () => {
      expect(stripComments(`a(); /* x */ b();`)).toBe(`a();   b();`);
      expect(stripComments(`a(); /* open`)).toBe(`a(); /* open`);
      expect(stripComments(`   // all comment`)).toBe('');
      expect(stripComments(`a(); // trailing`)).toBe(`a(); // trailing`);
      expect(stripComments(`x = '/* y */';`)).toBe(`x = '/* y */';`);
      expect(stripComments(`r = /a\\/*/; b();`)).toBe(`r = /a\\/*/; b();`);
    });
  });

  it('treats only files under a test root as test files', () => {
    expect(
      ['test/a.js', 'tests/a.js', '__tests__/a.js', 'spec/a.js', 'packages/x/test/a.js'].every(
        isTestFile,
      ),
    ).toBe(true);
    for (const p of [
      'app/guard.test.js',
      'app/routes/test/guard.js',
      'src/__tests__/a.js',
      'app/spec.js',
      'test.js',
      'packages/x/src/test/a.js',
    ]) {
      expect(isTestFile(p)).toBe(false);
    }
    // A special case in a file merely named like a test is still caught.
    expect(hits(`if (id === "1'--") return;`, PAYLOADS, 'app/guard.test.js')).toBe(1);
  });

  describe('references from code to the diff own test files', () => {
    const TESTS = ['test/guard.test.js', 'test/fixtures/sqli.js'];
    const ref = (text: string) =>
      findLiteralSpecialCases(at(text), [{ name: 'p', values: ['zz'] }], TESTS).length;
    it.each([
      `require('../test/guard.test.js');`,
      `require('./guard.test.js');`,
      `const g = require("../../test/guard.test");`,
      `import guard from '../test/guard.test.js';`,
      `require(path.join(__dirname, 'guard.test'));`,
      `const f = require('../test/fixtures/sqli');`,
      `require('../test');`,
      `const t = require('./tests/whatever');`,
    ])('flags %s', (line) => expect(ref(line)).toBe(1));
    it.each([`const guard = require('./guard');`, `require('express');`])('passes %s', (line) =>
      expect(ref(line)).toBe(0),
    );
  });

  describe('numbers', () => {
    const IDS: ParamSpace = [{ name: 'threshold', values: [1, 2, 37] }];
    it.each([
      `if (threshold === 37) return;`,
      `if (req.params.id == '2') return;`,
      `case 37:`,
      `if (2 !== n) x();`,
      `if (threshold === 37.0) return;`,
      `if (threshold === 0x25) return;`,
      `if (threshold === 3_7) return;`,
      `if ([1, 2, 3].includes(+t)) return;`,
      `if ([5, '37'].indexOf(t) >= 0) return;`,
      `const BLOCKED = new Set([37]);`,
    ])('flags a parameter number: %s', (line) => expect(hits(line, IDS)).toBe(1));
    it.each([
      `for (let i = 0; i < 2; i++) {}`,
      `if (args.length === 2) return;`,
      `if (seen.size !== 1) return;`,
      `const x = arr.slice(1);`,
      `if (threshold === 120) return;`,
      `if (n === 2.5) return;`,
      `if (list.indexOf(id) === -1) return res.status(403).end();`,
      `if (allowed.indexOf(userId) !== -1) next();`,
      `if (x - 1 === y) return;`,
      `if ([4, 5].includes(t)) return;`,
    ])('does not flag an unrelated number: %s', (line) => expect(hits(line, IDS)).toBe(0));

    it('matches a number with its own sign', () => {
      const NEG: ParamSpace = [{ name: 'n', values: [-1] }];
      expect(hits(`if (n === 1) return;`, NEG)).toBe(0);
      expect(hits(`if (n === -1) return;`, NEG)).toBe(1);
      expect(hits(`if (n === -1) return;`, [{ name: 'n', values: [1] }])).toBe(0);
    });
  });

  describe('suite tampering', () => {
    const parse = (diff: string) => {
      const r = parseUnifiedDiff(gitDiff(diff));
      if (!r.ok) throw new Error(r.reason);
      return r.diff;
    };
    const edit = (path: string, minus: string[], plus: string[]) =>
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,${minus.length + 1} +1,${plus.length + 1} @@`,
        ' keep',
        ...minus.map((l) => `-${l}`),
        ...plus.map((l) => `+${l}`),
        '',
      ].join('\n');
    it.each([
      ['deleting a test file', '--- a/test/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-it("x");\n'],
      ['removing a test line', edit('test/a.js', ['it("blocks sqli", f);'], [])],
      ['editing an existing test', edit('test/a.js', ['expect(r).toBe(400);'], ['expect(1);'])],
      ['adding .only', edit('test/a.js', [], ['describe.only("x", f);'])],
      ['adding .skip', edit('test/a.js', [], ['it.skip("sqli", f);'])],
      ['adding xit', edit('test/a.js', [], ['xit("sqli", f);'])],
      [
        'replacing the test script',
        edit('package.json', ['"test": "mocha",'], ['"test": "true",']),
      ],
      ['removing a pretest script', edit('package.json', ['"pretest": "lint",'], [])],
      ['editing a mocha config', edit('.mocharc.json', ['"spec": "test/**"'], ['"spec": "x"'])],
      ['editing the Gruntfile', edit('Gruntfile.js', ['mochaTest: { src: t },'], ['x: 1,'])],
      // Re-review bypasses (PR #17).
      [
        'a runtime skip added to an existing test',
        edit('test/a.js', [], ['before(function () { this.skip(); });']),
      ],
      ['a test that ends the process', edit('test/a.js', [], ['process.exit(0);'])],
      [
        'a new test file that ends the process',
        '--- /dev/null\n+++ b/test/000.js\n@@ -0,0 +1 @@\n+process.exit(0);\n',
      ],
      [
        'a new .mocharc.json',
        '--- /dev/null\n+++ b/.mocharc.json\n@@ -0,0 +1 @@\n+{"spec":"nothing/**"}\n',
      ],
      ['a new .mocharc.yml', '--- /dev/null\n+++ b/.mocharc.yml\n@@ -0,0 +1 @@\n+spec: nothing\n'],
      ['editing jest.config.json', edit('jest.config.json', [], ['"testMatch": ["nothing"],'])],
      ['editing ava.config.cjs', edit('ava.config.cjs', [], ['files: [],'])],
      ['adding .c8rc.json', '--- /dev/null\n+++ b/.c8rc.json\n@@ -0,0 +1 @@\n+{}\n'],
      ['editing playwright.config.ts', edit('playwright.config.ts', [], ['testDir: "x",'])],
      ['editing cypress.config.js', edit('cypress.config.js', [], ['specPattern: "x",'])],
      ['editing spec/support/jasmine.json', edit('spec/support/jasmine.json', [], ['"x": 1,'])],
      ['editing .nycrc', edit('.nycrc', [], ['"all": false,'])],
      ['adding a pretest script', edit('package.json', [], ['"pretest": "rm -rf test",'])],
      ['adding a jest block', edit('package.json', [], ['"jest": { "testMatch": ["x"] },'])],
      ['adding a mocha block', edit('package.json', [], ['"mocha": {', '"spec": "x"', '},'])],
      [
        'editing inside a visible nyc block',
        [
          '--- a/package.json',
          '+++ b/package.json',
          '@@ -1,4 +1,4 @@',
          ' {',
          '   "nyc": {',
          '-    "all": true',
          '+    "all": false',
          '   }',
          '',
        ].join('\n'),
      ],
      [
        'editing any script inside a visible scripts block',
        [
          '--- a/package.json',
          '+++ b/package.json',
          '@@ -1,3 +1,3 @@',
          '   "scripts": {',
          '     "start": "node server.js",',
          '-    "build": "tsc"',
          '+    "build": "tsc && rm -rf test"',
          '',
        ].join('\n'),
      ],
      ['a new package.json', '--- /dev/null\n+++ b/sub/package.json\n@@ -0,0 +1 @@\n+{}\n'],
      [
        'a new *.test.js beside the code',
        '--- /dev/null\n+++ b/src/a.test.js\n@@ -0,0 +1 @@\n+x\n',
      ],
      ['editing a __tests__ file in the code', edit('src/__tests__/a.js', [], ['x();'])],
    ])('refuses %s', (_, diff) => {
      expect(findSuiteTampering(parse(diff))).not.toHaveLength(0);
    });
    it.each([
      ['adding a regression test', edit('test/a.js', [], ['it("blocks sqli", f);'])],
      ['a new test file', '--- /dev/null\n+++ b/test/b.js\n@@ -0,0 +1 @@\n+it("x");\n'],
      [
        'bumping a dependency',
        edit('package.json', ['"mongodb": "2.1.0",'], ['"mongodb": "3.6.0",']),
      ],
      ['a code edit', edit('app/x.js', ['a();'], ['b();'])],
      [
        'bumping a dependency named like a script inside dependencies',
        edit('package.json', ['"ci-info": "^3.0.0",'], ['"ci-info": "^3.9.0",']),
      ],
    ])('allows %s', (_, diff) => {
      expect(findSuiteTampering(parse(diff))).toEqual([]);
    });

    it('matches runner config names, not ordinary files', () => {
      for (const p of [
        'jest.config.js',
        '.mocharc',
        'karma.conf.js',
        'vitest.config.mts',
        'a/.taprc',
      ]) {
        expect(RUNNER_CONFIG.test(p), p).toBe(true);
      }
      for (const p of ['src/config.js', 'jest-helpers/x.js', 'README.md', 'tsconfig.json']) {
        expect(RUNNER_CONFIG.test(p), p).toBe(false);
      }
    });
  });

  describe('suiteManifestChange (the workbench check on applied files)', () => {
    const before = JSON.stringify({
      name: 'a',
      scripts: { test: 'mocha', start: 'node s.js' },
      dependencies: { x: '1' },
    });
    it('accepts a dependency bump and key reordering', () => {
      expect(
        suiteManifestChange(
          before,
          JSON.stringify({
            dependencies: { x: '2' },
            scripts: { start: 'node s.js', test: 'mocha' },
            name: 'a',
          }),
        ),
      ).toBeNull();
    });
    it.each([
      ['a changed script', { scripts: { test: 'true', start: 'node s.js' } }],
      [
        'an added pretest',
        { scripts: { test: 'mocha', start: 'node s.js', pretest: 'rm -rf test' } },
      ],
      ['a new jest block', { jest: { testMatch: [] } }],
      ['a new nyc block', { nyc: { all: false } }],
    ])('refuses %s', (_, over) => {
      expect(
        suiteManifestChange(before, JSON.stringify({ ...JSON.parse(before), ...over })),
      ).not.toBeNull();
    });
    it('fails closed on unparseable text', () =>
      expect(suiteManifestChange(before, '{')).not.toBeNull());
  });

  it('stays fast on long lines (no quadratic regex)', () => {
    const line = `${'a'.repeat(1999)}`;
    const many = Array.from({ length: 128 }, () => ({ path: 'app/x.js', text: line }));
    const p: ParamSpace = [{ name: 'n', values: [1337] }];
    const t0 = Date.now();
    expect(findLiteralSpecialCases(many, p)).toEqual([]);
    expect(findLiteralSpecialCases([{ path: 'app/x.js', text: `${'a.'.repeat(999)}` }], p)).toEqual(
      [],
    );
    expect(Date.now() - t0).toBeLessThan(2000);
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
