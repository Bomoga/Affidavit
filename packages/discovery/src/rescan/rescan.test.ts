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
import { cleanupTmp, symlinks, tmp, withSemgrepCanary } from '../tools/testkit.js';
import { classifyHead } from '../tools/index.js';
import { DiscoveryRescan, hasOddControlByte, rescanPatchedTree, type RescanDeps } from './index.js';
import {
  NOSQL_WHERE,
  RESCAN as RESCAN_FIXTURES,
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
      writeFileSync(join(out, 'semgrep.sarif'), JSON.stringify(withSemgrepCanary(doc)));
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

describe('clean is never the default (review of #66)', () => {
  /** Drops `ruleId` from the rules the SARIF says it ran (as a rule renamed or missing since intake). */
  const withoutRule =
    (ruleId: string) =>
    (doc: Record<string, unknown>): void => {
      for (const run of doc['runs'] as { tool: { driver: { rules: { id: string }[] } } }[]) {
        run.tool.driver.rules = run.tool.driver.rules.filter((r) => r.id !== ruleId);
      }
    };

  it('is not clean when the case rule is not among the rules Semgrep loaded', async () => {
    const { tree, seen, deps } = setup('patched');
    const r = await rescanPatchedTree(
      deps(replay('patched', seen, withoutRule(NOSQL_WHERE))),
      whereCase,
      tree,
    );
    expect(r).toMatchObject({ clean: false, reason: 'rule-not-loaded' });
  });

  it('is not clean when the SARIF lists no rules at all', async () => {
    const { tree, seen, deps } = setup('patched');
    const none = replay('patched', seen, (doc) => {
      for (const run of doc['runs'] as { tool: { driver: Record<string, unknown> } }[]) {
        delete run.tool.driver['rules'];
      }
    });
    const r = await rescanPatchedTree(deps(none), whereCase, tree);
    expect(r).toMatchObject({ clean: false, reason: 'rule-not-loaded' });
  });

  /** The patched case file rewritten to `bytes`; Semgrep must not even run. */
  async function withCaseFile(bytes: Buffer | string) {
    const { tree, seen, deps } = setup('patched');
    writeFileSync(join(tree, 'src', 'routes.js'), bytes);
    const r = await rescanPatchedTree(deps(replay('patched', seen)), whereCase, tree);
    return { r, seen };
  }
  const patchedText = (): string =>
    readFileSync(join(RESCAN_FIXTURES, 'patched', 'src', 'routes.js.fixture'), 'utf8');

  it('is not clean when the case file holds a NUL byte', async () => {
    const { r, seen } = await withCaseFile(`${patchedText()}\0\n`);
    expect(r).toMatchObject({ clean: false, reason: 'not-plain-text' });
    expect(seen.calls).toBe(0);
  });

  it('is not clean when the case file is UTF-16', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(patchedText(), 'utf16le')]);
    const { r, seen } = await withCaseFile(utf16);
    expect(r).toMatchObject({ clean: false, reason: 'not-plain-text' });
    expect(seen.calls).toBe(0);
  });

  it('is not clean when the case file is not valid UTF-8', async () => {
    const { r } = await withCaseFile(
      Buffer.concat([Buffer.from(patchedText()), Buffer.from([0xc3, 0x28])]),
    );
    expect(r).toMatchObject({ clean: false, reason: 'not-plain-text' });
  });

  it('is not clean when the case file is over 1 MB', async () => {
    const pad = `// ${'x'.repeat(100)}\n`.repeat(10_000);
    const { r, seen } = await withCaseFile(patchedText() + pad);
    expect(Buffer.byteLength(patchedText() + pad)).toBeGreaterThan(1_000_000);
    expect(r).toMatchObject({ clean: false, reason: 'not-plain-text' });
    expect(seen.calls).toBe(0);
  });

  it('is not clean when the case file looks minified (a line over the cap)', async () => {
    const { r } = await withCaseFile(`${patchedText()}var a=${'1+'.repeat(3000)}1;\n`);
    expect(r).toMatchObject({ clean: false, reason: 'not-plain-text' });
  });

  it('refuses the same control bytes as classifyHead, for every byte value in the head', () => {
    for (let b = 0; b <= 0xff; b++) {
      const head = Buffer.concat([
        Buffer.from('const a = 1;'),
        Buffer.from([b]),
        Buffer.from('\n'),
      ]);
      const theirs = classifyHead('routes.js', head) !== undefined;
      // A lone byte of 0x80 or more is invalid UTF-8, which classifyHead and plainText's decoder
      // both refuse; NUL is refused by both. Everything else is the control-byte rule.
      const ours = b === 0 || b >= 0x80 || hasOddControlByte(Uint8Array.of(b));
      expect({ b, refused: ours }).toEqual({ b, refused: theirs });
    }
  });

  it('is not clean when a control byte sits after the first 8192 bytes', async () => {
    const text = `${patchedText()}${`// ${'x'.repeat(60)}\n`.repeat(200)}\u0001\n`;
    expect(text.indexOf('\u0001')).toBeGreaterThan(8192);
    const { r, seen } = await withCaseFile(text);
    expect(r).toMatchObject({ clean: false, reason: 'not-plain-text' });
    expect(seen.calls).toBe(0);
  });

  it('is not clean when the case file holds a control byte', async () => {
    const { r } = await withCaseFile(`${patchedText()}\u0001\n`);
    expect(r).toMatchObject({ clean: false, reason: 'not-plain-text' });
  });

  it('is not clean after a case-only rename, judged by the exact directory listing', async () => {
    const { tree, seen, deps } = setup('patched');
    // What a case-insensitive host shows after `routes.js` became `Routes.js`: lstat still finds
    // `routes.js`, the listing does not.
    const listDir = (d: string): string[] =>
      readdirSync(d).map((n) => (n === 'routes.js' ? 'Routes.js' : n));
    const r = await rescanPatchedTree(
      { ...deps(replay('patched', seen)), listDir },
      whereCase,
      tree,
    );
    expect(r).toMatchObject({ clean: false, reason: 'file-missing' });
    expect(seen.calls).toBe(0);
    // The same listing without the rename is clean.
    const ok = await rescanPatchedTree(
      { ...deps(replay('patched', seen)), listDir: (d) => readdirSync(d) },
      whereCase,
      tree,
    );
    expect(ok.clean).toBe(true);
  });

  it('refuses a tree past the copy limits without scanning it', async () => {
    const { tree, workRoot, seen, deps } = setup('patched');
    const files = await rescanPatchedTree(
      { ...deps(replay('patched', seen)), limits: { maxFiles: 2 } },
      whereCase,
      tree,
    );
    expect(files).toMatchObject({ clean: false, reason: 'tree-too-large' });
    const bytes = await rescanPatchedTree(
      { ...deps(replay('patched', seen)), limits: { maxBytes: 100 } },
      whereCase,
      tree,
    );
    expect(bytes).toMatchObject({ clean: false, reason: 'tree-too-large' });
    expect(seen.calls).toBe(0);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it('logs a failed cleanup and keeps the scan outcome, clean or not', async () => {
    const logs: string[] = [];
    const failingRm = (): void => {
      throw new Error('EBUSY');
    };
    const patched = setup('patched');
    const clean = await rescanPatchedTree(
      {
        ...patched.deps(replay('patched', patched.seen)),
        removeDir: failingRm,
        log: (m) => logs.push(m),
      },
      whereCase,
      patched.tree,
    );
    expect(clean).toMatchObject({ clean: true, reason: 'clean' });
    const vulnerable = setup('vulnerable');
    const dirty = await rescanPatchedTree(
      {
        ...vulnerable.deps(replay('vulnerable', vulnerable.seen)),
        removeDir: failingRm,
        log: (m) => logs.push(m),
      },
      whereCase,
      vulnerable.tree,
    );
    expect(dirty).toMatchObject({ clean: false, reason: 'finding-present' });
    // A scan that throws still throws.
    const failed = setup('patched');
    await expect(
      rescanPatchedTree(
        {
          ...failed.deps(replay('patched', failed.seen, undefined, 2)),
          removeDir: failingRm,
          log: (m) => logs.push(m),
        },
        whereCase,
        failed.tree,
      ),
    ).rejects.toThrow();
    expect(logs).toEqual(Array(3).fill('re-scan cleanup failed (Error)'));
    expect(logs.join('')).not.toContain(patched.workRoot);
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
