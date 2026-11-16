import { describe, expect, it } from 'vitest';
import {
  ExhibitResult,
  samples,
  type CaseFile,
  type CaseStage,
  type ExhibitId,
  type VerifyResult,
  type Witness,
} from '@affidavit/contracts';
import { renderPrompt } from '@affidavit/prompts';
import { FakeCaseFileSource, FakeEventSink, FakeJudge, ReplayModel } from '@affidavit/testing';
import { buildPatchExhibit, createRemedyHandler, type RemedyConfig } from './remedy.js';
import { Orchestrator, type ModelTurnResult, type StageHandler } from './orchestrator.js';
import {
  BIG_BUDGET,
  LoggingCaseStore,
  NOW,
  PATH_TO,
  assertSchemaValid,
  inOrder,
  makeCaseFile,
  openAt,
  turnCost,
} from './test-support.js';
import { InMemoryWorkspace } from './workspace.js';

const CF: CaseFile = makeCaseFile();
const CASE = CF.id;
const witness: Witness = {
  ...(samples.Witness as Witness),
  caseId: CASE,
};

const diffFor = (n: number): string =>
  `--- a/routes/a.js\n+++ b/routes/a.js\n@@ -1 +1 @@\n-q(id${n})\n+q(?, [id${n}])\n`;
const shaOf = (n: number): string => buildPatchExhibit(CASE, diffFor(n))!.sha256;
const idOf = (n: number): ExhibitId => buildPatchExhibit(CASE, diffFor(n))!.id;

const patch = (n: number, extra: object = {}): ModelTurnResult => ({
  outcome: 'submitted',
  submission: { diff: diffFor(n), ...extra },
  cost: turnCost('remedy'),
});
const none: ModelTurnResult = { outcome: 'no-submission', cost: turnCost('remedy') };

const good = (n: number): VerifyResult => ({
  schemaVersion: 1,
  patchExhibitId: idOf(n),
  familyFlipped: true,
  suitePassed: true,
  rescanClean: true,
  counterexamples: [],
});
const bad = (n: number, rejectedBy: VerifyResult['rejectedBy']): VerifyResult => ({
  ...good(n),
  familyFlipped: rejectedBy !== 'literal-only-patch',
  suitePassed: rejectedBy !== 'suite-fails',
  rejectedBy,
});

const config: RemedyConfig = {
  promptId: 'remedy',
  model: 'model-a',
  maxIterations: 2,
  maxTurns: 3,
  turnBudget: { maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: 0.1 },
};

async function run(
  modelScript: ModelTurnResult[],
  verifyScript: Record<string, VerifyResult>,
  opts: { withWitness?: boolean } = {},
) {
  const log: string[] = [];
  const store = new LoggingCaseStore(log);
  await openAt(store, CF, BIG_BUDGET, PATH_TO.remedy);
  const sink = new FakeEventSink();
  const model = new ReplayModel(inOrder(modelScript));
  const judge = new FakeJudge({
    witnessResults: { [witness.sha256]: ExhibitResult.parse(samples.ExhibitResult) },
    verifyResults: verifyScript,
  });
  const workspace = new InMemoryWorkspace();
  if (opts.withWitness !== false) {
    await workspace.saveWitness(CASE, {
      witness,
      result: ExhibitResult.parse(samples.ExhibitResult),
    });
  }
  const next = (to: CaseStage): StageHandler => ({
    run: () => Promise.resolve({ kind: 'advance', next: to }),
  });
  const orch = new Orchestrator({
    store,
    sink,
    model,
    handlers: {
      remedy: createRemedyHandler({
        caseFiles: new FakeCaseFileSource([CF]),
        judge,
        render: renderPrompt,
        workspace,
        config,
      }),
      verify: next('jury'),
      jury: next('verdict'),
    },
    config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
  });
  return {
    orch,
    store,
    sink,
    model,
    judge,
    workspace,
    events: () => assertSchemaValid(sink.events(CASE)),
  };
}

describe('buildPatchExhibit', () => {
  it('computes files touched and lines changed from the diff, not from the agent', () => {
    const p = buildPatchExhibit(CASE, diffFor(1))!;
    expect(p.filesTouched).toEqual(['routes/a.js']);
    expect(p.linesChanged).toBe(2);
    expect(p.kind).toBe('patch');
    expect(p.author).toBe('remedy');
  });

  it('refuses a diff that names no file or changes no line', () => {
    expect(buildPatchExhibit(CASE, 'just prose')).toBeUndefined();
    expect(buildPatchExhibit(CASE, '--- a/x.js\n+++ b/x.js\n')).toBeUndefined();
  });

  it('gives the same id and hash for the same diff, and different ones for different diffs', () => {
    expect(buildPatchExhibit(CASE, diffFor(1))!.id).toBe(buildPatchExhibit(CASE, diffFor(1))!.id);
    expect(buildPatchExhibit(CASE, diffFor(1))!.sha256).not.toBe(shaOf(2));
  });
});

