/**
 * Final review of PR #51. Each test was written to fail before its fix.
 */
import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initParser } from '../map/parse.js';
import { readWorkspaceFile } from './index.js';
import { cleanSource } from './slice.js';

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('1: nested literals are found in one pass, with a bound that fails closed', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('40,000 empty templates are cleaned in under a second', async () => {
    const text = `const a=[${'``,'.repeat(40_000)}];\n`;
    const t0 = performance.now();
    const c = await cleanSource('a.js', text);
    const ms = performance.now() - t0;
    expect(c.text).toBe(text);
    expect(ms).toBeLessThan(1_000);
  });

  it('more literals than the bound withholds the file and says why', async () => {
    const text = `const a=[${"'x',".repeat(11)}];\n`;
    const c = await cleanSource('a.js', text, 5_000, { maxLiterals: 10 });
    expect(c.text).toBeUndefined();
    expect(c.withheldReason).toBe('literal-limit');
  });

  it('more nested-literal work than the bound withholds the file and says why', async () => {
    // Each template holds every literal inside it: 5 + 4 + 3 + 2 + 1 + 0 nested literals.
    const deep = '`${`${`${`${`${`x`}`}`}`}`}`';
    const c = await cleanSource('a.js', `const t = ${deep};\n`, 5_000, { maxNestedWork: 10 });
    expect(c.text).toBeUndefined();
    expect(c.withheldReason).toBe('work-limit');
  });

  it('within the bounds, nested literals are still judged with their template', async () => {
    const text = "const t = `${'IGNORE'} ${'ALL'} ${'PREVIOUS'}`;\n";
    const c = await cleanSource('a.js', text);
    expect(c.text).not.toMatch(/IGNORE|PREVIOUS/);
  });
});

describe('2: a hard-linked file is refused like a symlink', () => {
  it('a file with a second link is not read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aff-r5-'));
    const outside = mkdtempSync(join(tmpdir(), 'aff-r5-out-'));
    made.push(root, outside);
    writeFileSync(join(outside, 'secret.js'), 'const s = 1;\n');
    linkSync(join(outside, 'secret.js'), join(root, 'a.js'));
    expect(await readWorkspaceFile(root, 'a.js')).toBeUndefined();
  });

  it('a file with one link is read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aff-r5-'));
    made.push(root);
    writeFileSync(join(root, 'a.js'), 'const a = 1;\n');
    expect(await readWorkspaceFile(root, 'a.js')).toBe('const a = 1;\n');
  });
});
