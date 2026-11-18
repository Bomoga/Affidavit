import { describe, expect, it } from 'vitest';
import { VerifyResult } from '@affidavit/contracts';
import type { Exhibit, ParamSpace, PatchExhibit, Witness } from '@affidavit/contracts';
import { canonicalJson } from './canonical.js';
import type { ExecutionRequest, RawAttempt } from './executor.js';
import { Judge, counterexampleExhibitId, patchExhibitId } from './judge.js';
import { parseUnifiedDiff, renderDiff } from './patch/diff.js';
import { DEFAULT_POLICY } from './rules.js';
import {
  GATE_PATCH_DIFF,
  PATCHED,
  RecordingRescan,
  ScriptedExecutor,
  ScriptedWorkbench,
  gateCaseFile,
  gateWitness,
  patchExhibit,
  raw,
} from './test-helpers.js';

const PAYLOADS = ["1'; return true; var x='", "0' || '1'=='1", "'; sleep(5000); '"];
const PARAMS: ParamSpace = [{ name: 'threshold', values: PAYLOADS }];
const witness = (): Witness => ({ ...gateWitness(), template: 'witness source', params: PARAMS });

const counterexample = (over: Partial<Exhibit> = {}): Exhibit =>
  ({
    schemaVersion: 1,
    id: 'exhibit-counter-001',
    caseId: 'case-nodegoat-sqli-001',
    author: 'prosecution',
    kind: 'counterexample',
    code: 'counterexample source',
    sha256: '9'.repeat(64),
    ...over,
  }) as Exhibit;

/** A target where the bug is real and the patch fixes it for every parameter. */
const fixedByPatch = (req: ExecutionRequest): RawAttempt =>
  raw(PAYLOADS.map(() => req.variant === 'vulnerable'));

function setup(
  answer: (req: ExecutionRequest) => RawAttempt = fixedByPatch,
  wb: ConstructorParameters<typeof ScriptedWorkbench>[0] = {},
  rescanClean = true,
) {
  const exec = new ScriptedExecutor(answer);
  const workbench = new ScriptedWorkbench(wb);
  const rescan = new RecordingRescan(rescanClean);
  const judge = new Judge(exec, DEFAULT_POLICY, { workbench, rescan });
  const verify = (patch: PatchExhibit = patchExhibit(), counters: Exhibit[] = [counterexample()]) =>
    judge.verifyPatch(gateCaseFile(), patch, witness(), counters);
  return { exec, workbench, rescan, verify };
}

