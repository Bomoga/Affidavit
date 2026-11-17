import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { GitleaksFinding } from './findings.js';
import { buildRedactionMap } from './map.js';
import { extractLines, extractRegion, redactBuffer, SecretRedactor } from './redactor.js';
import { cleanup, fakeKey, tmpDir } from './testkit.js';
import { buildWorkspace, findLeaks, isEnvName } from './workspace.js';
import { mkdirSync, readFileSync } from 'node:fs';

afterAll(cleanup);

const K = 'AFFIDAVIT_FAKE_KEY_0123456789ABCDEF';

describe('extractRegion (columns probed on the pinned gitleaks)', () => {
  const at = (text: string, r: [number, number, number, number]) =>
    extractRegion(Buffer.from(text), {
      startLine: r[0],
      startColumn: r[1],
      endLine: r[2],
      endColumn: r[3],
    })?.toString();

  it('first line is 1-based, later lines are one higher', () => {
    const t = `const a = "${K}";\nconst b = "${K}";\n  x="${K}" y="${K}"\n`;
    expect(at(t, [1, 12, 1, 46])).toBe(K);
    expect(at(t, [2, 13, 2, 47])).toBe(K);
    expect(at(t, [3, 7, 3, 41])).toBe(K);
    expect(at(t, [3, 47, 3, 81])).toBe(K);
  });

  it('CRLF and multibyte text (byte columns)', () => {
    expect(at(`const a = "${K}";\r\nconst b = "${K}";\r\n`, [2, 13, 2, 47])).toBe(K);
    expect(at(`é€é "${K}"\nüñ "${K}"\n`, [1, 10, 1, 44])).toBe(K);
    expect(at(`é€é "${K}"\nüñ "${K}"\n`, [2, 8, 2, 42])).toBe(K);
  });

  it('a multi-line match keeps the line breaks between', () => {
    const pem = '-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----\nafter\n';
    expect(at(pem, [1, 1, 4, 18])).toBe('-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----');
  });

  it('returns undefined for regions that do not fit', () => {
    expect(at('abc\n', [5, 1, 5, 3])).toBeUndefined();
    expect(at('abc\n', [1, 1, 1, 99])).toBeUndefined();
    expect(at('abc\ndef\n', [1, 3, 2, 1])).toBeUndefined();
    expect(at('abc', [1, 0, 1, 2])).toBeUndefined();
  });

  it('extractLines drops the line break and CR', () => {
    expect(extractLines(Buffer.from('a\r\nbb\r\nc'), 1, 2)?.toString()).toBe('a\r\nbb');
    expect(extractLines(Buffer.from('a\r\nbb\r\nc'), 2, 2)?.toString()).toBe('bb');
    expect(extractLines(Buffer.from('a\n\nb'), 2, 2)).toBeUndefined();
  });
});

describe('redactBuffer', () => {
  const entry = (value: string, over = {}) => ({
    id: 1,
    ruleId: 'r',
    value: Buffer.from(value),
    exact: true,
    scope: 'global' as const,
    placeholder: '[REDACTED:r:1]',
    locations: [],
    ...over,
  });

  it('replaces every occurrence, reports lines, keeps the newline count', () => {
    const v = 'line1\nline2-SECRET-VALUE';
    const out = redactBuffer('f', Buffer.from(`a\n${v} and ${v}\nz\n`), [entry(v)]);
    expect(out.buf.toString()).toBe('a\n[REDACTED:r:1]\n and [REDACTED:r:1]\n\nz\n');
    expect(out.buf.toString().split('\n').length).toBe(`a\n${v} and ${v}\nz\n`.split('\n').length);
    expect(out.hits.map((h) => [h.startLine, h.endLine])).toEqual([
      [2, 3],
      [3, 4],
    ]);
  });

  it('a short value is replaced only on the lines gitleaks reported', () => {
    const e = entry('abc123', {
      scope: 'located',
      locations: [{ file: 'f', startLine: 2, endLine: 2 }],
    });
    const out = redactBuffer('f', Buffer.from('abc123\nx abc123 y\nabc123\n'), [e]);
    expect(out.buf.toString()).toBe('abc123\nx [REDACTED:r:1] y\nabc123\n');
    expect(redactBuffer('other', Buffer.from('abc123'), [e]).buf.toString()).toBe('abc123');
  });

  it('the longer of two overlapping values wins', () => {
    const out = redactBuffer('f', Buffer.from('xxLONGSECRETxx'), [
      entry('LONGSECRET', { placeholder: '[A]' }),
      entry('SECRET', { placeholder: '[B]' }),
    ]);
    expect(out.buf.toString()).toBe('xx[A]xx');
  });
});

