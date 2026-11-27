import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildInvocation } from './invocations.js';
import { loadToolManifest, repoRoot } from './manifest.js';
import { cleanupTmp, tmp } from './testkit.js';
import {
  inWindowProofClass,
  MAX_DECODED_WS_BURST_BYTES,
  MAX_DECODED_WS_SEGMENT,
  measureText,
  mountedConfigFile,
  PROOF_CAPS,
  statsProveCoverage,
  usesAnalyzedConfig,
} from './windowproof.js';

afterAll(cleanupTmp);

const file = (body: string | Buffer): string => {
  const p = join(tmp(), 'f');
  writeFileSync(p, body);
  return p;
};

describe('measureText', () => {
  it('measures the longest line and whitespace run in bytes', async () => {
    const s = await measureText(file(`ab\n${'x'.repeat(50)}\n  \t \nyy`));
    // the whitespace run is newline, space, space, tab, space, newline
    expect(s).toEqual({
      maxLine: 50,
      maxWs: 6,
      gates: [],
      decodeIncomplete: false,
      decodedWsSuspect: false,
      decodedWsBytes: 0,
      percentWsBytes: 0,
    });
  });

  it('a newline run counts as whitespace', async () => {
    expect((await measureText(file(`a${'\n'.repeat(40)}b`))).maxWs).toBe(40);
  });

  it('finds a gate word split across two reads (64 KiB)', async () => {
    const at = 64 * 1024 - 3;
    const body = Buffer.alloc(at + 10, 0x61);
    body.fill(0x0a, 0, 1);
    Buffer.from('PrIvAtE').copy(body, at);
    expect((await measureText(file(body))).gates).toEqual(['private']);
    const curl = Buffer.alloc(at + 10, 0x61);
    Buffer.from('curl').copy(curl, 64 * 1024 - 2);
    expect((await measureText(file(curl))).gates).toEqual(['curl']);
  });

  it('case: private is found in any case, curl and ZXlK only as written', async () => {
    expect((await measureText(file('"PRIVATE"'))).gates).toEqual(['private']);
    expect((await measureText(file('CURL zxlk'))).gates).toEqual([]);
    expect((await measureText(file('ZXlKabc'))).gates).toEqual(['ZXlK']);
  });
});

describe('statsProveCoverage', () => {
  it('holds only under both caps and without a gate word', () => {
    const fine = {
      maxLine: PROOF_CAPS.line,
      maxWs: PROOF_CAPS.ws,
      gates: [],
      decodeIncomplete: false,
      decodedWsSuspect: false,
      decodedWsBytes: 0,
      percentWsBytes: 0,
    };
    expect(statsProveCoverage(fine)).toBe(true);
    expect(statsProveCoverage({ ...fine, maxLine: PROOF_CAPS.line + 1 })).toBe(false);
    expect(statsProveCoverage({ ...fine, maxWs: PROOF_CAPS.ws + 1 })).toBe(false);
    expect(statsProveCoverage({ ...fine, gates: ['curl'] })).toBe(false);
    expect(statsProveCoverage({ ...fine, decodeIncomplete: true })).toBe(false);
    expect(statsProveCoverage({ ...fine, decodedWsSuspect: true })).toBe(false);
  });
});

