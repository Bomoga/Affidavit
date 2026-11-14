import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseResultArtifact } from '../artifact.js';
import { asWitness } from './containment.js';
import { HARNESS_SHA256, HARNESS_SOURCE, JAIL_PATHS, type HarnessInput } from './harness.js';
import { readArtifact } from './jail.js';

const base = mkdtempSync(join(tmpdir(), 'affidavit-jail-unit-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('readArtifact', () => {
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

/**
 * Runs the harness outside the jail on trusted test witnesses, with its /witness and /out paths
 * pointed at a temp directory, to pin its semantics. The jailed behaviour is covered by
 * jail.integration.test.ts.
 */
function runHarness(witness: string, input: HarnessInput): { code: number; artifact: string } {
  const dir = mkdtempSync(join(base, 'harness-'));
  const source = Object.values(JAIL_PATHS).reduce(
    (s, p) => s.replaceAll(p, join(dir, p.replaceAll('/', '_'))),
    HARNESS_SOURCE,
  );
  const path = (p: string) => join(dir, p.replaceAll('/', '_'));
  writeFileSync(path(JAIL_PATHS.harness), source);
  writeFileSync(path(JAIL_PATHS.witness), witness);
  writeFileSync(path(JAIL_PATHS.input), JSON.stringify(input));
  writeFileSync(path(JAIL_PATHS.result), '');
  let code = 0;
  try {
    execFileSync('node', [path(JAIL_PATHS.harness)], { stdio: 'pipe', timeout: 20_000 });
  } catch (err) {
    code = (err as { status: number }).status;
  }
  return { code, artifact: readFileSync(path(JAIL_PATHS.result), 'utf8') };
}

const input = (params: HarnessInput['params']): HarnessInput => ({
  schemaVersion: 1,
  params,
  target: { url: 'http://target:4000' },
});

describe('witness harness', () => {
  it('walks the family with the last parameter fastest and records pass or fail', () => {
    const { code, artifact } = runHarness(
      `export default async (p, ctx) => {
         if (ctx.target.url !== 'http://target:4000') throw new Error('no target');
         if (p.a === 2 && p.b === 'y') throw new Error('fails here');
         return p.b === 'z' ? false : true;
       };`,
      input([
        { name: 'a', values: [1, 2] },
        { name: 'b', values: ['x', 'y', 'z'] },
      ]),
    );
    expect(code).toBe(0);
    const parsed = parseResultArtifact(artifact, 6, 65536);
    // (1,x) (1,y) (1,z) (2,x) (2,y) (2,z)
    expect(parsed).toEqual({ ok: true, results: [true, true, false, true, false, false] });
  });

  it('runs an empty ParamSpace once', () => {
    const { artifact } = runHarness('export default () => undefined;', input([]));
    expect(parseResultArtifact(artifact, 1, 65536)).toEqual({ ok: true, results: [true] });
  });

  it('writes no artifact and exits non-zero for a module without a default function', () => {
    const { code, artifact } = runHarness('export const x = 1;', input([]));
    expect(code).toBe(3);
    expect(artifact).toBe('');
  });

  it('writes no artifact when the witness exits the process itself', () => {
    const { artifact } = runHarness(
      'export default () => process.exit(0);',
      input([{ name: 'a', values: [1] }]),
    );
    expect(artifact).toBe('');
  });

  it('is pinned by its hash for bundles', () => {
    expect(HARNESS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('asWitness', () => {
  it('turns a probe into a one-parameter witness that passes', () => {
    const { artifact } = runHarness(asWitness('console.log("probe ran");'), input([]));
    expect(parseResultArtifact(artifact, 1, 65536)).toEqual({ ok: true, results: [true] });
  });
});
