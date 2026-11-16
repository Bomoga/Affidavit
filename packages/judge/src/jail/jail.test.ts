import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseResultArtifact } from '../artifact.js';
import { asWitness } from './containment.js';
import { RUNNER_BUILD_ARGS } from './harness.js';
import { readArtifact } from './jail.js';
import { capUtf8 } from './executor.js';

describe('capUtf8', () => {
  it('leaves output within the cap untouched', () => {
    expect(capUtf8('abc', 3)).toBe('abc');
    expect(capUtf8('', 0)).toBe('');
  });

  it('cuts output to the cap in UTF-8 bytes', () => {
    expect(capUtf8('abcdef', 4)).toBe('abcd');
    expect(capUtf8('abc', 0)).toBe('');
  });

  it('never splits a multi-byte character, so the result stays within the cap', () => {
    // 'é' is 2 bytes and '\u{1F600}' is 4 bytes in UTF-8.
    expect(capUtf8('ééé', 5)).toBe('éé');
    expect(capUtf8('a\u{1F600}', 4)).toBe('a');
    for (let cap = 0; cap < 12; cap++) {
      expect(Buffer.byteLength(capUtf8('aé\u{1F600}bé', cap), 'utf8')).toBeLessThanOrEqual(cap);
    }
  });
});

describe('readArtifact', () => {
  // Created in beforeAll: a module-level directory leaks when a `-t` filter skips every test here,
  // because Vitest then runs no hooks.
  let base = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'affidavit-jail-unit-'));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const at = (name: string) => join(base, name);

  it('reads a regular file', async () => {
    writeFileSync(at('ok.json'), '{"a":1}');
    expect(await readArtifact(at('ok.json'), 100)).toBe('{"a":1}');
  });

  it('returns null for a missing or empty file', async () => {
    writeFileSync(at('empty.json'), '');
    expect(await readArtifact(at('missing.json'), 100)).toBeNull();
    expect(await readArtifact(at('empty.json'), 100)).toBeNull();
  });

  it('never follows a symlink, so a jail cannot point the Judge at a host file', async () => {
    writeFileSync(at('secret'), 'host secret');
    symlinkSync(at('secret'), at('link.json'));
    expect(await readArtifact(at('link.json'), 100)).toBeNull();
  });

  it('refuses a FIFO without blocking and a directory', async () => {
    execFileSync('mkfifo', [at('fifo.json')]);
    mkdirSync(at('dir.json'));
    expect(await readArtifact(at('fifo.json'), 100)).toBeNull();
    expect(await readArtifact(at('dir.json'), 100)).toBeNull();
  });

  it('reads one byte past the limit, so the Judge still sees the artifact as oversized', async () => {
    writeFileSync(at('big.json'), 'x'.repeat(10_000));
    const raw = await readArtifact(at('big.json'), 100);
    expect(raw).toHaveLength(101);
    expect(parseResultArtifact(raw ?? '', 1, 100)).toMatchObject({ ok: false });
  });
});

describe('asWitness', () => {
  it('sets the probe arguments first and registers one passing witness at the end', () => {
    const src = asWitness('console.log(process.argv[2]);', { a: 1 });
    const lines = src.split('\n');
    expect(lines[0]).toBe('process.argv[2] = "{\\"a\\":1}";');
    expect(lines[1]).toBe('console.log(process.argv[2]);');
    expect(src).toContain("from '@affidavit/witness'");
    expect(src.trimEnd().endsWith('affidavitWitness(() => {});')).toBe(true);
  });
});

describe('runner image build', () => {
  it('builds reproducibly: no provenance, no SBOM, fixed build time, tagged', () => {
    expect(RUNNER_BUILD_ARGS).toEqual(
      expect.arrayContaining([
        '--provenance=false',
        '--sbom=false',
        'SOURCE_DATE_EPOCH=0',
        '--tag',
      ]),
    );
  });
});