describe('whitespace runs in decoded text (round 4, second pass)', () => {
  // Every raw line is at most 4096 bytes with no raw whitespace run, but gitleaks reads the
  // decoded text, where each line is a run of spaces far over PROOF_CAPS.ws.
  const lines = {
    base64: `${'ICAg'.repeat(1000)}\n`, // 4000 chars, 3000 spaces
    hex: `${'20'.repeat(2000)}\n`, // 4000 chars, 2000 spaces
    percent: `${'%20'.repeat(1300)}\n`, // 3900 chars, 1300 spaces
  };
  for (const [kind, line] of Object.entries(lines)) {
    it(`${kind}: a line that decodes to spaces over the cap gives no proof`, async () => {
      const s = await measureText(file(line.repeat(30)));
      expect(s.maxLine).toBeLessThanOrEqual(PROOF_CAPS.line);
      expect(s.gates).toEqual([]);
      expect(s.decodeIncomplete).toBe(false);
      expect(s.maxWs).toBeGreaterThan(PROOF_CAPS.ws);
      expect(statsProveCoverage(s)).toBe(false);
    });
  }

  it('raw whitespace next to a decoded run counts with it', async () => {
    // 200 raw spaces + 200 decoded spaces (ICAg x 67 is 201 spaces) is over 256 in one view
    const s = await measureText(file(`${' '.repeat(200)}${'ICAg'.repeat(67)}\n`));
    expect(s.maxWs).toBeGreaterThan(PROOF_CAPS.ws);
    expect(statsProveCoverage(s)).toBe(false);
  });

  it('ordinary lockfile text, and a few short decoded whitespace runs, still prove', async () => {
    const hash = createHash('sha512').update('left-pad').digest('base64');
    const real = `    "integrity": "sha512-${hash}",\n`.repeat(100);
    const ws6 = `    "x": "${'ICAg'.repeat(2)}"\n`; // 6 decoded spaces, a burst of 6
    const few = await measureText(file(real + ws6.repeat(10))); // 60 burst bytes, budget 64
    expect(few.decodedWsBytes).toBeLessThanOrEqual(MAX_DECODED_WS_BURST_BYTES);
    expect(statsProveCoverage(few)).toBe(true);
    const many = await measureText(file(real + ws6.repeat(11))); // 66 burst bytes
    expect(many.decodedWsBytes).toBeGreaterThan(MAX_DECODED_WS_BURST_BYTES);
    expect(many.decodedWsSuspect).toBe(true);
    expect(statsProveCoverage(many)).toBe(false);
  });

  it('more than 8 whitespace escapes in a file is refused, 8 is not', async () => {
    const plain = '    "a": "b",\n'.repeat(50);
    const eight = await measureText(file(`${plain}${'x%20y\n'.repeat(8)}`));
    expect(eight.percentWsBytes).toBe(8);
    expect(statsProveCoverage(eight)).toBe(true);
    const nine = await measureText(file(`${plain}${'x%20y\n'.repeat(9)}`));
    expect(nine.percentWsBytes).toBe(9);
    expect(statsProveCoverage(nine)).toBe(false);
  });
});

describe('decoded whitespace across segments, lines and padding (round 4, third pass)', () => {
  // Each file has raw lines of at most 4096 bytes, raw whitespace runs of at most 256 and no
  // gate word, but gitleaks reads whitespace-only text after decoding.
  const refused = async (body: string): Promise<void> => {
    const s = await measureText(file(body));
    expect(s.maxLine).toBeLessThanOrEqual(PROOF_CAPS.line);
    expect(s.gates).toEqual([]);
    expect(s.decodeIncomplete).toBe(false);
    expect(statsProveCoverage(s)).toBe(false);
  };
  const chunk64 = 'ICAgICAgICAgICAg'; // 16 chars, decodes to 12 spaces

  it('A, base64: 16 character chunks split by one raw space, each 12 decoded spaces', async () => {
    await refused(`${`${chunk64} `.repeat(240)}\n`);
  });

  it('A, hex: 32 character chunks split by one raw space, each 16 decoded spaces', async () => {
    await refused(`${`${'20'.repeat(16)} `.repeat(110)}\n`);
  });

  it('A, percent: three escapes split by one raw space', async () => {
    await refused(`${'%20%20%20 '.repeat(400)}\n`);
  });

  it('B: many lines, each a base64 string that decodes to about 200 spaces', async () => {
    await refused(`${`${'ICAg'.repeat(67)}\n`.repeat(300)}`);
  });

  it('C: decoded spaces, then = padding, then raw spaces', async () => {
    await refused(`${'ICAg'.repeat(33)}ICA=${' '.repeat(200)}\n`);
  });

  it('D: base64 of base64 of spaces, 100 decoded spaces', async () => {
    const inner = 'ICAg'.repeat(34); // 102 spaces
    await refused(`${Buffer.from(inner, 'latin1').toString('base64')}\n`);
  });

  it('pins MAX_DECODED_WS_SEGMENT: a segment of 9 whitespace bytes refuses, 8 proves', async () => {
    const nine = 'ICAgICAgICAg'; // 12 characters
    const eight = 'ICAgICAgICA='; // 11 characters and padding
    expect(Buffer.from(nine, 'base64').toString('latin1')).toBe(' '.repeat(9));
    expect(Buffer.from(eight, 'base64').toString('latin1')).toBe(' '.repeat(8));
    expect(MAX_DECODED_WS_SEGMENT).toBe(8);
    expect(statsProveCoverage(await measureText(file(`x: "${nine}"\n`)))).toBe(false);
    expect(statsProveCoverage(await measureText(file(`x: "${eight}"\n`)))).toBe(true);
  });
});

