import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmp, tmp } from './testkit.js';
import {
  inWindowProofClass,
  measureText,
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
    expect(s).toEqual({ maxLine: 50, maxWs: 6, gates: [] });
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
    const fine = { maxLine: PROOF_CAPS.line, maxWs: PROOF_CAPS.ws, gates: [] };
    expect(statsProveCoverage(fine)).toBe(true);
    expect(statsProveCoverage({ ...fine, maxLine: PROOF_CAPS.line + 1 })).toBe(false);
    expect(statsProveCoverage({ ...fine, maxWs: PROOF_CAPS.ws + 1 })).toBe(false);
    expect(statsProveCoverage({ ...fine, gates: ['curl'] })).toBe(false);
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

describe('usesAnalyzedConfig', () => {
  it('true for the vendored config, false for a changed or missing one', async () => {
    expect(await usesAnalyzedConfig(undefined, undefined)).toBe(true);
    const dir = tmp();
    writeFileSync(join(dir, 'gitleaks.toml'), 'title = "other"\n');
    expect(await usesAnalyzedConfig(dir, undefined)).toBe(false);
    expect(await usesAnalyzedConfig(dir, 'missing.toml')).toBe(false);
  });
});
