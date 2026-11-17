import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GvisorToolRunner, TOOL_SCRATCH_TARGETS } from './runner.js';

const base = mkdtempSync(join(tmpdir(), 'affidavit-toolrunner-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const IMAGE = `docker.io/semgrep/semgrep@sha256:${'a'.repeat(64)}`;

// These checks run before anything reaches Docker, so no sandbox host is needed.
describe('GvisorToolRunner scratch mounts', () => {
  const runner = new GvisorToolRunner({
    outputDir: base,
    allowedRoots: [base],
    imageAllowlist: [IMAGE],
  });

  it('treats /tmp and /root/.semgrep as scratch the runner provides', () => {
    expect(TOOL_SCRATCH_TARGETS).toEqual(['/tmp', '/root/.semgrep']);
  });

  it.each(['/tmp', '/tmp/', '/root/.semgrep'])(
    'refuses a non-empty host directory mounted at %s',
    async (target) => {
      const dir = mkdtempSync(join(base, 'scratch-'));
      writeFileSync(join(dir, 'planted'), 'x');
      await expect(
        runner.run(IMAGE, ['true'], [{ hostPath: dir, containerPath: target, readOnly: false }]),
      ).rejects.toThrow(/empty directory/);
    },
  );

  it('refuses a file or a symlink in place of a scratch directory', async () => {
    const file = join(base, 'a-file');
    writeFileSync(file, '');
    await expect(
      runner.run(IMAGE, ['true'], [{ hostPath: file, containerPath: '/tmp', readOnly: false }]),
    ).rejects.toThrow(/empty directory/);
    const target = mkdtempSync(join(base, 'target-'));
    const link = join(base, 'scratch-link');
    symlinkSync(target, link);
    await expect(
      runner.run(IMAGE, ['true'], [{ hostPath: link, containerPath: '/tmp', readOnly: false }]),
    ).rejects.toThrow(/empty directory/);
  });

  it('refuses an image that is not on the allowlist before looking at mounts', async () => {
    const dir = join(base, 'unused');
    mkdirSync(dir, { recursive: true });
    await expect(runner.run(`${IMAGE.slice(0, -1)}b`, ['true'], [])).rejects.toThrow(/allowlist/);
  });

  it('refuses running tools as root', async () => {
    const root = new GvisorToolRunner({ outputDir: base, allowedRoots: [base], user: '0:0' });
    await expect(root.run(IMAGE, ['true'], [])).rejects.toThrow(/root/);
  });
});