describe('percent escapes that decode to whitespace, file level (round 4, fourth pass)', () => {
  // gitleaks decodes the whole fragment and a newline is whitespace, so many lines that each
  // decode to a little whitespace read as one long run.
  const refused = async (body: string): Promise<void> => {
    const s = await measureText(file(body));
    expect(s.maxLine).toBeLessThanOrEqual(PROOF_CAPS.line);
    expect(s.gates).toEqual([]);
    expect(s.decodeIncomplete).toBe(false);
    expect(statsProveCoverage(s)).toBe(false);
  };
  it('a lone %20 on each of 9000 lines', async () => {
    await refused('%20\n'.repeat(9000));
  });
  it('eight %20 in a row on each of 1000 lines', async () => {
    await refused('%20%20%20%20%20%20%20%20\n'.repeat(1000));
  });
  for (const esc of ['%0a', '%0A', '%09', '%0d', '%0b', '%0c']) {
    it(`a lone ${esc} on each of 3000 lines`, async () => {
      await refused(`${esc}\n`.repeat(3000));
    });
  }
  it('lone escapes among real integrity lines (mixed)', async () => {
    const hash = createHash('sha512').update('left-pad').digest('base64');
    const real = `    "integrity": "sha512-${hash}",\n`;
    await refused(`${real}%20\n`.repeat(2000));
  });
  it('whitespace escapes with a raw space between them', async () => {
    await refused('%20 %20 %20 %20\n'.repeat(1000));
  });
  it('ordinary percent escapes in lockfile text still prove', async () => {
    const body = `    "resolved": "https://registry.npmjs.org/@types%2fnode/-/node-1.tgz",\n    "a": "x%40y%3Dz",\n`;
    const s = await measureText(file(body.repeat(300)));
    expect(statsProveCoverage(s)).toBe(true);
  });
});

describe('inWindowProofClass', () => {
  it('lockfiles by exact name and SVG files only', () => {
    for (const n of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'])
      expect(inWindowProofClass(n), n).toBe(true);
    expect(inWindowProofClass('icons.svg')).toBe(true);
    expect(inWindowProofClass('ICONS.SVG')).toBe(true);
    for (const n of ['Package-Lock.json', 'package-lock.json.bak', 'big.js', 'data.json', 'a.svgz'])
      expect(inWindowProofClass(n), n).toBe(false);
  });
});

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');

describe('measureText, gate words in decoded text (gitleaks decodes base64, hex, percent)', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----';

  it('finds a gate word inside a base64 segment', async () => {
    expect((await measureText(file(`${b64(pem)}\n<svg/>\n`))).gates).toEqual(['private']);
    expect((await measureText(file(`a="${b64(`x curl -u a:b`)}"\n`))).gates).toEqual(['curl']);
  });

  it('whatever the alignment of the segment in its run, and in the URL-safe alphabet', async () => {
    for (const lead of ['', 'Q', 'QQ', 'QQQ', 'QQQQQ'])
      expect((await measureText(file(`${lead}${b64(pem)}\n`))).gates, lead).toEqual(['private']);
    const url = Buffer.from(`\xfb\xff ${pem}`, 'latin1').toString('base64url');
    expect(url).toMatch(/[-_]/);
    expect((await measureText(file(`${url}\n`))).gates).toEqual(['private']);
  });

  it('finds a gate word inside a hex segment, at either nibble alignment', async () => {
    const hex = Buffer.from('curl -H x').toString('hex');
    expect((await measureText(file(`v=${hex}\n`))).gates).toEqual(['curl']);
    expect((await measureText(file(`v=a${hex}\n`))).gates).toEqual(['curl']);
  });

  it('finds a gate word in percent-encoded text, fully or partly encoded', async () => {
    expect((await measureText(file('u=%63%75%72%6c%20-u\n'))).gates).toEqual(['curl']);
    expect((await measureText(file('u=cu%72l\n'))).gates).toEqual(['curl']);
    expect((await measureText(file('u=%50RIVATE\n'))).gates).toEqual(['private']);
  });

  it('finds a gate word decoded twice (base64 of base64, hex of base64)', async () => {
    expect((await measureText(file(`${b64(b64(pem))}\n`))).gates).toEqual(['private']);
    const hexOfB64 = Buffer.from(b64('ZXlKhbGciOi')).toString('hex');
    expect((await measureText(file(`${hexOfB64}\n`))).gates).toEqual(['ZXlK']);
  });

  it('finds a gate word half in raw text and half in a decoded segment', async () => {
    expect((await measureText(file(`pri${b64('vate key')}\n`))).gates).toEqual(['private']);
  });

  it('decoded text without a gate word adds none', async () => {
    const s = await measureText(
      file(`"integrity": "sha512-${b64('nothing to see here, only a hash')}"\n`),
    );
    expect(s.gates).toEqual([]);
    expect(s.decodeIncomplete).toBe(false);
  });

  it('a line too long to decode, or a decode budget that runs out, gives no proof', async () => {
    const long = await measureText(file(`${'Q'.repeat(PROOF_CAPS.line + 1)}\n`));
    expect(long.decodeIncomplete).toBe(true);
    expect(statsProveCoverage(long)).toBe(false);
    const tight = await measureText(file(`${b64('x'.repeat(200))}\n`), { decodeBudgetBytes: 10 });
    expect(tight.decodeIncomplete).toBe(true);
    expect(statsProveCoverage(tight)).toBe(false);
  });
});

