import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChunkRisk, PrivateKeyScan, findGitleaksUnscannable } from './unscannable.js';
import { cleanupTmp, tmp } from './testkit.js';

afterAll(cleanupTmp);

const body = (n: number) =>
  `${Buffer.from(`affidavit-fake-key-body-${n}-`.repeat(3)).toString('base64').slice(0, 64)}\n`;

/** A private key block with `inner` as an extra line in the middle (an empty string is a blank line). */
function key(
  inner: string | null,
  begin = '-----BEGIN RSA PRIVATE KEY-----',
  end = '-----END RSA PRIVATE KEY-----',
) {
  return `${begin}\n${body(0)}${body(1)}${inner === null ? '' : `${inner}\n`}${body(2)}${body(3)}${end}\n`;
}

const filler = (bytes: number): string => {
  let s = '';
  let n = 0;
  while (s.length < bytes) {
    s += `var v${n} = '${'x'.repeat(60)}';\n`;
    if (++n % 20 === 0) s += '\n';
  }
  return `${s.slice(0, bytes - 1)}\n`;
};

function scan(text: string, readSize = 64 * 1024): PrivateKeyScan {
  const sink = new PrivateKeyScan();
  const data = Buffer.from(text);
  for (let i = 0; i < data.length; i += readSize) sink.feed(data.subarray(i, i + readSize));
  return sink;
}

