import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canaryRoot, loadToolManifest } from '@affidavit/discovery';
import { DEFAULT_LIMITS, buildGvisorRunArgs } from '@affidavit/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import type { IntakeSettings } from '../config.js';
import { TOOL_LIMITS, buildToolRunner, toolImageAllowlist } from './components.js';

const workRoot = mkdtempSync(join(tmpdir(), 'affidavit-components-'));
afterAll(() => rmSync(workRoot, { recursive: true, force: true }));

const settings: IntakeSettings = {
  workRoot,
  sources: {},
  allowLocalSource: false,
  toolRunner: 'gvisor',
  toolRunnerExplicit: true,
  toolTimeoutMs: 1000,
};

const enabled = loadToolManifest().tools.filter((t) => t.enabled && t.reference !== null);
// A relative host path makes the runner refuse the mounts before any docker command runs, so these
// tests reach the allowlist check and stop right after it.
const unrunnable = [{ hostPath: 'relative', containerPath: '/src', readOnly: true }];

describe('the gVisor tool runner allowlist', () => {
  it('lists the pinned reference of every enabled scanner, never a bare name', () => {
    expect(enabled.length).toBeGreaterThan(0);
    const allow = toolImageAllowlist();
    for (const t of enabled) {
      expect(allow).toContain(t.reference);
      expect(allow).not.toContain(t.image);
    }
    for (const r of allow) expect(r).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('lets discovery run each scanner by the reference it passes (image@sha256:...)', async () => {
    const runner = buildToolRunner(settings);
    for (const t of enabled) {
      const err = await runner.run(t.reference as string, [], unrunnable).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/allowlist/);
      expect((err as Error).message).toMatch(/hostPath must be absolute/);
    }
  });

  it('still refuses anything else: a bare name, a tag, another digest', async () => {
    const runner = buildToolRunner(settings);
    const t = enabled[0];
    if (t === undefined) throw new Error('no enabled tool');
    for (const image of [
      t.image as string,
      `${t.image as string}:${t.tag as string}`,
      `${t.image as string}@sha256:${'0'.repeat(64)}`,
    ]) {
      await expect(runner.run(image, [], unrunnable)).rejects.toThrow(/allowlist/);
    }
  });

  // The gVisor runner is Linux only, and refuses host paths with spaces (common on Windows).
  it.skipIf(process.platform === 'win32')(
    'lets Semgrep mount the liveness canary read-only at /canary',
    async () => {
      const runner = buildToolRunner(settings);
      const t = enabled[0];
      if (t === undefined) throw new Error('no enabled tool');
      // Mounts are checked in order: the canary passes (allowed root, target not reserved), then the
      // relative mount stops the run before docker.
      const canary = {
        hostPath: join(canaryRoot(), 'semgrep'),
        containerPath: '/canary',
        readOnly: true,
      };
      const err = await runner
        .run(t.reference as string, [], [canary, ...unrunnable])
        .catch((e: Error) => e);
      expect((err as Error).message).toMatch(/hostPath must be absolute/);
    },
  );
});

describe('scanner jail limits', () => {
  it('give Semgrep a larger /scratch than the witness default, inside a larger memory limit', () => {
    expect(TOOL_LIMITS.scratchMb).toBe(512);
    expect(TOOL_LIMITS.scratchMb).toBeGreaterThan(DEFAULT_LIMITS.scratchMb);
    // A tmpfs counts against the memory limit, so the limit leaves room beside a full /scratch.
    expect(TOOL_LIMITS.memoryMb).toBeGreaterThanOrEqual(TOOL_LIMITS.scratchMb * 2);
    expect(TOOL_LIMITS.pids).toBe(DEFAULT_LIMITS.pids);
    expect(TOOL_LIMITS.cpus).toBe(DEFAULT_LIMITS.cpus);
  });

  it('reach the docker run arguments as the /scratch tmpfs size and the memory limit', () => {
    const args = buildGvisorRunArgs({
      name: 'n',
      runId: 'r',
      image: enabled[0]?.reference as string,
      command: [],
      mounts: [],
      limits: TOOL_LIMITS,
    });
    expect(args).toContain(`/scratch:rw,size=${TOOL_LIMITS.scratchMb}m,mode=1777`);
    expect(args).toContain(`${TOOL_LIMITS.memoryMb}m`);
  });
});
