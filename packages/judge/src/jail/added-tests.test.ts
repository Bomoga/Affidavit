import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffFile, ParsedDiff } from '../patch/diff.js';
import { isRunnableTest, planAddedTests, testRunnerOf } from './workbench.js';

const diffOf = (...files: [string, DiffFile['status']][]): ParsedDiff => ({
  files: files.map(([path, status]) => ({ path, status, added: [], removed: [], raw: [] })),
  linesChanged: 0,
});

describe('testRunnerOf', () => {
  it.each([
    [{ devDependencies: { mocha: '^2' } }, 'mocha'],
    [{ devDependencies: { jest: '29' } }, 'jest'],
    [{ dependencies: { vitest: '5' } }, 'vitest'],
    [{ devDependencies: { mocha: '1', vitest: '5' } }, 'vitest'],
  ])('finds the runner declared in %j', (pkg, bin) => {
    expect(testRunnerOf(JSON.stringify(pkg))?.bin).toBe(bin);
  });

  it.each(['{}', '{"devDependencies":{"tape":"1"}}', 'not json', 'null', '[]'])(
    'returns null for %s',
    (text) => {
      expect(testRunnerOf(text)).toBeNull();
    },
  );
});

describe('planAddedTests', () => {
  let root = '';
  let vulnerable = '';
  let applied = '';
  let scratch = '';
  const put = (base: string, rel: string, text: string): void => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'affidavit-added-tests-'));
    vulnerable = join(root, 'src');
    applied = join(root, 'full');
    scratch = join(root, 'ws');
    for (const d of [vulnerable, applied, scratch]) mkdirSync(d);
    put(vulnerable, 'package.json', JSON.stringify({ devDependencies: { mocha: '^2.4.5' } }));
    put(applied, 'test/unit/where.test.js', 'it("x", () => {});');
    put(applied, 'test/unit/helper.js', 'module.exports = 1;');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs the added test files with the vulnerable commit runner, every added file mounted read only', async () => {
    const run = await planAddedTests(
      diffOf(['test/unit/where.test.js', 'added'], ['test/unit/helper.js', 'added']),
      vulnerable,
      applied,
      '/usr/src/app',
      scratch,
    );
    // helper.js is mounted so the test can load it, but it is not a test, so it is not passed.
    expect(run?.command).toEqual([
      '/usr/src/app/node_modules/.bin/mocha',
      'test/unit/where.test.js',
    ]);
    expect(run?.mounts.map((m) => [m.containerPath, m.readOnly])).toEqual([
      ['/usr/src/app/test/unit/where.test.js', true],
      ['/usr/src/app/test/unit/helper.js', true],
    ]);
    // Copies live in the patch workspace, readable by the jail user, with the applied content.
    const copy = run!.mounts[0]!.hostPath;
    expect(copy.startsWith(scratch)).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe('it("x", () => {});');
    expect(statSync(copy).mode & 0o777).toBe(0o644);
  });

  it('returns null with no added file, no runner, or a file it will not mount', async () => {
    const added = diffOf(['test/unit/where.test.js', 'added']);
    expect(await planAddedTests(diffOf(), vulnerable, applied, '/app', scratch)).toBeNull();
    // Edited or deleted tests are refused earlier; they are never run here.
    expect(
      await planAddedTests(diffOf(['test/a.js', 'modified']), vulnerable, applied, '/app', scratch),
    ).toBeNull();

    put(vulnerable, 'package.json', JSON.stringify({ devDependencies: { tape: '1' } }));
    expect(await planAddedTests(added, vulnerable, applied, '/app', scratch)).toBeNull();
    put(vulnerable, 'package.json', JSON.stringify({ devDependencies: { mocha: '2' } }));

    // Every added file is mounted, so a bad path refuses the run even next to a good test.
    for (const path of ['test/../../etc/passwd', 'test/a b.js', 'test/a,b.js', '/test/a.js']) {
      expect(
        await planAddedTests(
          diffOf(['test/unit/where.test.js', 'added'], [path, 'added']),
          vulnerable,
          applied,
          '/app',
          scratch,
        ),
      ).toBeNull();
    }
    expect(
      await planAddedTests(
        diffOf(['test/missing.js', 'added']),
        vulnerable,
        applied,
        '/app',
        scratch,
      ),
    ).toBeNull();
    symlinkSync('/etc/hostname', join(applied, 'test/link.js'));
    expect(
      await planAddedTests(diffOf(['test/link.js', 'added']), vulnerable, applied, '/app', scratch),
    ).toBeNull();
    expect(await planAddedTests(added, vulnerable, applied, '/a/../b', scratch)).toBeNull();
    // A mount the jail refuses (a working directory under the reserved /tmp) is null, not a throw.
    expect(await planAddedTests(added, vulnerable, applied, '/tmp/app', scratch)).toBeNull();
  });

  it('returns null for a patch that adds only fixtures and helpers', async () => {
    put(applied, 'test/fixtures/payload.json', '{"id": "1\'--"}');
    put(applied, 'test/__snapshots__/where.test.js.snap', 'exports[`x`] = 1;');
    for (const bin of ['mocha', 'jest', 'vitest']) {
      put(vulnerable, 'package.json', JSON.stringify({ devDependencies: { [bin]: '1' } }));
      expect(
        await planAddedTests(
          diffOf(
            ['test/fixtures/payload.json', 'added'],
            ['test/__snapshots__/where.test.js.snap', 'added'],
            ['test/unit/helper.js', 'added'],
          ),
          vulnerable,
          applied,
          '/app',
          scratch,
        ),
      ).toBeNull();
    }
  });

  it('mounts a fixture next to a test but passes only the test to the runner', async () => {
    put(vulnerable, 'package.json', JSON.stringify({ devDependencies: { jest: '29' } }));
    put(applied, 'test/fixtures/payload.json', '{"id": 1}');
    const run = await planAddedTests(
      diffOf(['test/fixtures/payload.json', 'added'], ['test/unit/where.test.js', 'added']),
      vulnerable,
      applied,
      '/app',
      scratch,
    );
    expect(run?.command).toEqual([
      '/app/node_modules/.bin/jest',
      '--ci',
      '--runTestsByPath',
      'test/unit/where.test.js',
    ]);
    expect(run?.mounts.map((m) => m.containerPath)).toEqual([
      '/app/test/fixtures/payload.json',
      '/app/test/unit/where.test.js',
    ]);
  });
});

describe('isRunnableTest', () => {
  it.each([
    ['test/unit/where.test.js', 'jest'],
    ['test/where.spec.ts', 'vitest'],
    ['tests/a.test.mjs', 'mocha'],
    ['__tests__/a.spec.tsx', 'jest'],
    ['packages/api/test/a.test.cjs', 'vitest'],
    ['test/a.js', 'mocha'],
    ['spec/a.mjs', 'mocha'],
    ['packages/api/test/a.cjs', 'mocha'],
  ])('runs %s with %s', (path, bin) => {
    expect(isRunnableTest(path, bin)).toBe(true);
  });

  it.each([
    ['test/a.js', 'jest'],
    ['test/a.js', 'vitest'],
    ['test/unit/helper.js', 'mocha'],
    ['test/fixtures/data.json', 'mocha'],
    ['test/__snapshots__/a.test.js.snap', 'jest'],
    ['test/a.ts', 'mocha'],
    ['src/a.test.js', 'jest'],
  ])('does not run %s with %s', (path, bin) => {
    expect(isRunnableTest(path, bin)).toBe(false);
  });
});
