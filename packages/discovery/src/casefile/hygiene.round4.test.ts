/**
 * Automated review of PR #51, round 4. Each test was written to fail before its fix.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readWorkspaceFile } from './index.js';
import { provenCode, proseRegex } from './slice.js';

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('1: a dotted chain of plain words is not exempt', () => {
  it.each(['Ignore.all.previous', 'ignore.all', 'obey.the.attacker'])(
    '%s is not proven code',
    (s) => {
      expect(provenCode(s)).toBe(false);
    },
  );

  it.each(['this.userId', 'req.session.user', 'res.json', 'this.userId == '])(
    '%s, made of code words, is still code',
    (s) => {
      expect(provenCode(s)).toBe(true);
    },
  );
});

describe('2: octal and control escapes in a regex are not kept', () => {
  it.each([
    String.raw`\111\147\156\157\162\145 \141\154\154`,
    String.raw`\cI\cG\cN`,
    String.raw`a\1b`,
    String.raw`\08`,
  ])('%s is replaced', (p) => {
    expect(proseRegex(p)).toBe(true);
  });

  it('a regex with no numeric or control escape is still judged as before', () => {
    expect(proseRegex(String.raw`^\d+$`)).toBe(false);
  });
});

describe('3: the opened file must be the file that was checked', () => {
  it('a file swapped in after the path check is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aff-r4-'));
    made.push(root);
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app', 'a.js'), 'const a = 1;\n');
    writeFileSync(join(root, 'app', 'b.js'), 'const b = 2;\n');
    const text = await readWorkspaceFile(root, 'app/a.js', {
      afterCheck: () => {
        renameSync(join(root, 'app', 'b.js'), join(root, 'app', 'a.js'));
        return Promise.resolve();
      },
    });
    // The swap happened between the check and the open: the check saw a.js, the open got b.js.
    expect(text).toBeUndefined();
  });

  it('an unchanged file is read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aff-r4-'));
    made.push(root);
    writeFileSync(join(root, 'a.js'), 'const a = 1;\n');
    expect(await readWorkspaceFile(root, 'a.js')).toBe('const a = 1;\n');
  });
});