describe('Remedy', () => {
  it('accepts a patch the Judge verifies and moves to verify', async () => {
    const { orch, workspace, judge, model, events } = await run([patch(1)], {
      [shaOf(1)]: good(1),
    });
    expect(await orch.run(CASE)).toEqual({ status: 'terminal', stage: 'verdict' });
    expect(model.requests[0]?.tools).toEqual(['submit_patch']);
    expect(judge.calls.filter((c) => c.method === 'verifyPatch')).toHaveLength(1);
    expect((await workspace.getPatchOutcome(CASE))?.accepted).toBe(true);
    expect(await workspace.getExhibits(CASE)).toContain(idOf(1));
    expect(events().some((e) => e.type === 'exhibit-submitted' && e.payload.kind === 'patch')).toBe(
      true,
    );
  });

  it.each(['literal-only-patch', 'diff-too-large', 'suite-fails'] as const)(
    'rejects for %s, records the rule, and retries with feedback',
    async (rule) => {
      const { orch, model, workspace, events } = await run([patch(1), patch(2)], {
        [shaOf(1)]: bad(1, rule),
        [shaOf(2)]: good(2),
      });
      expect(await orch.run(CASE)).toEqual({ status: 'terminal', stage: 'verdict' });

      const rejection = events().find((e) => e.type === 'exhibit-inadmissible');
      expect(rejection?.payload).toMatchObject({ rejectedBy: rule, exhibitId: idOf(1) });
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.user).toContain('source=judge-feedback');
      expect(model.requests[1]?.user).toContain(rule);
      expect((await workspace.getPatchOutcome(CASE))?.accepted).toBe(true);
    },
  );

  it.each(['literal-only-patch', 'diff-too-large', 'suite-fails'] as const)(
    'moves to verify with a not-accepted outcome when %s persists to the cap',
    async (rule) => {
      const { orch, workspace, events } = await run([patch(1), patch(2)], {
        [shaOf(1)]: bad(1, rule),
        [shaOf(2)]: bad(2, rule),
      });
      expect(await orch.run(CASE)).toEqual({ status: 'terminal', stage: 'verdict' });
      const outcome = await workspace.getPatchOutcome(CASE);
      expect(outcome).toMatchObject({ accepted: false });
      expect(outcome?.result?.rejectedBy).toBe(rule);
      expect(events().some((e) => e.type === 'escalated')).toBe(false);
    },
  );

  it('does not accept a result with an unflipped family even when no rule is named', async () => {
    const weak: VerifyResult = { ...good(1), familyFlipped: false };
    const { orch, workspace } = await run([patch(1), patch(2)], {
      [shaOf(1)]: weak,
      [shaOf(2)]: { ...weak, patchExhibitId: idOf(2) },
    });
    await orch.run(CASE);
    expect((await workspace.getPatchOutcome(CASE))?.accepted).toBe(false);
  });

  it('takes acceptance only from the Judge, not from the agent', async () => {
    const { orch, workspace } = await run(
      [patch(1, { accepted: true, familyFlipped: true }), patch(2, { accepted: true })],
      { [shaOf(1)]: bad(1, 'suite-fails'), [shaOf(2)]: bad(2, 'suite-fails') },
    );
    await orch.run(CASE);
    expect((await workspace.getPatchOutcome(CASE))?.accepted).toBe(false);
  });

  it('records not accepted when the agent submits nothing, without calling the Judge', async () => {
    const { orch, workspace, judge } = await run([none], {});
    expect(await orch.run(CASE)).toEqual({ status: 'terminal', stage: 'verdict' });
    expect(judge.calls.filter((c) => c.method === 'verifyPatch')).toHaveLength(0);
    expect(await workspace.getPatchOutcome(CASE)).toMatchObject({ accepted: false });
  });

  it('records schema failures as inadmissible and feeds them back', async () => {
    const badShape: ModelTurnResult = {
      outcome: 'submitted',
      submission: { prose: 'fixed' },
      cost: turnCost('remedy'),
    };
    const { orch, events, model } = await run([badShape, patch(1)], { [shaOf(1)]: good(1) });
    expect(await orch.run(CASE)).toEqual({ status: 'terminal', stage: 'verdict' });
    expect(events().some((e) => e.type === 'exhibit-inadmissible')).toBe(true);
    expect(model.requests[1]?.user).toContain('diff');
  });

  it('treats a diff that names no file as a schema failure and does not call the Judge', async () => {
    const empty: ModelTurnResult = {
      outcome: 'submitted',
      submission: { diff: 'I rewrote the query' },
      cost: turnCost('remedy'),
    };
    const { orch, judge, model } = await run([empty, patch(1)], { [shaOf(1)]: good(1) });
    await orch.run(CASE);
    expect(judge.calls.filter((c) => c.method === 'verifyPatch')).toHaveLength(1);
    expect(model.requests[1]?.user).toContain('names no file');
  });

  it('shows the agent the admitted witness as untrusted data, with the case slices', async () => {
    const { orch, model } = await run([patch(1)], { [shaOf(1)]: good(1) });
    await orch.run(CASE);
    const user = model.requests[0]?.user ?? '';
    expect(user).toContain('source=witness');
    expect(user).toContain(witness.template);
    expect(user).toContain('source=case-file-slice');
    expect(user.indexOf('<<<BEGIN UNTRUSTED DATA')).toBeLessThan(user.indexOf(witness.template));
  });

  it('fails loudly when no admitted witness was handed over', async () => {
    const { orch } = await run([patch(1)], { [shaOf(1)]: good(1) }, { withWitness: false });
    await expect(orch.run(CASE)).rejects.toThrow(/no admitted witness/);
  });
});
