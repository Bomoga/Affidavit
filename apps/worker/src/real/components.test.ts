import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolManifest } from '@affidavit/discovery';
import { afterAll, describe, expect, it } from 'vitest';
import type { IntakeSettings } from '../config.js';
import { buildToolRunner, toolImageAllowlist } from './components.js';

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
});