describe('PrivateKeyScan', () => {
  const big = (k: string, at = 105_000) => filler(at) + k + filler(300_000 - at - k.length);

  it('flags a blank-ish line inside a private key in a file over 100,000 bytes', () => {
    for (const inner of ['', ' ', '\t \t', '\r']) {
      expect(scan(big(key(inner))).risky, JSON.stringify(inner)).toBe(true);
    }
  });

  it('matches the begin and close markers like the gitleaks private-key rule', () => {
    expect(
      scan(big(key('', '-----begin rsa private key-----', '-----end rsa private key-----'))).risky,
    ).toBe(true);
    expect(
      scan(big(key('', '-----BEGIN_RSA_PRIVATE KEY-----', '-----END_RSA_PRIVATE KEY-----'))).risky,
    ).toBe(true);
    expect(
      scan(big(key('', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'))).risky,
    ).toBe(true);
    expect(
      scan(
        big(
          key('', '-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----END PGP PRIVATE KEY BLOCK-----'),
        ),
      ).risky,
    ).toBe(true);
  });

  it('does not flag a key without a blank line, a small file, or a blank line outside the key', () => {
    expect(scan(big(key(null))).risky).toBe(false);
    expect(scan(key('')).risky).toBe(false); // under 100,000 bytes: never cut
    expect(scan(filler(150_000)).risky).toBe(false);
    expect(scan(big(`\n\n${key(null)}\n\n`)).risky).toBe(false);
  });

  it('gives the same answer however the file is split into reads, even through a marker', () => {
    const text = big(key(' '));
    for (const size of [1, 7, 1_000, 7_001, 65_536]) {
      expect(scan(text.slice(0, 200_000), size).risky, String(size)).toBe(
        scan(text.slice(0, 200_000)).risky,
      );
    }
    const marker = filler(100_100) + key('');
    for (const size of [13, 100, 4_097]) expect(scan(marker, size).risky, String(size)).toBe(true);
  });

  it('a decoy begin marker above the real key does not close the block early', () => {
    const real = key('');
    const decoys = [
      `// -----BEGIN RSA PRIVATE KEY-----\n${real}`,
      `-----BEGIN PRIVATE KEY\n${real}`,
      `# see -----BEGIN PRIVATE KEY----- in the docs\n${'z'.repeat(1000)}\n${real}`,
      real.replace(
        '-----BEGIN RSA PRIVATE KEY-----\n',
        '-----BEGIN RSA PRIVATE KEY-----\nxKEY-----\n',
      ),
    ];
    for (const [i, k] of decoys.entries()) {
      expect(scan(big(k)).risky, `decoy ${i}`).toBe(true);
      expect(scan(big(k), 4_097).risky, `decoy ${i} in small reads`).toBe(true);
    }
  });

  it('flags header A with no END, a blank line, then header B with no close after it', () => {
    // gitleaks can match A up to B's own KEY----- (at least 64 characters after A's header), and a
    // cut at the blank line splits it. The 64 characters are measured from the first header.
    const a = `-----BEGIN PRIVATE KEY-----\n${body(0)}\n${body(1)}`;
    const b = `-----BEGIN PRIVATE KEY-----\n${body(2)}${body(3)}`;
    expect(scan(big(`${a}${b}`)).risky).toBe(true);
    expect(scan(big(`${a}${b}`), 4_097).risky).toBe(true);
  });

  it('gives the same answer for every read split of a doubled header', () => {
    const k = key('').replace(
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY PRIVATE KEY-----',
    );
    const text = filler(100_100) + k + filler(2_000);
    const start = text.indexOf('-----BEGIN');
    expect(scan(text, text.length).risky).toBe(true);
    for (let cut = start - 3; cut < start + 45; cut++) {
      const a = new PrivateKeyScan();
      const data = Buffer.from(text);
      a.feed(data.subarray(0, cut));
      a.feed(data.subarray(cut));
      expect(a.risky, `split at ${cut - start}`).toBe(true);
    }
  });

  it('counts the 64 character minimum from after the closing dashes of the header', () => {
    // `L` characters between the header and the close marker, with a blank line inside
    const withGap = (gap: number) =>
      `-----BEGIN PRIVATE KEY-----${'\n\n'}${'a'.repeat(gap - 2)}KEY-----\n`;
    for (const gap of [60, 62, 63]) expect(scan(big(withGap(gap))).risky, `gap ${gap}`).toBe(false);
    for (const gap of [64, 65, 66, 67, 68])
      expect(scan(big(withGap(gap))).risky, `gap ${gap}`).toBe(true);
    // and a header without its trailing dashes is not a header
    expect(scan(big(`-----BEGIN PRIVATE KEY\n\n${'a'.repeat(100)}KEY-----\n`)).risky).toBe(false);
  });

  it('uses constant memory: many repeated markers do not grow state', () => {
    const sink = new PrivateKeyScan();
    const chunk = Buffer.from(`${'-----BEGIN RSA PRIVATE KEY-----\n'.repeat(1000)}`);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 600; i++) sink.feed(chunk); // about 20 MB of markers
    const grown = process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(40 * 1024 * 1024);
  });
});

describe('ChunkRisk blank lines', () => {
  it('is not defeated by a whitespace-only line that straddles the 100,000-byte point', () => {
    // 100,000 bytes ending "y\n " (newline at 99,998, space at 99,999), then 300 more spaces and
    // a newline, then non-blank 80-byte lines. gitleaks cannot cut at that line, because its first
    // newline is before the point, so the stretch really runs on to the hard limit.
    const head = `${'x'.repeat(79)}\n`.repeat(1249) + `${'x'.repeat(77)}y\n `;
    expect(head.length).toBe(100_000);
    const text = `${head}${' '.repeat(300)}\n${`${'x'.repeat(79)}\n`.repeat(310)}`;
    const r = new ChunkRisk();
    r.feed(Buffer.from(text));
    expect(r.risky).toBe(true);
  });

  it('treats whitespace-only lines as blank', () => {
    const unit = `${'a'.repeat(79)}\n`.repeat(100) + '   \t\n';
    const r = new ChunkRisk();
    r.feed(Buffer.from(unit.repeat(17)));
    expect(r.risky).toBe(false);
    const none = new ChunkRisk();
    none.feed(Buffer.from(`${'a'.repeat(79)}\n`.repeat(2000)));
    expect(none.risky).toBe(true);
  });
});

describe('findGitleaksUnscannable options', () => {
  it('falls back to a working concurrency for 0, negatives, NaN and Infinity', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'x.pdf'), '%PDF-1.4 hidden');
    for (const concurrency of [0, -3, 0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      const found = await findGitleaksUnscannable(dir, { concurrency });
      expect(found, String(concurrency)).toEqual([{ path: 'a/x.pdf', kind: 'skipped-file-type' }]);
    }
  });

  // chmod does not restrict a directory on Windows, or for root
  const canRestrict = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.skipIf(!canRestrict)('reports a directory it cannot list as unreadable', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'locked'));
    writeFileSync(join(dir, 'locked', 'a.txt'), 'x');
    chmodSync(join(dir, 'locked'), 0o000);
    try {
      expect(await findGitleaksUnscannable(dir)).toEqual([{ path: 'locked', kind: 'unreadable' }]);
    } finally {
      chmodSync(join(dir, 'locked'), 0o700);
    }
  });

  it('flags a key with a blank line in a large file, and in a real media file', async () => {
    const dir = tmp();
    const k = key('');
    writeFileSync(join(dir, 'key.txt'), filler(105_000) + k + filler(40_000));
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(110_000),
      Buffer.from(k),
    ]);
    writeFileSync(join(dir, 'pic.png'), png);
    writeFileSync(
      join(dir, 'plain.png'),
      Buffer.concat([png.subarray(0, 8), Buffer.alloc(150_000)]),
    );
    const found = await findGitleaksUnscannable(dir);
    expect(found).toEqual([
      { path: 'key.txt', kind: 'multiline-split-risk' },
      { path: 'pic.png', kind: 'binary-media' },
      { path: 'pic.png', kind: 'multiline-split-risk' },
      { path: 'plain.png', kind: 'binary-media' },
    ]);
  });
});
