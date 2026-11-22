import { describe, expect, it } from 'vitest';
import { MAX_DIFF_LINE_LENGTH, MAX_DIFF_LINES, parseUnifiedDiff } from './diff.js';

const ONE_FILE = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -10,4 +10,5 @@ function f() {',
  ' keep',
  '-old one',
  '+new one',
  '+new two',
  ' keep two',
  ' keep three',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('reads adds, removals and context with old and new line numbers', () => {
    const { lines, added, removed } = parseUnifiedDiff(ONE_FILE);
    expect(added).toBe(2);
    expect(removed).toBe(1);
    expect(lines.map((l) => l.kind)).toEqual([
      'file',
      'file',
      'file',
      'hunk',
      'ctx',
      'del',
      'add',
      'add',
      'ctx',
      'ctx',
    ]);
    expect(lines[4]).toEqual({ kind: 'ctx', oldNo: 10, newNo: 10, text: 'keep' });
    expect(lines[5]).toEqual({ kind: 'del', oldNo: 11, text: 'old one' });
    expect(lines[6]).toEqual({ kind: 'add', newNo: 11, text: 'new one' });
    expect(lines[7]).toEqual({ kind: 'add', newNo: 12, text: 'new two' });
    expect(lines[8]).toEqual({ kind: 'ctx', oldNo: 12, newNo: 13, text: 'keep two' });
    expect(lines[9]).toEqual({ kind: 'ctx', oldNo: 13, newNo: 14, text: 'keep three' });
  });

  it('reads several files and hunks, and a hunk header without counts', () => {
    const diff = [
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '@@ -20,2 +20,1 @@',
      ' c',
      '-d',
      '--- a/y.js',
      '+++ b/y.js',
      '@@ -5,0 +6,2 @@',
      '+e',
      '+f',
      '\\ No newline at end of file',
    ].join('\r\n');
    const { lines, added, removed } = parseUnifiedDiff(diff);
    expect(added).toBe(3);
    expect(removed).toBe(2);
    expect(lines.filter((l) => l.kind === 'file')).toHaveLength(4);
    expect(lines.filter((l) => l.kind === 'hunk')).toHaveLength(3);
    expect(lines.find((l) => l.kind === 'del' && l.text === 'd')).toEqual({
      kind: 'del',
      oldNo: 21,
      text: 'd',
    });
    expect(lines.find((l) => l.kind === 'add' && l.text === 'f')).toEqual({
      kind: 'add',
      newNo: 7,
      text: 'f',
    });
    expect(lines.at(-1)).toEqual({ kind: 'ctx', text: '\\ No newline at end of file' });
  });

  it('reads a removed line that looks like a file header as a removal inside a hunk', () => {
    const { lines } = parseUnifiedDiff('@@ -1,1 +1,1 @@\n--- x\n+++ y\n');
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add']);
  });

  it('never throws on garbage and keeps unknown lines as unnumbered context', () => {
    for (const input of [
      '',
      'not a diff at all',
      '@@ garbage @@\n+x',
      '@@ -99999999999999999999,1 +1,1 @@\n+x',
      '\u0000\u0001\n\n\n',
      '+++\n---\n@@',
    ]) {
      const out = parseUnifiedDiff(input);
      for (const l of out.lines) {
        if (l.kind === 'file' || l.kind === 'hunk') expect(l.oldNo ?? l.newNo).toBeUndefined();
      }
      expect(out.added + out.removed).toBeLessThanOrEqual(out.lines.length);
    }
    expect(parseUnifiedDiff('not a diff at all').lines).toEqual([
      { kind: 'ctx', text: 'not a diff at all' },
    ]);
    expect(parseUnifiedDiff(undefined as unknown as string).lines).toEqual([]);
  });

  it('caps the line count and the line length of an oversized diff', () => {
    const body = Array.from({ length: 10_000 }, () => '+' + 'x'.repeat(2000)).join('\n');
    const out = parseUnifiedDiff(`@@ -1,0 +1,10000 @@\n${body}`);
    expect(out.lines.length).toBeLessThanOrEqual(MAX_DIFF_LINES);
    for (const l of out.lines) expect(l.text.length).toBeLessThanOrEqual(MAX_DIFF_LINE_LENGTH);
    expect(out.added).toBe(out.lines.filter((l) => l.kind === 'add').length);
  });

  it('is deterministic', () => {
    expect(parseUnifiedDiff(ONE_FILE)).toEqual(parseUnifiedDiff(ONE_FILE));
  });
});
