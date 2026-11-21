// Helpers shared by the unit test files in this directory. Not part of the tools API.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEMGREP_CANARY } from './invocations.js';

/** One result of the Semgrep liveness canary, as the pinned Semgrep reports it. */
export function canaryResult(
  uri: string = SEMGREP_CANARY.uri,
  line: number = SEMGREP_CANARY.line,
): Record<string, unknown> {
  return {
    ruleId: SEMGREP_CANARY.ruleId,
    message: { text: 'liveness canary' },
    locations: [
      {
        physicalLocation: { artifactLocation: { uri }, region: { startLine: line, endLine: line } },
      },
    ],
  };
}

/**
 * Adds the canary's result (and its rule) to the first run of a Semgrep SARIF document, as a real
 * scan with the canary mounted produces. Takes and returns JSON text or an object.
 */
export function withSemgrepCanary(doc: string): string;
export function withSemgrepCanary<T extends object>(doc: T): T;
export function withSemgrepCanary(doc: string | object): string | object {
  const d = (typeof doc === 'string' ? JSON.parse(doc) : doc) as {
    runs?: { results?: unknown[]; tool?: { driver?: { rules?: unknown[] } } }[];
  };
  const run = d.runs?.[0];
  if (run !== undefined) {
    run.results = [...(run.results ?? []), canaryResult()];
    const driver = run.tool?.driver;
    if (Array.isArray(driver?.rules))
      driver.rules = [...driver.rules, { id: SEMGREP_CANARY.ruleId }];
  }
  return typeof doc === 'string' ? JSON.stringify(d) : d;
}

const tmpDirs: string[] = [];

/** Call from `afterAll` in each test file. */
export function cleanupTmp(): void {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'affidavit-tools-test-'));
  tmpDirs.push(d);
  return d;
}

export function put(root: string, rel: string, body = 'x'): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

/** A parent dir holding a `snap` directory, so the sidecar `snap.quarantine` has room beside it. */
export function snapDir(files: Record<string, string> = {}): string {
  const dir = join(tmp(), 'snap');
  mkdirSync(dir);
  for (const [f, body] of Object.entries(files)) put(dir, f, body);
  return dir;
}

/** Symlinks need privileges on some Windows setups. Probe once so the tests skip visibly. */
function canSymlink(): boolean {
  const base = tmp();
  try {
    symlinkSync(base, join(base, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  }
}
export const symlinks = canSymlink();

/** Raw non-UTF-8 names are rejected by some filesystems. Probe once so the test skips visibly. */
function canMakeRawNames(): boolean {
  const base = tmp();
  try {
    mkdirSync(Buffer.concat([Buffer.from(base + '/'), Buffer.from([0x66, 0xff, 0xfe, 0x6f])]));
    return true;
  } catch {
    return false;
  }
}
export const rawNames = canMakeRawNames();
