import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const probeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'docker',
  'tools',
  'probe',
);

interface ProbeLib {
  namesFileContent(names: string[]): string;
  probeExitCode(shouldDrop: string[], shouldScan: string[]): number;
}
const lib = (await import(pathToFileURL(join(probeDir, 'lib.mjs')).href)) as ProbeLib;

describe('docker/tools/probe/archive-names.mjs helpers', () => {
  it('ends the names file with a newline, so `read` does not skip the last name', () => {
    const text = lib.namesFileContent(['f.a', 'f.TLZ4.txt']);
    expect(text).toBe('f.a\nf.TLZ4.txt\n');
    // what the container's loop sees: every line, including the last, is newline-terminated
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter(Boolean)).toEqual(['f.a', 'f.TLZ4.txt']);
  });

  it('exits 1 for an over-match, for a miss, and 0 only when both lists are empty', () => {
    expect(lib.probeExitCode([], [])).toBe(0);
    expect(lib.probeExitCode(['f.zip'], [])).toBe(1); // ARCHIVE_NAME matches, gitleaks scanned it
    expect(lib.probeExitCode([], ['f.xyz'])).toBe(1); // gitleaks dropped it, ARCHIVE_NAME does not match
  });

  it('the probe script uses those helpers for both name files and the exit code', () => {
    const src = readFileSync(join(probeDir, 'archive-names.mjs'), 'utf8');
    expect(src.match(/namesFileContent\(names\)/g)).toHaveLength(2);
    expect(src).toContain('process.exitCode = probeExitCode(shouldDrop, shouldScan)');
    expect(src).not.toMatch(/names\.join\('\\n'\)/);
  });
});
