/**
 * The re-scan adapter (L1-17), offline: the real copy, quarantine, `runTool` and normalizer, with
 * Semgrep replaced behind ToolRunnerPort by a stand-in that writes fixture SARIF for the tree it
 * was given (fixtures/corpus/rescan/README.md). `rescan.docker.test.ts` runs the real image.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RescanPort, ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmp, symlinks, tmp } from '../tools/testkit.js';
import { DiscoveryRescan, rescanPatchedTree, type RescanDeps } from './index.js';
import {
  NOSQL_WHERE,
  RULES,
  SQL_CONCAT,
  buildTree,
  caseFileFor,
  sarifFor,
  type Variant,
} from './rescan.testutil.js';

afterAll(cleanupTmp);

interface Seen {
  calls: number;
  /** Files the stand-in saw under /src, relative, posix. */
  files: string[];
}

function list(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? list(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** Semgrep stand-in: writes the variant's SARIF (optionally changed) to /out/semgrep.sarif. */
function replay(
  variant: Variant,
  seen: Seen,
  edit: (doc: Record<string, unknown>) => void = () => undefined,
  exitCode = 0,
): ToolRunnerPort {
  return {
    run(_image, _args, mounts) {
      seen.calls += 1;
      const out = mounts.find((m) => m.containerPath === '/out')?.hostPath;
      const src = mounts.find((m) => m.containerPath === '/src')?.hostPath;
      if (out === undefined || src === undefined) throw new Error('missing /out or /src');
      seen.files = list(src).sort();
      mkdirSync(out, { recursive: true });
      const doc = JSON.parse(sarifFor(variant)) as Record<string, unknown>;
      edit(doc);
      writeFileSync(join(out, 'semgrep.sarif'), JSON.stringify(doc));
      return Promise.resolve({ exitCode, outputPath: out });
    },
  };
}

function setup(variant: Variant) {
  const root = tmp();
  const tree = buildTree(variant, join(root, 'patched'));
  const workRoot = join(root, 'work');
  mkdirSync(workRoot);
  const seen: Seen = { calls: 0, files: [] };
  const deps = (runner: ToolRunnerPort): RescanDeps => ({ runner, workRoot, rulesDir: RULES });
  return { tree, workRoot, seen, deps };
}

const whereCase = caseFileFor(NOSQL_WHERE, 'src/routes.js', 15);

describe('rescanPatchedTree', () => {
  it('is not clean on the vulnerable tree: the recorded finding is still there', async () => {
    const { tree, seen, deps } = setup('vulnerable');
    const r = await rescanPatchedTree(deps(replay('vulnerable', seen)), whereCase, tree);
    expect(r).toMatchObject({ clean: false, reason: 'finding-present' });
    expect(seen.calls).toBe(1);
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('is clean once the $where sink is patched, and reports what is still found', async () => {
    const { tree, seen, deps } = setup('patched');
    const r = await rescanPatchedTree(deps(replay('patched', seen)), whereCase, tree);
    expect(r).toMatchObject({ clean: true, reason: 'clean' });
    expect(r.candidates.some((c) => c.file === 'src/routes.js')).toBe(true);
    expect(r.candidates.some((c) => c.ruleId === NOSQL_WHERE)).toBe(false);
  });

  it('compares file and rule, not the range: a sink that only moved is not clean', async () => {
    const { tree, seen, deps } = setup('shifted');
    const r = await rescanPatchedTree(deps(replay('shifted', seen)), whereCase, tree);
    expect(r).toMatchObject({ clean: false, reason: 'finding-present' });
  });

  it('judges the case candidate only: another rule in the same file is still found', async () => {
    const { tree, seen, deps } = setup('patched');
    const r = await rescanPatchedTree(
      deps(replay('patched', seen)),
      caseFileFor(SQL_CONCAT, 'src/routes.js', 9),
      tree,
    );
    expect(r).toMatchObject({ clean: false, reason: 'finding-present' });
  });

  it('is never clean when Semgrep reports a coverage loss', async () => {
    const { tree, seen, deps } = setup('patched');
    const partial = replay('patched', seen, (doc) => {
      const run = (doc['runs'] as { invocations: unknown[] }[])[0];
      if (run) {
        run.invocations = [
          {
            executionSuccessful: true,
            toolExecutionNotifications: [
              { level: 'warning', descriptor: { id: 'Timeout' }, message: { text: 'timeout' } },
            ],
          },
        ];
      }
    });
    const r = await rescanPatchedTree(deps(partial), whereCase, tree);
    expect(r).toMatchObject({ clean: false, reason: 'scan-partial' });
  });

  it('is not clean when a finding of the rule in that file was skipped by the normalizer', async () => {
    const { tree, seen, deps } = setup('patched');
    const noRegion = replay('patched', seen, (doc) => {
      const run = (doc['runs'] as { results: unknown[] }[])[0];
      run?.results.push({
        ruleId: NOSQL_WHERE,
        locations: [{ physicalLocation: { artifactLocation: { uri: '/src/src/routes.js' } } }],
      });
    });
    const r = await rescanPatchedTree(deps(noRegion), whereCase, tree);
    expect(r.clean).toBe(false);
  });

  it('does not re-run anything for a candidate from another tool', async () => {
    const { tree, seen, deps } = setup('patched');
    const r = await rescanPatchedTree(
      deps(replay('patched', seen)),
      caseFileFor(NOSQL_WHERE, 'src/routes.js', 15, 'osv'),
      tree,
    );
    expect(r).toMatchObject({ clean: false, reason: 'tool-not-rescannable' });
    expect(seen.calls).toBe(0);
  });

  it('is not clean when the case file is gone from the patched tree', async () => {
    const { tree, seen, deps } = setup('patched');
    rmSync(join(tree, 'src', 'routes.js'));
    const r = await rescanPatchedTree(deps(replay('patched', seen)), whereCase, tree);
    expect(r).toMatchObject({ clean: false, reason: 'file-missing' });
    expect(seen.calls).toBe(0);
  });

  it('is not clean for a candidate path that is not a plain relative path', async () => {
    const { tree, seen, deps } = setup('patched');
    for (const file of ['../patched/src/routes.js', '[text removed]', 'src//routes.js']) {
      const r = await rescanPatchedTree(
        deps(replay('patched', seen)),
        caseFileFor(NOSQL_WHERE, file, 15),
        tree,
      );
      expect(r).toMatchObject({ clean: false, reason: 'unsafe-candidate-path' });
    }
    expect(seen.calls).toBe(0);
  });

  it('never writes into the patched tree, leaves out .git, and removes its own run directory', async () => {
    const { tree, workRoot, seen, deps } = setup('patched');
    mkdirSync(join(tree, '.git'));
    writeFileSync(join(tree, '.git', 'config'), '[core]\n');
    writeFileSync(join(tree, '.semgrepignore'), 'src/\n');
    const before = list(tree).sort();
    const routes = readFileSync(join(tree, 'src', 'routes.js'), 'utf8');
    expect(routes).toContain('db.allocations.find({ userId })');
    await rescanPatchedTree(deps(replay('patched', seen)), whereCase, tree);
    expect(list(tree).sort()).toEqual(before);
    expect(readFileSync(join(tree, 'src', 'routes.js'), 'utf8')).toBe(routes);
    expect(seen.files).toContain('src/routes.js');
    expect(seen.files.some((f) => f.startsWith('.git'))).toBe(false);
    // Tool-control files are quarantined in the copy, as at intake.
    expect(seen.files).not.toContain('.semgrepignore');
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it.skipIf(!symlinks)('does not follow or copy a symlink, even at the case file', async () => {
    const { tree, seen, deps } = setup('patched');
    const outside = join(tmp(), 'outside.js');
    writeFileSync(outside, 'module.exports = 1;\n');
    symlinkSync(outside, join(tree, 'src', 'linked.js'));
    rmSync(join(tree, 'src', 'routes.js'));
    symlinkSync(outside, join(tree, 'src', 'routes.js'));
    const r = await rescanPatchedTree(deps(replay('patched', seen)), whereCase, tree);
    expect(r).toMatchObject({ clean: false, reason: 'file-missing' });
    expect(existsSync(outside)).toBe(true);
  });

  it('throws when Semgrep fails, and still removes its run directory', async () => {
    const { tree, workRoot, seen, deps } = setup('patched');
    await expect(
      rescanPatchedTree(deps(replay('patched', seen, undefined, 2)), whereCase, tree),
    ).rejects.toThrow();
    expect(readdirSync(workRoot)).toEqual([]);
  });
});

describe('DiscoveryRescan as the RescanPort', () => {
  it('returns only clean and the candidates', async () => {
    const { tree, seen, deps } = setup('patched');
    const port: RescanPort = new DiscoveryRescan(deps(replay('patched', seen)));
    const r = await port.rescan(whereCase, tree);
    expect(Object.keys(r).sort()).toEqual(['candidates', 'clean']);
    expect(r.clean).toBe(true);
    const vulnerable = setup('vulnerable');
    const v = new DiscoveryRescan(vulnerable.deps(replay('vulnerable', vulnerable.seen)));
    expect((await v.rescan(whereCase, vulnerable.tree)).clean).toBe(false);
  });
});