describe('measureText, segments gitleaks decodes together on one line', () => {
  // Delta review of 57709f5: gitleaks replaces every segment of a line in one pass, so two
  // padded segments side by side decode to one text that no single segment holds.
  const b64Lines = `${b64('a'.repeat(60))}\n`.repeat(20);

  it('two padded base64 segments that join into a private key header', async () => {
    const line =
      '  integrity: LS0tLS1CRUdJTiBSU0EgUFJJVg==QVRFIEtFWS0tLS0tTUlJRXZRSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0M=';
    const s = await measureText(file(`${line}\n${b64Lines}`));
    expect(s.gates).toEqual(['private']);
    expect(statsProveCoverage(s)).toBe(false);
  });

  it('ZXlK split across two padded segments, in a file with CRLF line endings', async () => {
    const line = `  x: ${b64('aaaZX')}${b64('lKaaaa')}`;
    expect(line).toContain('=');
    const s = await measureText(file(`${line}\r\n${b64Lines.replace(/\n/g, '\r\n')}`));
    expect(s.gates).toEqual(['ZXlK']);
    expect(statsProveCoverage(s)).toBe(false);
  });

  it('a lockfile integrity line (one long segment, nothing adjacent) is still provable', async () => {
    const hash = createHash('sha512').update('left-pad').digest('base64');
    const body = `    "lodash": {\n      "version": "4.17.21",\n      "integrity": "sha512-${hash}",\n      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"\n    },\n`;
    const s = await measureText(file(body.repeat(200)));
    expect(s).toMatchObject({ gates: [], decodeIncomplete: false });
    expect(statsProveCoverage(s)).toBe(true);
  });

  it('more than 8 segments joined on a line gives no proof', async () => {
    const s = await measureText(file(`v=${'QUFBQUFB='.repeat(9)}\n`));
    expect(s.decodeIncomplete).toBe(true);
    expect(statsProveCoverage(s)).toBe(false);
  });

  it('1 MB of small adjacent segments fails closed well under a second', async () => {
    const line = 'QUFBQUFB='.repeat(450);
    const body = `${line}\n`.repeat(Math.ceil((1024 * 1024) / (line.length + 1)));
    const t0 = performance.now();
    const s = await measureText(file(body));
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(s.decodeIncomplete).toBe(true);
  });

  // Second delta review: gitleaks v8.30.1 finds private-key in each of these.
  const pct = (s: string): string =>
    [...Buffer.from(s, 'latin1')].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
  const hex = (s: string): string => Buffer.from(s, 'latin1').toString('hex');

  it('base64 followed directly by percent-encoded text', async () => {
    const head = b64('-----BEGIN RSA PRIV');
    expect(head.endsWith('==')).toBe(true);
    const s = await measureText(file(`${head}${pct('ATE KEY-----')}\n${b64Lines}`));
    expect(s.gates).toEqual(['private']);
    expect(statsProveCoverage(s)).toBe(false);
  });

  it('base64 followed directly by hex', async () => {
    const line = `${b64('-----BEGIN RSA PRIV')}${hex('ATE KEY-----MIIEvQIBADANBgkqhkiG9w0BAQEF')}`;
    const s = await measureText(file(`${line}\n${b64Lines}`));
    expect(s.gates).toEqual(['private']);
    expect(statsProveCoverage(s)).toBe(false);
  });

  it('base64, hex and percent side by side', async () => {
    const head = b64('-----BEGIN RSA PR');
    expect(head.endsWith('=')).toBe(true);
    const line = `x=${head}${hex('IVA')}${pct('TE KEY-----')}`;
    const s = await measureText(file(`${line}\n${b64Lines}`));
    expect(s.gates).toEqual(['private']);
  });

  it('a short raw run between decoded segments is kept raw in the join', async () => {
    const line = `${b64('-----BEGIN RSA PRI')}=VATE`;
    const s = await measureText(file(`${line}\n`));
    expect(s.gates).toEqual(['private']);
  });

  it('a file that runs out of time gives no proof', async () => {
    const s = await measureText(file(`${b64('a'.repeat(60))}\n`), { maxMillis: 0 });
    expect(s.decodeIncomplete).toBe(true);
    expect(statsProveCoverage(s)).toBe(false);
  });

  it('eight joined nested-base64 segments per line stay fast', async () => {
    // 50 different lines, each 8 joined segments of base64 nested four deep, near the line cap.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      const segs: string[] = [];
      for (let k = 0; k < 8; k++) {
        let inner = `${i}-${k}-`.repeat(60).slice(0, 300);
        for (let d = 0; d < 4; d++) inner = b64(inner);
        segs.push(`${inner.slice(0, 480).replace(/=+$/, '')}=`);
      }
      lines.push(segs.join('').slice(0, 4000));
    }
    const t0 = performance.now();
    const s = await measureText(file(`${lines.join('\n')}\n`));
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(s).toMatchObject({ gates: [], decodeIncomplete: false });
  });

  it('1 MB of small separate segments stays well under a second', async () => {
    const line = 'QUFBQUFB '.repeat(450);
    const body = `${line}\n`.repeat(Math.ceil((1024 * 1024) / (line.length + 1)));
    const t0 = performance.now();
    const s = await measureText(file(body));
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(s.gates).toEqual([]);
  });
});

