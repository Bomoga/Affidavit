import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OutputNotFreshError,
  REPORT_FILE_MODE,
  UnshareableEntryError,
  loadToolManifest,
  prepareOutput,
  prepareScratch,
  quarantineSnapshot,
  runTool,
  shareForJailRead,
} from './index.js';
import { cleanupTmp, snapDir, tmp, withSemgrepCanary } from './testkit.js';

afterAll(cleanupTmp);

// Modes mean nothing on Windows (chmod only toggles read-only there).
const posix = process.platform !== 'win32';
const mode = (p: string): number => lstatSync(p).mode & 0o7777;

describe.runIf(posix).each([0o022, 0o077])(
  'tool run directories under umask %o (scanners run as another user)',
  (mask) => {
    let saved = 0;
    beforeEach(() => {
      saved = process.umask(mask);
    });
    afterEach(() => {
      process.umask(saved);
    });

    it('prepareOutput: a 0755 directory and a pre-created, empty 0666 report file', async () => {
      const out = join(tmp(), 'out');
      await prepareOutput(out, 'gitleaks.sarif');
      expect(mode(out)).toBe(0o755);
      const report = join(out, 'gitleaks.sarif');
      expect(lstatSync(report).isFile()).toBe(true);
      expect(lstatSync(report).size).toBe(0);
      expect(mode(report)).toBe(REPORT_FILE_MODE);
      // Still one run per directory: a second prepare on it is refused.
      await expect(prepareOutput(out, 'gitleaks.sarif')).rejects.toBeInstanceOf(
        OutputNotFreshError,
      );
    });

    it('prepareOutput refuses a report name that is not a plain file name', async () => {
      for (const bad of ['../x.sarif', 'a/b.sarif', '..', '.']) {
        await expect(prepareOutput(join(tmp(), 'out'), bad)).rejects.toThrow(/plain name/);
      }
    });

    it('prepareScratch: writable 0777 subdirectories, a 0755 root that is not mounted', async () => {
      const scratch = join(tmp(), 'scratch');
      await prepareScratch(scratch, ['tmp', 'semgrep-home']);
      expect(mode(scratch)).toBe(0o755);
      expect(mode(join(scratch, 'tmp'))).toBe(0o777);
      expect(mode(join(scratch, 'semgrep-home'))).toBe(0o777);
    });

    it('shareForJailRead adds read for others only where the owner can read', async () => {
      const snap = join(tmp(), 'snap');
      mkdirSync(join(snap, 'sub', 'deep'), { recursive: true });
      writeFileSync(join(snap, 'a.js'), 'x');
      writeFileSync(join(snap, 'sub', 'deep', 'b.js'), 'y');
      writeFileSync(join(snap, 'run.sh'), 'z');
      writeFileSync(join(snap, 'secret-unreadable'), 's');
      chmodSync(join(snap, 'run.sh'), 0o700);
      chmodSync(join(snap, 'secret-unreadable'), 0o200);
      mkdirSync(join(snap, 'closed'));
      chmodSync(join(snap, 'closed'), 0o300);
      symlinkSync(join(snap, 'a.js'), join(snap, 'link'));
      const linkBefore = mode(join(snap, 'link'));

      await shareForJailRead(snap);

      expect(mode(snap) & 0o055).toBe(0o055);
      expect(mode(join(snap, 'sub')) & 0o055).toBe(0o055);
      expect(mode(join(snap, 'sub', 'deep')) & 0o055).toBe(0o055);
      expect(mode(join(snap, 'a.js')) & 0o044).toBe(0o044);
      expect(mode(join(snap, 'sub', 'deep', 'b.js')) & 0o044).toBe(0o044);
      // Read only: no write or execute is added for anyone.
      expect(mode(join(snap, 'a.js')) & 0o033).toBe(0);
      expect(mode(join(snap, 'run.sh'))).toBe(0o744);
      // What the owner cannot read stays unreadable, so the `unreadable` check keeps its meaning.
      expect(mode(join(snap, 'secret-unreadable'))).toBe(0o200);
      expect(mode(join(snap, 'closed'))).toBe(0o300);
      // A symlink is never followed or changed.
      expect(mode(join(snap, 'link'))).toBe(linkBefore);
      chmodSync(join(snap, 'closed'), 0o700);
    });

    it('shareForJailRead refuses an entry that is neither a file, a directory nor a link', async () => {
      const snap = join(tmp(), 'snap');
      mkdirSync(join(snap, 'sub'), { recursive: true });
      writeFileSync(join(snap, 'a.js'), 'x');
      execFileSync('mkfifo', [join(snap, 'sub', 'pipe')]);
      const err = await shareForJailRead(snap).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnshareableEntryError);
      expect((err as UnshareableEntryError).path).toBe('sub/pipe');
    });

    it('runTool makes the scan copy readable to the jail user before the tool runs', async () => {
      // Written under this umask, so under 077 every file starts as 0600 and every dir as 0700.
      const snap = await quarantineSnapshot(snapDir({ 'src/app.js': 'x', 'lib/deep/b.js': 'y' }));
      const seen: { path: string; mode: number }[] = [];
      const runner: ToolRunnerPort = {
        run(_image, _args, mounts) {
          const src = mounts.find((m) => m.containerPath === '/src')?.hostPath ?? '';
          const out = mounts.find((m) => m.containerPath === '/out')?.hostPath ?? '';
          const walk = (dir: string): void => {
            seen.push({ path: dir, mode: mode(dir) });
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              const p = join(dir, e.name);
              if (e.isDirectory()) walk(p);
              else seen.push({ path: p, mode: mode(p) });
            }
          };
          walk(src);
          writeFileSync(join(out, 'semgrep.sarif'), withSemgrepCanary(EMPTY_SEMGREP));
          return Promise.resolve({ exitCode: 0, outputPath: out });
        },
      };
      await runTool(runner, loadToolManifest(), 'semgrep', {
        snapshot: snap,
        outputDir: join(tmp(), 'out'),
        scratchDir: join(tmp(), 's'),
        rulesDir: tmp(),
      });
      expect(seen.length).toBeGreaterThan(3);
      for (const s of seen) {
        const want = lstatSync(s.path).isDirectory() ? 0o055 : 0o044;
        expect({ path: s.path, others: s.mode & want }).toEqual({ path: s.path, others: want });
      }
    });
  },
);

const EMPTY_SEMGREP = JSON.stringify({
  runs: [{ tool: { driver: { name: 'semgrep', rules: [] } }, results: [] }],
});