/** A diff that adds `lines` to one file. */
const addLines = (lines: string[], path = 'app/data/allocations-dao.js'): string =>
  [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -70,1 +70,${lines.length + 1} @@`,
    '         const searchCriteria = () => {',
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');

/** A diff that creates `path` with `lines`. */
const newFile = (path: string, lines: string[]) =>
  [
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');

/** The id the Judge mints for a counterexample run over the witness's family. */
const cid = (c: Exhibit = counterexample()) => counterexampleExhibitId(c, PARAMS);
const PATCH_ID = patchExhibitId(patchExhibit());

describe('Judge.verifyPatch', () => {
  it('accepts the gate patch: the whole family flips and every check holds', async () => {
    const { exec, workbench, rescan, verify } = setup();
    const r = await verify();
    expect(VerifyResult.parse(r)).toEqual({
      schemaVersion: 1,
      patchExhibitId: PATCH_ID,
      familyFlipped: true,
      suitePassed: true,
      rescanClean: true,
      counterexamples: [{ exhibitId: cid(), survived: false }],
    });
    expect(exec.requests.map((q) => `${q.variant}:${q.attempt}:${q.template}`)).toEqual([
      'vulnerable:1:witness source',
      'vulnerable:2:witness source',
      'vulnerable:3:witness source',
      'patched:1:witness source',
      'patched:2:witness source',
      'patched:3:witness source',
      // The counterexample is admitted first, on vulnerable and safe, then rerun on the patch.
      'vulnerable:1:counterexample source',
      'vulnerable:2:counterexample source',
      'vulnerable:3:counterexample source',
      'safe:1:counterexample source',
      'safe:2:counterexample source',
      'safe:3:counterexample source',
      'patched:1:counterexample source',
      'patched:2:counterexample source',
      'patched:3:counterexample source',
    ]);
    expect(exec.requests.filter((q) => q.variant === 'patched').map((q) => q.target)).toEqual(
      new Array(6).fill(PATCHED.target),
    );
    expect(exec.requests.every((q) => q.params === PARAMS || q.params.length === 1)).toBe(true);
    expect(workbench.suiteRuns).toBe(1);
    expect(workbench.released).toBe(1);
    expect(rescan.paths).toEqual([PATCHED.workspacePath]);
  });

  it('rejects a patch that special-cases one witness value with literal-only-patch, before building', async () => {
    const { exec, workbench, verify } = setup();
    const r = await verify(
      patchExhibit(
        addLines([`            if (threshold === "0' || '1'=='1") throw new Error('blocked');`]),
      ),
    );
    expect(r).toMatchObject({
      rejectedBy: 'literal-only-patch',
      familyFlipped: false,
      counterexamples: [{ exhibitId: cid(), survived: true }],
    });
    expect(workbench.prepared).toHaveLength(0);
    expect(exec.requests).toHaveLength(0);
  });

  it('rejects a special case hidden next to an unrelated change', async () => {
    const { verify } = setup();
    const lines = [
      `            const parsedThreshold = parseInt(threshold, 10);`,
      `            if (["1'; return true; var x='"].includes(threshold)) return {};`,
    ];
    expect((await verify(patchExhibit(addLines(lines)))).rejectedBy).toBe('literal-only-patch');
  });

  it('allows a regression test that replays the payload', async () => {
    const test = addLines(
      [`expect(await search("0' || '1'=='1")).toEqual([]);`],
      'test/sqli.test.js',
    )
      .replace('--- a/test/sqli.test.js', '--- /dev/null')
      .replace('@@ -70,1 +70,2 @@\n         const searchCriteria = () => {', '@@ -0,0 +1,1 @@');
    const { verify } = setup();
    const r = await verify(patchExhibit(GATE_PATCH_DIFF + test));
    expect(r.rejectedBy).toBeUndefined();
    expect(r.familyFlipped).toBe(true);
  });

  it('rejects an oversized patch with diff-too-large, before building', async () => {
    const { workbench, verify } = setup();
    const big = Array.from(
      { length: DEFAULT_POLICY.maxPatchLinesChanged + 1 },
      (_, i) => `// ${i}`,
    );
    expect((await verify(patchExhibit(addLines(big)))).rejectedBy).toBe('diff-too-large');
    const files = Array.from({ length: DEFAULT_POLICY.maxPatchFiles + 1 }, (_, i) =>
      addLines(['x();'], `src/f${i}.js`),
    ).join('');
    expect((await verify(patchExhibit(files))).rejectedBy).toBe('diff-too-large');
    expect(workbench.prepared).toHaveLength(0);
  });

  it('counts the diff itself, not what the author declared', async () => {
    const { workbench, verify } = setup();
    expect((await verify(patchExhibit(GATE_PATCH_DIFF, { linesChanged: 1 }))).rejectedBy).toBe(
      'schema',
    );
    expect(
      (await verify(patchExhibit(GATE_PATCH_DIFF, { filesTouched: ['README.md'] }))).rejectedBy,
    ).toBe('schema');
    expect(workbench.prepared).toHaveLength(0);
  });

  it.each([
    ['an unreadable diff', patchExhibit('--- a/x.js\n+++ b/x.js\n')],
    ['a diff touching .git', patchExhibit(addLines(['x'], '.git/hooks/post-checkout'))],
    ['a patch for another case', patchExhibit(GATE_PATCH_DIFF, { caseId: 'case-other' as never })],
    ['a patch not written by Remedy', patchExhibit(GATE_PATCH_DIFF, { author: 'defense' })],
    ['a witness kind instead of a patch', { ...patchExhibit(), kind: 'witness' } as never],
  ])('rejects %s with schema', async (_, patch) => {
    const { workbench, verify } = setup();
    const r = await verify(patch);
    expect(r.rejectedBy).toBe('schema');
    expect(workbench.prepared).toHaveLength(0);
  });

  it('rejects a patch that does not apply (schema) or does not build (suite-fails)', async () => {
    for (const [stage, rule] of [
      ['apply', 'schema'],
      ['build', 'suite-fails'],
    ] as const) {
      const { exec, workbench, verify } = setup(fixedByPatch, {
        prepare: { ok: false, stage, detail: 'scripted' },
      });
      expect((await verify()).rejectedBy).toBe(rule);
      expect(exec.requests).toHaveLength(0);
      expect(workbench.released).toBe(0);
    }
  });

  it('does not flip when one parameter still passes on the patch (differential)', async () => {
    const { verify } = setup((req) =>
      raw(PAYLOADS.map((_, i) => req.variant === 'vulnerable' || i === 2)),
    );
    const r = await verify();
    expect(r).toMatchObject({ familyFlipped: false, rejectedBy: 'differential' });
    expect(r.suitePassed).toBe(true);
  });

  it('does not flip when the witness no longer passes on the vulnerable commit', async () => {
    const { verify } = setup(() => raw(PAYLOADS.map(() => false)));
    expect(await verify()).toMatchObject({ familyFlipped: false, rejectedBy: 'differential' });
  });

  it('holds patched runs to the same rules as witness runs', async () => {
    const egress = setup((req) =>
      req.variant === 'patched'
        ? raw([false, false, false], { egressAttempts: 1 })
        : fixedByPatch(req),
    );
    expect((await egress.verify()).rejectedBy).toBe('no-egress');
    let n = 0;
    const flaky = setup((req) =>
      req.variant === 'patched' && req.template === 'witness source'
        ? raw([false, false, n++ === 1])
        : fixedByPatch(req),
    );
    expect((await flaky.verify()).rejectedBy).toBe('stable-3of3');
  });

  it('rejects with suite-fails when the target suite fails', async () => {
    const { verify } = setup(fixedByPatch, { suitePassed: false });
    expect(await verify()).toMatchObject({
      familyFlipped: true,
      suitePassed: false,
      rejectedBy: 'suite-fails',
    });
  });

  it('reports an unavailable suite without holding it against the patch', async () => {
    const reason = 'the suite cannot be built: node_modules/x resolves outside the npm registry';
    const { workbench } = setup(fixedByPatch, { suiteUnavailable: reason });
    const judge = new Judge(new ScriptedExecutor(fixedByPatch), DEFAULT_POLICY, {
      workbench,
      rescan: new RecordingRescan(),
    });
    const report = await judge.verifyPatchReport(gateCaseFile(), patchExhibit(), witness(), []);
    expect(report.suite).toEqual({ state: 'unavailable', reason });
    // Never reported as passed, and no rejection for it.
    expect(report.result).toMatchObject({ familyFlipped: true, suitePassed: false });
    expect(report.result.rejectedBy).toBeUndefined();
    expect(await judge.verifyPatch(gateCaseFile(), patchExhibit(), witness(), [])).toEqual(
      report.result,
    );
  });

  it('still rejects failing patch tests when the suite is unavailable', async () => {
    const test = newFile('test/sqli.test.js', [`it('blocks', () => get("0' || '1'=='1"));`]);
    const { verify } = setup(fixedByPatch, {
      suiteUnavailable: 'no suite',
      addedTestsPassed: false,
    });
    expect((await verify(patchExhibit(GATE_PATCH_DIFF + test))).rejectedBy).toBe('suite-fails');
  });

  it('says the suite did not run when the patch is refused before building', async () => {
    const { workbench } = setup();
    const judge = new Judge(new ScriptedExecutor(fixedByPatch), DEFAULT_POLICY, {
      workbench,
      rescan: new RecordingRescan(),
    });
    const big = patchExhibit(addLines(Array.from({ length: 150 }, (_, i) => `// ${i}`)));
    const report = await judge.verifyPatchReport(gateCaseFile(), big, witness(), []);
    expect(report).toMatchObject({
      suite: { state: 'not-run' },
      result: { rejectedBy: 'diff-too-large' },
    });
  });

  it('rejects with counterexample-survives only for an admissible counterexample', async () => {
    // `still works` beats the patch; `passes everywhere` also passes on the safe variant, so it
    // proves nothing and must not count against the patch.
    const { exec, verify } = setup((req) =>
      raw(
        PAYLOADS.map(() =>
          req.template === 'passes everywhere'
            ? true
            : req.variant === 'vulnerable' ||
              (req.variant === 'patched' && req.template === 'still works'),
        ),
      ),
    );
    const survivor = counterexample({ id: 'exhibit-counter-002' as never, code: 'still works' });
    const unproven = counterexample({ code: 'passes everywhere' });
    const otherCase = counterexample({ caseId: 'case-other' as never });
    const malformed = { kind: 'counterexample', code: 1 } as unknown as Exhibit;
    const r = await verify(patchExhibit(), [
      counterexample(),
      survivor,
      unproven,
      otherCase,
      malformed,
    ]);
    expect(r.rejectedBy).toBe('counterexample-survives');
    expect(r.counterexamples.slice(0, 4)).toEqual([
      { exhibitId: cid(), survived: false },
      { exhibitId: cid(survivor), survived: true },
      { exhibitId: cid(unproven), survived: false },
      { exhibitId: cid(otherCase), survived: false },
    ]);
    expect(r.counterexamples[4]?.exhibitId).toMatch(/^exhibit-counterexample-invalid-/);
    expect(r.counterexamples[4]?.survived).toBe(false);
    // An inadmissible counterexample is never rerun on the patch.
    expect(
      exec.requests.some((q) => q.template === 'passes everywhere' && q.variant === 'patched'),
    ).toBe(false);
  });

  it('never echoes a submitted counterexample id', async () => {
    const { verify } = setup();
    const c = counterexample({ id: 'exhibit-counterexample-chosen-by-caller' as never });
    const [out] = (await verify(patchExhibit(), [c])).counterexamples;
    expect(out?.exhibitId).toBe(cid(c));
    expect(out?.exhibitId).not.toBe(c.id);
    expect(out?.exhibitId).toMatch(/^exhibit-counterexample-[0-9a-f]{24}$/);
  });

  it('accepts a patch when the only counterexample is inadmissible', async () => {
    const { verify } = setup((req) =>
      req.template === 'counterexample source'
        ? raw([], { exitCode: null, timedOut: true, artifact: null })
        : fixedByPatch(req),
    );
    const r = await verify();
    expect(r.counterexamples).toEqual([{ exhibitId: cid(), survived: false }]);
    expect(r.rejectedBy).toBeUndefined();
  });

  it('counts an admissible counterexample that never completes on the patch as surviving', async () => {
    const { verify } = setup((req) =>
      req.template === 'counterexample source' && req.variant === 'patched'
        ? raw([], { exitCode: null, timedOut: true, artifact: null })
        : fixedByPatch(req),
    );
    const r = await verify();
    expect(r.counterexamples).toEqual([{ exhibitId: cid(), survived: true }]);
    expect(r.rejectedBy).toBe('counterexample-survives');
  });

  it('reports a dirty re-scan as rescanClean false', async () => {
    const { verify } = setup(fixedByPatch, {}, false);
    const r = await verify();
    expect(r).toMatchObject({ familyFlipped: true, suitePassed: true, rescanClean: false });
  });

  it('releases the patched target even when the executor fails', async () => {
    const { workbench, verify } = setup(() => {
      throw new Error('docker went away');
    });
    await expect(verify()).rejects.toThrow('docker went away');
    expect(workbench.released).toBe(1);
  });

  it('refuses a workbench that hands back the wrong target', async () => {
    const { workbench, verify } = setup(fixedByPatch, {
      prepare: {
        ok: true,
        prepared: { ...PATCHED, target: { ...PATCHED.target, variant: 'vulnerable' } },
      },
    });
    await expect(verify()).rejects.toThrow(/not the patched/);
    expect(workbench.released).toBe(1);
  });

  it('needs a workbench and a re-scan port', async () => {
    const judge = new Judge(new ScriptedExecutor(fixedByPatch));
    await expect(judge.verifyPatch(gateCaseFile(), patchExhibit(), witness(), [])).rejects.toThrow(
      /PatchWorkbench/,
    );
  });

  describe('patch exhibit id', () => {
    it('is minted from the case and diff, never echoed', async () => {
      const { verify } = setup();
      const r = await verify(patchExhibit(GATE_PATCH_DIFF, { id: 'exhibit-patch-mine' as never }));
      expect(r.patchExhibitId).toBe(PATCH_ID);
      expect(r.patchExhibitId).toMatch(/^exhibit-patch-[0-9a-f]{24}$/);
      expect(patchExhibitId({ caseId: 'case-other' as never, diff: GATE_PATCH_DIFF })).not.toBe(
        PATCH_ID,
      );
    });

    it('matches the documented test vector and the recipe Lane 3 uses', () => {
      // rules-of-evidence.md, "Patch exhibit ids".
      expect(canonicalJson({ caseId: 'case-x', diff: 'd', kind: 'patch' })).toBe(
        '{"caseId":"case-x","diff":"d","kind":"patch"}',
      );
      expect(patchExhibitId({ caseId: 'case-x' as never, diff: 'd' })).toBe(
        'exhibit-patch-4252faa67f9f45500b6a7ce8',
      );
    });

    it.each([
      ['a sha256 that is not the hash of the diff', { sha256: '0'.repeat(64) }],
      ['a code field that differs from the diff', { code: 'something else' }],
    ])('rejects %s with schema, before building', async (_, over) => {
      const { workbench, verify } = setup();
      const r = await verify(patchExhibit(GATE_PATCH_DIFF, over));
      expect(r).toMatchObject({ rejectedBy: 'schema', patchExhibitId: PATCH_ID });
      expect(workbench.prepared).toHaveLength(0);
    });
  });

  describe('test files in the patch', () => {
    /** The gate patch plus one more line in allocations-dao.js. */
    const gateWith = (line: string) =>
      GATE_PATCH_DIFF.replace('@@ -70,5 +70,6 @@', '@@ -70,5 +70,7 @@').replace(
        '        const searchCriteria = () => {\n',
        `        const searchCriteria = () => {\n+${line}\n`,
      );

    it('builds the witness target without the test files; the suite gets the whole patch', async () => {
      const test = newFile('test/sqli.test.js', [`it('blocks', () => get("0' || '1'=='1"));`]);
      const { workbench, verify } = setup();
      const r = await verify(patchExhibit(GATE_PATCH_DIFF + test));
      expect(r.rejectedBy).toBeUndefined();
      const [plan] = workbench.plans;
      expect(plan?.full.files.map((f) => f.path)).toEqual([
        'app/data/allocations-dao.js',
        'test/sqli.test.js',
      ]);
      expect(plan?.code.files.map((f) => f.path)).toEqual(['app/data/allocations-dao.js']);
      expect(renderDiff(plan?.code ?? { files: [], linesChanged: 0 })).toBe(GATE_PATCH_DIFF);
    });

    it.each([
      `            require('../../test/guard.test.js')(threshold);`,
      `            require('./guard.test.js');`,
      `            const guard = require("../../test/guard.test");`,
    ])('rejects code that loads a test file from the same patch: %s', async (line) => {
      // The special case sits in an exempt test file; the code only loads it.
      const guard = newFile('test/guard.test.js', [
        `module.exports = (t) => { if (t === "0' || '1'=='1") throw new Error('x'); };`,
      ]);
      const { workbench, verify } = setup();
      const r = await verify(patchExhibit(gateWith(line) + guard));
      expect(r.rejectedBy).toBe('literal-only-patch');
      expect(workbench.prepared).toHaveLength(0);
    });

    it('refuses a *.test.js file next to the code: it is not exempt, and a runner could pick it up', async () => {
      const guard = newFile('app/data/guard.test.js', [
        `module.exports = (t) => t === "0' || '1'=='1";`,
      ]);
      const { workbench, verify } = setup();
      expect((await verify(patchExhibit(GATE_PATCH_DIFF + guard))).rejectedBy).toBe('suite-fails');
      expect(workbench.prepared).toHaveLength(0);
    });

    // Re-review B-1: a section's names must be exactly what git writes, or the Judge and
    // `git apply -p1` read different files.
    it.each([
      [
        'deletes test/a.js under a z/ name',
        'diff --git a/z/test/a.js b/z/test/a.js\n--- z/test/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-it("x", f);\n',
      ],
      [
        'edits src/app.js under a test/ name',
        'diff --git a/test/src/app.js b/test/src/app.js\n--- test/src/app.js\n+++ test/src/app.js\n@@ -1 +1,2 @@\n x\n+globalThis.__ok = true;\n',
      ],
      ['has a section with no diff --git header', '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n'],
    ])('rejects a patch that %s with schema, before building', async (_, extra) => {
      const { workbench, verify } = setup();
      const r = await verify(patchExhibit(GATE_PATCH_DIFF + extra, {}, { raw: true }));
      expect(r.rejectedBy).toBe('schema');
      expect(workbench.prepared).toHaveLength(0);
    });

    it('rejects the deny-everything chain: a guard in code, its key set from a fake test path', async () => {
      // Section 1 (code, in the witness build) refuses everything unless a flag is set; section 2
      // claims to be a test file but git -p1 writes it to src/app.js, which only the suite saw.
      const chain =
        'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1,2 @@\n x\n+if (!globalThis.__ok) deny();\n' +
        'diff --git a/test/src/app.js b/test/src/app.js\n--- test/src/app.js\n+++ test/src/app.js\n@@ -2 +2,2 @@\n y\n+globalThis.__ok = true;\n';
      const { workbench, verify } = setup();
      expect((await verify(patchExhibit(chain, {}, { raw: true }))).rejectedBy).toBe('schema');
      expect(workbench.prepared).toHaveLength(0);
    });

    it('fails apply (schema) when git apply --numstat disagrees with the Judge', async () => {
      const { workbench, verify } = setup(undefined, {
        // What git would print if it read a path the Judge did not.
        numstat: () => '2\t1\tsrc/other.js\n',
      });
      const r = await verify();
      expect(r.rejectedBy).toBe('schema');
      expect(workbench.prepared).toHaveLength(1);
      expect(workbench.suiteRuns).toBe(0);
    });

    it('passes the numstat check when git and the Judge agree', async () => {
      const gate = parseUnifiedDiff(GATE_PATCH_DIFF);
      if (!gate.ok) throw new Error(gate.reason);
      const numstat = gate.diff.files
        .map((f) => `${f.added.length}\t${f.removed.length}\t${f.path}\n`)
        .join('');
      const { verify } = setup(undefined, { numstat: () => numstat });
      expect((await verify()).rejectedBy).toBeUndefined();
    });

    it('runs the suite on the code build and the patch tests only as an extra check', async () => {
      const test = newFile('test/sqli.test.js', [`it('blocks', () => get("0' || '1'=='1"));`]);
      const passing = setup(undefined, { addedTestsPassed: true });
      expect(
        (await passing.verify(patchExhibit(GATE_PATCH_DIFF + test))).rejectedBy,
      ).toBeUndefined();
      expect(passing.workbench.addedTestRuns).toBe(1);
      expect(passing.workbench.plans[0]?.tests.files.map((f) => f.path)).toEqual([
        'test/sqli.test.js',
      ]);

      const failing = setup(undefined, { addedTestsPassed: false });
      expect(await failing.verify(patchExhibit(GATE_PATCH_DIFF + test))).toMatchObject({
        rejectedBy: 'suite-fails',
        suitePassed: false,
      });

      // A pass is never required: a workbench that does not run them (null) is fine.
      const skipped = setup(undefined, { addedTestsPassed: null });
      expect(
        (await skipped.verify(patchExhibit(GATE_PATCH_DIFF + test))).rejectedBy,
      ).toBeUndefined();

      // No patch tests: the extra check is not asked for.
      const none = setup();
      await none.verify();
      expect(none.workbench.addedTestRuns).toBe(0);
    });

    it('rejects suite-fails when the own suite fails even if the added tests pass', async () => {
      const test = newFile('test/sqli.test.js', [`it('ok', () => {});`]);
      const { verify } = setup(undefined, { suitePassed: false, addedTestsPassed: true });
      expect((await verify(patchExhibit(GATE_PATCH_DIFF + test))).rejectedBy).toBe('suite-fails');
    });

    it('maps a workbench suite-config refusal to suite-fails', async () => {
      const { verify } = setup(undefined, {
        prepare: { ok: false, stage: 'suite', detail: 'changes "scripts" in package.json' },
      });
      expect((await verify()).rejectedBy).toBe('suite-fails');
    });

    it.each([
      ['deletes a test file', '--- a/test/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-it("x", f);\n'],
      [
        'removes a line from a test file',
        '--- a/test/a.js\n+++ b/test/a.js\n@@ -1,2 +1,1 @@\n keep();\n-it("blocks sqli", f);\n',
      ],
      [
        'rewrites the test script',
        '--- a/package.json\n+++ b/package.json\n@@ -1,2 +1,2 @@\n {\n-  "test": "grunt test",\n+  "test": "true",\n',
      ],
    ])('rejects a patch that %s with suite-fails, before building', async (_, extra) => {
      const { workbench, verify } = setup();
      const r = await verify(patchExhibit(GATE_PATCH_DIFF + extra));
      expect(r).toMatchObject({ rejectedBy: 'suite-fails', suitePassed: false });
      expect(workbench.prepared).toHaveLength(0);
    });
  });

  it('accepts an authorization fix that compares with -1 when 1 is a parameter', async () => {
    const ids: ParamSpace = [{ name: 'userId', values: [1, 2] }];
    const exec = new ScriptedExecutor((req) =>
      raw(ids[0]!.values.map(() => req.variant === 'vulnerable')),
    );
    const workbench = new ScriptedWorkbench();
    const judge = new Judge(exec, DEFAULT_POLICY, { workbench, rescan: new RecordingRescan() });
    const diff = addLines([
      `            if (req.session.allowed.indexOf(userId) === -1) return res.status(403).end();`,
    ]);
    const r = await judge.verifyPatch(
      gateCaseFile(),
      patchExhibit(diff),
      { ...gateWitness(), template: 'witness source', params: ids },
      [],
    );
    expect(r.rejectedBy).toBeUndefined();
    expect(r.familyFlipped).toBe(true);
  });
});
