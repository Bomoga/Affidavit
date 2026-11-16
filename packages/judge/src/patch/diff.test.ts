import { describe, expect, it } from 'vitest';
import { addedLines, parseUnifiedDiff, renderDiff, selectFiles, unsafePathReason } from './diff.js';

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
    const two = `${GOOD}--- /dev/null\n+++ b/test/a.js\n@@ -0,0 +1 @@\n+it('x');\n`;
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

  it('reads a plain diff without git headers, new files and deleted files', () => {
    const r = parseUnifiedDiff(
      [
        '--- /dev/null',
        '+++ b/test/regression.test.js',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+b',
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
    expect(parseUnifiedDiff(diff).ok).toBe(false);
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
