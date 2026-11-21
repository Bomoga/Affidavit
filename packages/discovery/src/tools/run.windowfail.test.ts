import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadToolManifest, quarantineSnapshot, runTool } from './index.js';
import { cleanupTmp, snapDir, tmp } from './testkit.js';

// writeWindows is replaced so a write failure (an over-long name, a full disk) can be simulated
// on any filesystem. Everything else in windows.ts is the real module.
vi.mock('./windows.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./windows.js')>();
  return {
    ...real,
    writeWindows: vi.fn(() =>
      Promise.resolve({
        entries: [],
        skippedForBudget: [],
        failed: [{ original: `src/${'a'.repeat(248)}.gz.txt`, why: 'ENAMETOOLONG' }],
        bytes: 0,
      }),
    ),
  };
});

afterAll(cleanupTmp);

describe('runTool when windows cannot be written', () => {
  it('turns a writeWindows failure into a window-skipped notification and a partial run', async () => {
    const manifest = loadToolManifest();
    const snap = await quarantineSnapshot(snapDir({ 'src/app.js': 'x' }));
    const calls: string[] = [];
    const runner: ToolRunnerPort = {
      run(image, _args, mounts) {
        calls.push(image);
        const out = mounts.find((m) => m.containerPath === '/out')?.hostPath ?? '';
        writeFileSync(join(out, 'gitleaks.sarif'), JSON.stringify({ runs: [{ results: [] }] }));
        return Promise.resolve({ exitCode: 0, outputPath: out });
      },
    };
    const res = await runTool(runner, manifest, 'gitleaks', {
      snapshot: snap,
      outputDir: join(tmp(), 'out'),
      scratchDir: join(tmp(), 's'),
    });
    const note = res.notifications.find((n) => n.id === 'window-skipped');
    expect(note?.message).toContain('could not be windowed (ENAMETOOLONG)');
    expect(note?.message).toContain(`/src/src/${'a'.repeat(248)}.gz.txt`);
    expect(res.partial).toBe(true);
    expect(res.windowedFiles).toEqual([]);
    expect(res.reports.map((r) => r.origin)).toEqual(['snapshot']);
    expect(calls).toHaveLength(1); // no windows pass: there is nothing to scan
  });
});
