import { describe, expect, it } from 'vitest';
import type {
  CaseFile,
  CaseStage,
  ModelTurnResult,
  PromptRenderer,
  StageCost,
  VerifyResult,
  WitnessSubmission,
} from './interim/types.js';
import { Orchestrator, type StageHandler } from './orchestrator.js';
import { createRemedyHandler, type RemedyConfig } from './remedy.js';
import {
  FakeCaseStore,
  FakeEventSink,
  FakeJudge,
  FakeModel,
  InMemoryWorkspace,
} from './testing/fakes.js';

const caseFile: CaseFile = {
  id: 'c1',
  escalationFloor: 0.6,
  candidate: { id: 'cand-1', cls: 'injection', score: 0.9 },
  slices: [{ file: 'routes/a.js', code: 'db.query("select * from t where id=" + id)' }],
};
const witness: WitnessSubmission = { template: 'sqli-union', params: { n: 1 } };

const cost: StageCost = {
  stage: 'remedy',
  attempt: 1,
  inputTokens: 10,
  outputTokens: 5,
  usd: 0.01,
  wallMs: 1,
};
const patch = (extra: object = {}): ModelTurnResult => ({
  outcome: 'submitted',
  submission: {
    diff: '--- a\n+++ b\n-q(id)\n+q(?, [id])',
    filesTouched: ['routes/a.js'],
    linesChanged: 2,
    ...extra,
  },
  cost,
});
const none: ModelTurnResult = { outcome: 'no-submission', cost };

const good: VerifyResult = {
  familyFlipped: true,
  suitePassed: true,
  rescanClean: true,
  counterexamples: [],
};
const bad = (rejectedBy: VerifyResult['rejectedBy'], detail = ''): VerifyResult => ({
  familyFlipped: rejectedBy !== 'literal-only-patch',
  suitePassed: rejectedBy !== 'suite-fails',
  rescanClean: true,
  counterexamples: [],
  rejectedBy,
  detail,
});

const render: PromptRenderer = (id, blocks) => ({
  promptId: id,
  version: '1.0.0',
  outputSchemaRef: 'PatchExhibit',
  system: `SYSTEM:${id}`,
  user: blocks.map((b) => `[${b.label}]\n${b.content}`).join('\n'),
});

const config: RemedyConfig = {
  promptId: 'remedy',
  model: 'model-a',
  maxIterations: 2,
  maxTurns: 3,
  turnBudget: { maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: 0.1 },
};

function run(
  modelScript: ModelTurnResult[],
  verifyScript: VerifyResult[],
  opts: { witness?: WitnessSubmission | null } = {},
) {
  const log: string[] = [];
  const store = new FakeCaseStore(log, { usd: 10, tokens: 1_000_000 }, 'remedy');
  const sink = new FakeEventSink();
  const model = new FakeModel(log, modelScript);
  const judge = new FakeJudge([], verifyScript);
  const workspace = new InMemoryWorkspace();
  if (opts.witness !== null) void workspace.saveWitness('c1', opts.witness ?? witness);
  const next = (to: CaseStage): StageHandler => ({
    run: () => Promise.resolve({ kind: 'advance', next: to }),
  });
  const orch = new Orchestrator({
    store,
    sink,
    model,
    validate: (_ref: string, v: unknown) =>
      typeof v === 'object' && v !== null && 'diff' in v
        ? { ok: true }
        : { ok: false, errors: ['missing diff'] },
    handlers: {
      remedy: createRemedyHandler({
        loadCaseFile: () => Promise.resolve(caseFile),
        judge,
        render,
        workspace,
        config,
      }),
      verify: next('verdict'),
    },
    config: { killSwitch: () => false, maxStageAttempts: 1, now: () => 1_700_000_000_000 },
  });
  return { orch, store, sink, model, judge, workspace };
}

