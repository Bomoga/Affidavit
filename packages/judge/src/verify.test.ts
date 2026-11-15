import { describe, expect, it } from 'vitest';
import { VerifyResult } from '@affidavit/contracts';
import type { Exhibit, ParamSpace, PatchExhibit, Witness } from '@affidavit/contracts';
import type { ExecutionRequest, RawAttempt } from './executor.js';
import { Judge } from './judge.js';
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

describe('Judge.verifyPatch', () => {
  it('accepts the gate patch: the whole family flips and every check holds', async () => {
    const { exec, workbench, rescan, verify } = setup();
    const r = await verify();
    expect(VerifyResult.parse(r)).toEqual({
      schemaVersion: 1,
      patchExhibitId: 'exhibit-patch-001',
      familyFlipped: true,
      suitePassed: true,
      rescanClean: true,
      counterexamples: [{ exhibitId: 'exhibit-counter-001', survived: false }],
    });
    expect(exec.requests.map((q) => `${q.variant}:${q.attempt}:${q.template}`)).toEqual([
      'vulnerable:1:witness source',
      'vulnerable:2:witness source',
      'vulnerable:3:witness source',
      'patched:1:witness source',
      'patched:2:witness source',
      'patched:3:witness source',
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
      counterexamples: [{ exhibitId: 'exhibit-counter-001', survived: true }],
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

  it('rejects with counterexample-survives and fails closed on a broken counterexample', async () => {
    const { verify } = setup((req) =>
      raw(PAYLOADS.map(() => req.variant === 'vulnerable' || req.template === 'still works')),
    );
    const r = await verify(patchExhibit(), [
      counterexample(),
      counterexample({ id: 'exhibit-counter-002' as never, code: 'still works' }),
      counterexample({ id: 'exhibit-counter-003' as never, caseId: 'case-other' as never }),
    ]);
    expect(r.rejectedBy).toBe('counterexample-survives');
    expect(r.counterexamples).toEqual([
      { exhibitId: 'exhibit-counter-001', survived: false },
      { exhibitId: 'exhibit-counter-002', survived: true },
      { exhibitId: 'exhibit-counter-003', survived: true },
    ]);
  });

  it('counts a counterexample that never completes as surviving', async () => {
    const { verify } = setup((req) =>
      req.template === 'counterexample source'
        ? raw([], { exitCode: null, timedOut: true, artifact: null })
        : fixedByPatch(req),
    );
    expect((await verify()).counterexamples).toEqual([
      { exhibitId: 'exhibit-counter-001', survived: true },
    ]);
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
});
