import { describe, expect, it } from 'vitest';
import { gitDiff } from '../test-helpers.js';
import {
  MAX_LINE_CHARS,
  addedLines,
  parseUnifiedDiff,
  renderDiff,
  selectFiles,
  unsafePathReason,
} from './diff.js';

const GOOD = `diff --git a/app/data/allocations-dao.js b/app/data/allocations-dao.js
index 1111111..2222222 100644
--- a/app/data/allocations-dao.js
+++ b/app/data/allocations-dao.js
@@ -68,3 +68,4 @@ function AllocationsDAO(db) {
         function searchCriteria() {
-            return { $where: \`this.userId == \${parsedUserId} && this.stocks > '\${threshold}'\` };
+            const t = parseInt(threshold, 10);
+            return { $and: [{ userId: parsedUserId }, { stocks: { $gt: t } }] };
         }
`;

describe('selectFiles and renderDiff', () => {
  it('rebuilds the diff text, and a subset of its files', () => {
    const two = `${GOOD}${gitDiff("--- /dev/null\n+++ b/test/a.js\n@@ -0,0 +1 @@\n+it('x');\n")}`;
    const r = parseUnifiedDiff(two);
    if (!r.ok) throw new Error(r.reason);
    expect(renderDiff(r.diff)).toBe(two);
    const code = selectFiles(r.diff, (f) => !f.path.startsWith('test/'));
    expect(renderDiff(code)).toBe(GOOD);
    expect(code.linesChanged).toBe(3);
    expect(renderDiff(selectFiles(r.diff, () => false))).toBe('');
  });
});

describe('parseUnifiedDiff', () => {
  it('reads a git diff and counts added plus removed lines', () => {
    const r = parseUnifiedDiff(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff.linesChanged).toBe(3);
    expect(r.diff.files).toEqual([
      expect.objectContaining({ path: 'app/data/allocations-dao.js', status: 'modified' }),
    ]);
    expect(addedLines(r.diff).map((l) => l.text.trim())).toEqual([
      'const t = parseInt(threshold, 10);',
      'return { $and: [{ userId: parsedUserId }, { stocks: { $gt: t } }] };',
    ]);
  });

  it('reads new files and deleted files', () => {
    const r = parseUnifiedDiff(
      [
        'diff --git a/test/regression.test.js b/test/regression.test.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/test/regression.test.js',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+b',
        'diff --git a/old.js b/old.js',
        'deleted file mode 100644',
        '--- a/old.js',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(r.ok && r.diff.files.map((f) => `${f.status}:${f.path}`)).toEqual([
      'added:test/regression.test.js',
      'deleted:old.js',
    ]);
  });

  // git apply (-p1) strips the first component of whatever name it is given, so the Judge accepts
  // only the exact names git itself writes; anything else could mean another file to git.
  it.each([
    [
      'a section with no diff --git header',
      '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-a\n+b\n',
      /diff --git/,
    ],
    [
      'a deletion whose old name has another first component (git deletes test/a.js)',
      'diff --git a/z/test/a.js b/z/test/a.js\n--- z/test/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-it("x");\n',
      /does not name a\/z\/test\/a\.js/,
    ],
    [
      'a header that looks like a test file but git reads as src/app.js',
      'diff --git a/test/src/app.js b/test/src/app.js\n--- test/src/app.js\n+++ test/src/app.js\n@@ -1 +1,2 @@\n x\n+globalThis.__ok = true;\n',
      /does not name a\/test\/src\/app\.js/,
    ],
    [
      'a +++ name without b/',
      'diff --git a/x.js b/x.js\n--- a/x.js\n+++ x.js\n@@ -1 +1 @@\n-a\n+b\n',
      /does not name b\/x\.js/,
    ],
    [
      'a header for a different file than its names',
      'diff --git a/x.js b/x.js\n--- a/y.js\n+++ b/y.js\n@@ -1 +1 @@\n-a\n+b\n',
      /does not name/,
    ],
    [
      'a line over the length cap',
      `diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+${'a'.repeat(MAX_LINE_CHARS)}\n`,
      /over 2000 characters/,
    ],
  ])('rejects %s', (_, diff, why) => {
    const r = parseUnifiedDiff(diff);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(why);
  });

  it('accepts a line at the length cap', () => {
    const line = 'a'.repeat(MAX_LINE_CHARS - 1);
    expect(
      parseUnifiedDiff(
        `diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+${line}\n`,
      ).ok,
    ).toBe(true);
  });

  it.each([
    ['empty diff', ''],
    ['the contracts sample, which has no hunk', '--- a/x.js\n+++ b/x.js\n'],
    ['a hunk shorter than its header', '--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-a\n+b\n'],
    ['a hunk longer than its header', '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n+c\n'],
    ['context-only hunk', '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n a\n'],
    ['a rename', '--- a/x.js\n+++ b/y.js\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a path escaping the tree', '--- a/../x.js\n+++ b/../x.js\n@@ -1 +1 @@\n-a\n+b\n'],
    ['an absolute path', '--- /etc/passwd\n+++ /etc/passwd\n@@ -1 +1 @@\n-a\n+b\n'],
    [
      'a path in .git',
      '--- a/.git/hooks/pre-commit\n+++ b/.git/hooks/pre-commit\n@@ -1 +1 @@\n-a\n+b\n',
    ],
    [
      'a binary patch',
      'diff --git a/x.png b/x.png\nindex 1..2 100644\nGIT binary patch\nliteral 0\n',
    ],
    [
      'a symlink',
      'diff --git a/x b/x\nnew file mode 120000\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+/etc\n',
    ],
    ['a mode change', 'diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n'],
    [
      'the same file twice',
      '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n--- a/x.js\n+++ b/x.js\n@@ -2 +2 @@\n-c\n+d\n',
    ],
    ['trailing junk', '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\nrm -rf /\n'],
  ])('rejects %s', (_, diff) => {
    expect(parseUnifiedDiff(gitDiff(diff)).ok).toBe(false);
  });
});

describe('unsafePathReason', () => {
  it.each(['a/b.js', 'app/data/allocations-dao.js', '@scope/x.ts', '.github/ok.yml'])(
    'accepts %s',
    (p) => expect(unsafePathReason(p)).toBeNull(),
  );
  it.each(['', '/abs', 'a/../b', './a', 'a//b', '.git/config', 'x/.GIT/y', 'a\\b', 'a b', '"q"'])(
    'rejects %j',
    (p) => expect(unsafePathReason(p)).not.toBeNull(),
  );
});