describe('Remedy', () => {
  it('accepts a patch the Judge verifies and moves to verify', async () => {
    const { orch, sink, workspace, judge, model } = run([patch()], [good]);
    expect(await orch.run('c1')).toBe('verdict');
    expect(model.requests[0]?.tools).toEqual(['submit_patch']);
    expect(judge.patches).toHaveLength(1);
    expect(
      sink.events.some((e) => e.type === 'patch-verified' && e.payload.accepted === true),
    ).toBe(true);
    expect((await workspace.getPatchOutcome('c1'))?.accepted).toBe(true);
  });

  it.each([
    ['literal-only-patch', 'only the exact literal changed'],
    ['diff-too-large', 'over the diff cap'],
    ['suite-fails', 'tests failed'],
  ] as const)(
    'rejects for %s, records the rule, and retries with feedback',
    async (rule, detail) => {
      const { orch, sink, model, workspace } = run([patch(), patch()], [bad(rule, detail), good]);
      expect(await orch.run('c1')).toBe('verdict');

      const rejection = sink.events.find((e) => e.type === 'patch-rejected');
      expect(rejection?.payload).toMatchObject({ rule });
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.user).toContain('[judge-feedback]');
      expect(model.requests[1]?.user).toContain(rule);
      expect((await workspace.getPatchOutcome('c1'))?.accepted).toBe(true);
    },
  );

  it.each(['literal-only-patch', 'diff-too-large', 'suite-fails'] as const)(
    'moves to verify with a not-accepted outcome when %s persists to the cap',
    async (rule) => {
      const { orch, workspace, store } = run([patch(), patch()], [bad(rule), bad(rule)]);
      expect(await orch.run('c1')).toBe('verdict');
      const outcome = await workspace.getPatchOutcome('c1');
      expect(outcome).toMatchObject({ accepted: false });
      expect(outcome?.result?.rejectedBy).toBe(rule);
      expect(store.escalations).toEqual([]);
    },
  );

  it('does not accept a result that lacks a flipped family even without a named rule', async () => {
    const weak: VerifyResult = { ...good, familyFlipped: false };
    const { orch, workspace } = run([patch(), patch()], [weak, weak]);
    await orch.run('c1');
    expect((await workspace.getPatchOutcome('c1'))?.accepted).toBe(false);
  });

  it('takes acceptance only from the Judge, not from the agent', async () => {
    const { orch, workspace } = run(
      [patch({ accepted: true, familyFlipped: true }), patch({ accepted: true })],
      [bad('suite-fails'), bad('suite-fails')],
    );
    await orch.run('c1');
    expect((await workspace.getPatchOutcome('c1'))?.accepted).toBe(false);
  });

  it('records no patch outcome as not accepted when the agent submits nothing', async () => {
    const { orch, workspace, judge } = run([none], []);
    expect(await orch.run('c1')).toBe('verdict');
    expect(judge.patches).toHaveLength(0);
    expect(await workspace.getPatchOutcome('c1')).toMatchObject({ accepted: false });
  });

  it('records schema failures as inadmissible and feeds them back', async () => {
    const badShape: ModelTurnResult = {
      outcome: 'submitted',
      submission: { prose: 'fixed' },
      cost,
    };
    const { orch, sink, model } = run([badShape, patch()], [good]);
    expect(await orch.run('c1')).toBe('verdict');
    expect(sink.events.some((e) => e.type === 'exhibit-inadmissible')).toBe(true);
    expect(model.requests[1]?.user).toContain('missing diff');
  });

  it('shows the agent the admitted witness as untrusted data and the case slices', async () => {
    const { orch, model } = run([patch()], [good]);
    await orch.run('c1');
    const user = model.requests[0]?.user ?? '';
    expect(user).toContain('[witness]');
    expect(user).toContain('sqli-union');
    expect(user).toContain('[case-file-slice]');
    expect(model.requests[0]?.system).toBe('SYSTEM:remedy');
  });

  it('fails loudly when no admitted witness was handed over', async () => {
    const { orch } = run([patch()], [good], { witness: null });
    await expect(orch.run('c1')).rejects.toThrow(/no admitted witness/);
  });
});
