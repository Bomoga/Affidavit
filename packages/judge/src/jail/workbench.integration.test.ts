import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseFile, type BootHints } from '@affidavit/contracts';
import { RUN_LABEL } from '@affidavit/sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUnifiedDiff, selectFiles } from '../patch/diff.js';
import { isTestFile } from '../patch/literal.js';
import type { PatchPlan } from '../patch/workbench.js';
import { gateCaseFile, patchExhibit } from '../test-helpers.js';
import { BootedTargets } from './booted.js';
import { JailedPatchWorkbench, buildPatchApplyImage } from './workbench.js';

const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';

const HINTS: BootHints = {
  kind: 'dockerfile',
  path: 'Dockerfile',
  ports: [3000],
  healthRoute: '/health',
  healthTimeoutMs: 15_000,
  stubs: [],
  env: {},
};

const LIB = 'exports.ok = () => true;\n';
const LOCK = (packages: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    name: 'tiny',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'tiny', version: '1.0.0' }, ...packages },
  })}\n`;
/** A dev-only entry from outside the npm registry: the fetch may never install it. */
const GIT_DEV = {
  'node_modules/tool': { version: 'git+https://example.test/tool.git', dev: true },
};

/** `git diff` of one file changed from `before` to `after`, as Remedy would submit it. */
function diffOf(rel: string, before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'affidavit-wb-diff-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  try {
    git('init', '-q');
    writeFileSync(join(dir, rel), before);
    git('add', '.');
    git('commit', '-q', '-m', 'v');
    writeFileSync(join(dir, rel), after);
    return git('diff');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function planOf(diff: string): PatchPlan {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) throw new Error('test diff does not parse');
  return {
    full: parsed.diff,
    code: selectFiles(parsed.diff, (f) => !isTestFile(f.path)),
    tests: selectFiles(parsed.diff, (f) => isTestFile(f.path)),
  };
}

describe.runIf(onSandboxHost)(
  'the real patch workbench on a tiny app',
  { timeout: 900_000 },
  () => {
    let root = '';
    let applyImage = '';
    const cf = CaseFile.parse({ ...gateCaseFile(), bootHints: HINTS });

    /** A one-file app whose `npm test` checks `lib.js`; `lock` is its package-lock.json. */
    const app = (name: string, lock: string): string => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'Dockerfile'),
        'FROM node:22-alpine\nWORKDIR /app\nCMD ["node", "server.js"]\n',
      );
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'tiny', version: '1.0.0', scripts: { test: 'node test.js' } }),
      );
      writeFileSync(join(dir, 'package-lock.json'), lock);
      writeFileSync(join(dir, 'lib.js'), LIB);
      writeFileSync(
        join(dir, 'test.js'),
        "require('assert').strictEqual(require('./lib').ok(), true);\n",
      );
      writeFileSync(
        join(dir, 'server.js'),
        "require('http').createServer((q, s) => s.end('ok')).listen(3000);\n",
      );
      return dir;
    };

    const workbenchFor = (src: string) => {
      const targets = new BootedTargets();
      const wb = new JailedPatchWorkbench({
        workRoot: join(root, 'work'),
        applyImage,
        vulnerableSource: () => src,
        targets,
      });
      return { wb, targets };
    };

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'affidavit-wb-it-'));
      mkdirSync(join(root, 'work'));
      applyImage = await buildPatchApplyImage();
    }, 600_000);

    afterAll(() => {
      try {
        expect(readdirSync(join(root, 'work'))).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      const left = execFileSync(
        'docker',
        ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`],
        { encoding: 'utf8' },
      );
      expect(left.trim()).toBe('');
    });

    it('runs the suite in a devDependencies build: a sound patch passes, a breaking one fails', async () => {
      const src = app('available', LOCK());
      for (const [after, passed] of [
        ['// checked\nexports.ok = () => true;\n', true],
        ['exports.ok = () => false;\n', false],
      ] as const) {
        const { wb, targets } = workbenchFor(src);
        const diff = diffOf('lib.js', LIB, after);
        const out = await wb.prepare(cf, patchExhibit(diff, {}, { raw: true }), planOf(diff));
        if (!out.ok) throw new Error(`prepare failed: ${out.stage}: ${out.detail}`);
        try {
          expect(
            await targets.endpoint({ variant: 'patched' } as Parameters<
              typeof targets.endpoint
            >[0]),
          ).toBeDefined();
          expect(await wb.runSuite(cf, out.prepared)).toEqual({ passed });
        } finally {
          await wb.release(out.prepared);
        }
      }
    });

    it('reports the suite unavailable when the vulnerable commit cannot fetch its devDependencies', async () => {
      const src = app('unavailable', LOCK(GIT_DEV));
      const { wb } = workbenchFor(src);
      const diff = diffOf('lib.js', LIB, '// checked\nexports.ok = () => true;\n');
      const out = await wb.prepare(cf, patchExhibit(diff, {}, { raw: true }), planOf(diff));
      if (!out.ok) throw new Error(`prepare failed: ${out.stage}: ${out.detail}`);
      try {
        expect(await wb.runSuite(cf, out.prepared)).toEqual({
          unavailable:
            'the suite cannot be built: node_modules/tool comes from git+https://example.test/tool.git',
        });
      } finally {
        await wb.release(out.prepared);
      }
    });

    it('treats a patch that makes the suite unbuildable as a build failure, not an unavailable suite', async () => {
      const src = app('dodge', LOCK());
      const { wb, targets } = workbenchFor(src);
      const diff = diffOf('package-lock.json', LOCK(), LOCK(GIT_DEV));
      const out = await wb.prepare(cf, patchExhibit(diff, {}, { raw: true }), planOf(diff));
      expect(out).toMatchObject({ ok: false, stage: 'build' });
      await expect(
        targets.endpoint({ variant: 'patched' } as Parameters<typeof targets.endpoint>[0]),
      ).rejects.toThrow();
    });
  },
);