describe('SecretRedactor', () => {
  it('values cannot be copied out by spread, entries, structuredClone or JSON', () => {
    const r = new SecretRedactor([
      {
        id: 1,
        ruleId: 'r',
        value: Buffer.from('SUPER-SECRET-VALUE'),
        exact: true,
        scope: 'global',
        placeholder: '[P]',
        locations: [],
      },
    ]);
    const copies = [
      JSON.stringify({ ...r }),
      JSON.stringify(Object.entries(r)),
      JSON.stringify(Object.getOwnPropertyNames(r)),
      JSON.stringify(structuredClone(r)),
      JSON.stringify(Object.assign({}, r)),
    ];
    for (const c of copies) expect(c).not.toContain('SUPER');
    expect(Object.keys(r)).toEqual([]);
  });

  it('never prints or serialises values', () => {
    const r = new SecretRedactor([
      {
        id: 1,
        ruleId: 'r',
        value: Buffer.from('SUPER-SECRET-VALUE'),
        exact: true,
        scope: 'global',
        placeholder: '[REDACTED:r:1]',
        locations: [],
      },
    ]);
    for (const s of [JSON.stringify(r), inspect(r), String(inspect({ r }, { depth: 5 }))]) {
      expect(s).not.toContain('SUPER-SECRET');
    }
    expect(r.apply('a SUPER-SECRET-VALUE b')).toBe('a [REDACTED:r:1] b');
  });
});

describe('buildRedactionMap', () => {
  const finding = (
    file: string,
    r: GitleaksFinding['region'],
    origin: GitleaksFinding['origin'],
  ) => ({ ruleId: 'rule', file, region: r, origin });

  it('exact value from the region; whole line when the region is untrusted', async () => {
    const raw = tmpDir();
    const key = fakeKey();
    writeFileSync(join(raw, 'a.js'), `x = "${key}";\n`);
    // > 100 KB with the key late: a snapshot-pass column cannot be trusted
    const big = `${'// pad\n'.repeat(20_000)}y = "${key}";\n`;
    writeFileSync(join(raw, 'big.js'), big);
    const m = await buildRedactionMap(
      raw,
      [
        finding(
          'a.js',
          { startLine: 1, startColumn: 6, endLine: 1, endColumn: 5 + key.length },
          'snapshot',
        ),
        finding(
          'big.js',
          { startLine: 20_001, startColumn: 99, endLine: 20_001, endColumn: 140 },
          'snapshot',
        ),
      ],
      1 << 26,
    );
    const values = m.redactor.all().map((e) => [e.value.toString(), e.exact]);
    expect(values).toEqual([
      [key, true],
      [`y = "${key}";`, false],
    ]);
    // both are replaced, so the key is gone from the big file too
    const out = redactBuffer('big.js', Buffer.from(big), m.redactor.all());
    expect(out.buf.includes(key)).toBe(false);
  });

  it('a finding in a missing file fails closed', async () => {
    await expect(
      buildRedactionMap(
        tmpDir(),
        [
          finding(
            'gone.js',
            { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
            'snapshot',
          ),
        ],
        1 << 20,
      ),
    ).rejects.toMatchObject({ name: 'RedactionIncompleteError' });
  });

  it('a finding inside an archive keeps the archive out and adds no garbage value', async () => {
    const raw = tmpDir();
    writeFileSync(join(raw, 'a.txt.gz'), Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
    const m = await buildRedactionMap(
      raw,
      [finding('a.txt.gz', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 }, 'snapshot')],
      1 << 20,
    );
    expect(m.redactor.size).toBe(0);
    expect(m.excluded.get('a.txt.gz')).toBe('secret-in-non-text-file');
  });
});

describe('workspace', () => {
  it('isEnvName', () => {
    for (const n of [
      '.env',
      '.ENV',
      '.env.local',
      '.Env.Production',
      '.envrc',
      '.env-local',
      '.env_production',
      '.envs',
      'production.env',
      'my.ENV',
      'prod.env.local',
    ])
      expect(isEnvName(n), n).toBe(true);
    for (const n of ['env', 'env.js', '.environment', '.envelope', 'environment.js', 'dotenv.js']) {
      expect(isEnvName(n), n).toBe(false);
    }
  });

  it('findLeaks catches a value that survived', async () => {
    const ws = tmpDir();
    mkdirSync(join(ws, 'd'));
    writeFileSync(join(ws, 'd', 'f.txt'), 'has LONGENOUGH-SECRET here');
    const r = new SecretRedactor([
      {
        id: 1,
        ruleId: 'r',
        value: Buffer.from('LONGENOUGH-SECRET'),
        exact: true,
        scope: 'global',
        placeholder: '[P]',
        locations: [],
      },
    ]);
    expect(await findLeaks(ws, r)).toEqual(['d/f.txt']);
  });

  it('skips non-regular files and the checkout .git', async () => {
    const raw = tmpDir();
    mkdirSync(join(raw, '.git'));
    writeFileSync(join(raw, '.git', 'config'), 'x');
    writeFileSync(join(raw, 'ok.js'), 'x');
    const ws = join(tmpDir(), 'ws');
    const b = await buildWorkspace(raw, ws, new SecretRedactor([]), new Map(), 1 << 20);
    expect(b.excluded).toEqual([]);
    expect(readFileSync(join(ws, 'ok.js'), 'utf8')).toBe('x');
  });
});
