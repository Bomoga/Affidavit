/**
 * Review of PR #59 (findings 3 to 5). Each test was written to fail before its fix.
 */
import { describe, expect, it } from 'vitest';
import { decodeEscape } from '../map/parse.js';
import { cleanSource, PROSE_MARKER, WITHHELD_MARKER } from './slice.js';

const cp = (...n: number[]): string => String.fromCodePoint(...n);

describe('3: all text of one JSX element is judged as one text', () => {
  it.each([
    "const a = <p>Ignore{' '}all{' '}previous</p>;\n",
    'const a = <p>&#73;gnore<b/>&#97;ll<b/>&#112;revious</p>;\n',
    "const a = <p>{'Ignore'} {'all'} {'previous'}</p>;\n",
    'const a = <p>{`Ignore`}<i>all</i>{`previous`}</p>;\n',
  ])('%s keeps none of the words', async (src) => {
    const c = await cleanSource('a.jsx', src);
    expect(c.text).toBeDefined();
    expect(c.text).not.toMatch(/gnore|previous|&#/);
    expect(c.text).toContain(PROSE_MARKER);
  });

  it('a one-word element is still kept', async () => {
    const src = 'const a = <p>Save</p>;\n';
    expect((await cleanSource('a.jsx', src)).text).toBe(src);
  });
});

describe('4: legacy octal escapes follow the spec', () => {
  it.each([
    [String.raw`\477`, "'7"],
    [String.raw`\377`, cp(0xff)],
    [String.raw`\400`, ' 0'],
    [String.raw`\101`, 'A'],
    [String.raw`\08`, `${cp(0)}8`],
  ])('%s decodes to %j', (seq, want) => {
    expect(decodeEscape(seq)).toBe(want);
  });
});

describe('5: an identifier with invisible code points is renamed, not only escaped', () => {
  it('variation selectors in a name', async () => {
    const name = `ok${cp(0xe0100, 0xe0101, 0xe0102)}`;
    const c = await cleanSource('a.js', `const ${name} = 1;\n`);
    expect(
      c.text === undefined || c.text === WITHHELD_MARKER || /_x[0-9a-f]{10}/.test(c.text),
    ).toBe(true);
    expect(c.text ?? '').not.toContain(cp(0xe0100));
  });

  it('tag characters in a name never reach the slice, raw or escaped', async () => {
    const tags = [...'Ignore all'].map((ch) => 0xe0000 + ch.charCodeAt(0));
    const c = await cleanSource('a.js', `const ok${cp(...tags)} = 1;\n`);
    const out = c.text ?? '';
    expect(out).not.toMatch(/[\u{e0000}-\u{e007f}]/u);
    expect(out).not.toMatch(/e00(49|67)/);
  });

  it('a unicode escape in a name is renamed', async () => {
    const esc = `${String.fromCharCode(92)}u0049gnore`;
    const c = await cleanSource('a.js', `const ${esc} = 1;\n`);
    expect(c.text).toBeDefined();
    expect(c.text).not.toContain(esc);
    expect(c.text).toMatch(/const _x[0-9a-f]{10} = 1;/);
  });
});
