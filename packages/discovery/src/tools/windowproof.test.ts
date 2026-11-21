import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildInvocation } from './invocations.js';
import { loadToolManifest, repoRoot } from './manifest.js';
import { cleanupTmp, tmp } from './testkit.js';
import {
  inWindowProofClass,
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
    expect(s).toEqual({ maxLine: 50, maxWs: 6, gates: [], decodeIncomplete: false });
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
    };
    expect(statsProveCoverage(fine)).toBe(true);
    expect(statsProveCoverage({ ...fine, maxLine: PROOF_CAPS.line + 1 })).toBe(false);
    expect(statsProveCoverage({ ...fine, maxWs: PROOF_CAPS.ws + 1 })).toBe(false);
    expect(statsProveCoverage({ ...fine, gates: ['curl'] })).toBe(false);
    expect(statsProveCoverage({ ...fine, decodeIncomplete: true })).toBe(false);
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