describe('the config the proof hashes is the file the gitleaks container mounts', () => {
  const manifest = loadToolManifest();
  const inv = (o: { configDir?: string; gitleaksConfigFile?: string }) =>
    buildInvocation(manifest, 'gitleaks', {
      sourceDir: tmp(),
      outputDir: tmp(),
      scratchDir: tmp(),
      ...o,
    });
  const vendored = readFileSync(join(repoRoot(), 'docker', 'tools', 'config', 'gitleaks.toml'));

  it('resolves --config through the mounts to the host file', () => {
    const dir = tmp();
    expect(mountedConfigFile(inv({ configDir: dir }))).toBe(join(dir, 'gitleaks.toml'));
    expect(mountedConfigFile(inv({ configDir: dir, gitleaksConfigFile: 'alt.toml' }))).toBe(
      join(dir, 'alt.toml'),
    );
    expect(mountedConfigFile(inv({}))).toBe(
      join(repoRoot(), 'docker', 'tools', 'config', 'gitleaks.toml'),
    );
  });

  it('true for the vendored config, false for a changed or missing one', async () => {
    expect(await usesAnalyzedConfig(mountedConfigFile(inv({})))).toBe(true);
    const dir = tmp();
    writeFileSync(join(dir, 'gitleaks.toml'), 'title = "other"\n');
    expect(await usesAnalyzedConfig(mountedConfigFile(inv({ configDir: dir })))).toBe(false);
    const missing = inv({ configDir: dir, gitleaksConfigFile: 'missing.toml' });
    expect(await usesAnalyzedConfig(mountedConfigFile(missing))).toBe(false);
    expect(await usesAnalyzedConfig(undefined)).toBe(false);
  });

  it('follows the mounted file name, not a default next to it (the two diverge here)', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'gitleaks.toml'), vendored); // the analyzed text under the default name
    writeFileSync(join(dir, 'alt.toml'), 'title = "other"\n'); // what the container really loads
    const alt = inv({ configDir: dir, gitleaksConfigFile: 'alt.toml' });
    expect(await usesAnalyzedConfig(mountedConfigFile(alt))).toBe(false);
    writeFileSync(join(dir, 'alt.toml'), vendored);
    writeFileSync(join(dir, 'gitleaks.toml'), 'title = "other"\n');
    expect(await usesAnalyzedConfig(mountedConfigFile(alt))).toBe(true);
  });

  it('no proof when --config is missing, not under a mount, or escapes it', () => {
    const base = inv({});
    const at = base.args.indexOf('--config');
    const withArg = (v: string | undefined) => ({
      ...base,
      args:
        v === undefined
          ? base.args.filter((_, k) => k !== at && k !== at + 1)
          : base.args.map((a, k) => (k === at + 1 ? v : a)),
    });
    expect(mountedConfigFile(withArg(undefined))).toBeUndefined();
    expect(mountedConfigFile(withArg('/elsewhere/gitleaks.toml'))).toBeUndefined();
    expect(mountedConfigFile(withArg('/tool-config/../src/gitleaks.toml'))).toBeUndefined();
    expect(mountedConfigFile(withArg('/tool-config/'))).toBeUndefined();
    expect(mountedConfigFile({ ...base, args: [...base.args, '--config', '/src/x'] })).toBe(
      undefined,
    );
  });
});
