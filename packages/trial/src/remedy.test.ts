import { describe, expect, it } from 'vitest';
import {
  ExhibitResult,
  VerifyResult,
  type CaseFile,
  type CaseStage,
  type Exhibit,
  type JudgePort,
  type PatchExhibit,
  type Witness,
} from '@affidavit/contracts';
import { getPrompt, renderPrompt } from '@affidavit/prompts';
import {
  FakeCaseFileSource,
  FakeEventSink,
  FakeJudge,
  type JudgeScript,
  ReplayModel,
  readFixtureJson,
  sha256Hex,
} from '@affidavit/testing';
import { Orchestrator, type ModelTurnResult, type StageHandler } from './orchestrator.js';
import { diffStats } from './patch.js';
import { createRemedyHandler, type RemedyConfig } from './remedy.js';
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
import { buildWitness } from './witness.js';
import { InMemoryWorkspace } from './workspace.js';

const FILE = 'app/data/allocations-dao.js';
const diff = (added: string): string =>
  `--- a/${FILE}\n+++ b/${FILE}\n@@ -1,2 +1,2 @@\n context\n-const q = "select " + id;\n+${added}\n`;
const DIFF1 = diff('const q = db.prepare("select ?", [id]);');
const DIFF2 = diff('const q = db.prepare("select ? limit 1", [id]);');

const PASS = VerifyResult.parse(readFixtureJson('exhibit-results/verify-pass.json'));
const FAIL = VerifyResult.parse(readFixtureJson('exhibit-results/verify-fail.json'));
const reject = (rule: VerifyResult['rejectedBy']): VerifyResult => ({
  ...FAIL,
  familyFlipped: rule !== 'literal-only-patch',
  suitePassed: rule !== 'suite-fails',
  counterexamples: [],
  rejectedBy: rule,
});
const ADMITTED = ExhibitResult.parse(readFixtureJson('exhibit-results/admissible.json'));

const submit = (submission: unknown): ModelTurnResult => ({
  outcome: 'submitted',
  submission,
  cost: turnCost('remedy'),
});
const none: ModelTurnResult = { outcome: 'no-submission', cost: turnCost('remedy') };

const config: RemedyConfig = {
  promptId: 'remedy',
  model: 'model-a',
  maxIterations: 2,
  maxTurns: 3,
  turnBudget: { maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: 0.1 },
};

/** FakeJudge that also keeps the arguments verifyPatch was called with. */
class SpyJudge implements JudgePort {
  readonly verifyArgs: {
    patch: PatchExhibit;
    witness: Witness;
    counterexamples: readonly Exhibit[];
  }[] = [];
  private readonly fake: FakeJudge;
  constructor(script: JudgeScript) {
    this.fake = new FakeJudge(script);
  }
  runWitness: JudgePort['runWitness'] = (...args) => this.fake.runWitness(...args);
  runCounterexample: JudgePort['runCounterexample'] = (...args) =>
    this.fake.runCounterexample(...args);
  verifyPatch(
    caseFile: CaseFile,
    patch: PatchExhibit,
    witness: Witness,
    counterexamples: readonly Exhibit[],
  ): Promise<VerifyResult> {
    this.verifyArgs.push({ patch, witness, counterexamples });
    return this.fake.verifyPatch(caseFile, patch);
  }
}

async function run(
  modelScript: ModelTurnResult[],
  verifyResults: Record<string, VerifyResult>,
  opts: { witness?: boolean } = {},
) {
  const cf = makeCaseFile();
  const store = new LoggingCaseStore([]);
  await openAt(store, cf, BIG_BUDGET, PATH_TO.remedy);
  const sink = new FakeEventSink();
  const model = new ReplayModel(inOrder(modelScript));
  const judge = new SpyJudge({ witnessResults: {}, verifyResults });
  const workspace = new InMemoryWorkspace();
  const witness = buildWitness(cf, {
    template: 'witness template',
    params: [{ name: 'n', values: [1, 2] }],
  });
  if (opts.witness !== false) await workspace.saveWitness(cf.id, { witness, result: ADMITTED });
  const next = (to: CaseStage): StageHandler => ({
    run: () => Promise.resolve({ kind: 'advance', next: to }),
  });
  const orch = new Orchestrator({
    store,
    sink,
    model,
    handlers: {
      remedy: createRemedyHandler({
        caseFiles: new FakeCaseFileSource([cf]),
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
  const final = async () => (await orch.run(cf.id)).stage;
  const events = () => assertSchemaValid(sink.events(cf.id));
  return { cf, final, events, model, judge, workspace, witness };
}

describe('diffStats', () => {
  it('counts files and changed lines from the diff', () => {
    expect(diffStats(DIFF1)).toEqual({ filesTouched: [FILE], linesChanged: 2 });
  });

  it('does not mistake a removed line that starts with dashes for a file header', () => {
    const d = `--- a/${FILE}\n+++ b/${FILE}\n@@ -1,1 +1,1 @@\n--- removed comment\n+new line\n`;
    expect(diffStats(d)).toEqual({ filesTouched: [FILE], linesChanged: 2 });
  });

  it.each(['../outside.js', '/etc/passwd', 'C:/x.js', 'a//b.js'])('refuses the path %s', (p) => {
    expect(() => diffStats(`--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`)).toThrow(/unsafe/);
  });
});

describe('Remedy', () => {
  it('accepts a patch the Judge verifies, built in code, and moves to verify', async () => {
    const t = await run([submit({ diff: DIFF1 })], { [sha256Hex(DIFF1)]: PASS });
    expect(await t.final()).toBe('verdict');
    expect(t.model.requests[0]?.tools).toEqual(['submit_patch']);

    const [call] = t.judge.verifyArgs;
    expect(call?.patch).toMatchObject({
      schemaVersion: 1,
      kind: 'patch',
      caseId: t.cf.id,
      author: 'remedy',
      diff: DIFF1,
      sha256: sha256Hex(DIFF1),
      filesTouched: [FILE],
      linesChanged: 2,
    });
    expect(call?.patch.id).toMatch(/^exhibit-patch-[0-9a-f]{24}$/);
    expect(call?.witness).toEqual(t.witness);
    expect(call?.counterexamples).toEqual([]);

    const submitted = t.events().find((e) => e.type === 'exhibit-submitted');
    expect(submitted?.payload).toEqual({ exhibitId: call?.patch.id, kind: 'patch' });
    expect(t.events().some((e) => e.type === 'exhibit-inadmissible')).toBe(false);
    const outcome = await t.workspace.getPatchOutcome(t.cf.id);
    expect(outcome?.accepted).toBe(true);
    expect(await t.workspace.getExhibits(t.cf.id)).toEqual([call?.patch.id]);
  });

  it.each(['literal-only-patch', 'diff-too-large', 'suite-fails'] as const)(
    'rejects for %s, records exhibit-inadmissible with the rule, and retries with feedback',
    async (rule) => {
      const t = await run([submit({ diff: DIFF1 }), submit({ diff: DIFF2 })], {
        [sha256Hex(DIFF1)]: reject(rule),
        [sha256Hex(DIFF2)]: PASS,
      });
      expect(await t.final()).toBe('verdict');
      const rejection = t.events().find((e) => e.type === 'exhibit-inadmissible');
      expect(rejection?.payload).toEqual({
        exhibitId: t.judge.verifyArgs[0]?.patch.id,
        rejectedBy: rule,
      });
      expect(t.model.requests).toHaveLength(2);
      expect(t.model.requests[1]?.user).toContain('judge-feedback');
      expect(t.model.requests[1]?.user).toContain(rule);
      expect((await t.workspace.getPatchOutcome(t.cf.id))?.accepted).toBe(true);
    },
  );

  it.each(['literal-only-patch', 'diff-too-large', 'suite-fails'] as const)(
    'moves to verify with a not-accepted outcome when %s persists to the cap',
    async (rule) => {
      const t = await run([submit({ diff: DIFF1 }), submit({ diff: DIFF2 })], {
        [sha256Hex(DIFF1)]: reject(rule),
        [sha256Hex(DIFF2)]: reject(rule),
      });
      expect(await t.final()).toBe('verdict');
      const outcome = await t.workspace.getPatchOutcome(t.cf.id);
      expect(outcome).toMatchObject({ accepted: false });
      expect(outcome?.result?.rejectedBy).toBe(rule);
      expect(t.events().some((e) => e.type === 'escalated')).toBe(false);
      expect(await t.workspace.getExhibits(t.cf.id)).toEqual([]);
    },
  );

  it('does not accept an unflipped family even without a named rule, and invents no rule', async () => {
    const weak: VerifyResult = { ...PASS, familyFlipped: false };
    const t = await run([submit({ diff: DIFF1 }), submit({ diff: DIFF2 })], {
      [sha256Hex(DIFF1)]: weak,
      [sha256Hex(DIFF2)]: weak,
    });
    await t.final();
    expect((await t.workspace.getPatchOutcome(t.cf.id))?.accepted).toBe(false);
    expect(t.events().some((e) => e.type === 'exhibit-inadmissible')).toBe(false);
  });

  it('takes stats and acceptance from code and the Judge, not from the agent', async () => {
    const t = await run(
      [
        submit({ diff: DIFF1, filesTouched: ['/etc/passwd'], linesChanged: 999, accepted: true }),
        submit({ diff: DIFF2, accepted: true }),
      ],
      { [sha256Hex(DIFF1)]: reject('suite-fails'), [sha256Hex(DIFF2)]: reject('suite-fails') },
    );
    await t.final();
    expect(t.judge.verifyArgs[0]?.patch.filesTouched).toEqual([FILE]);
    expect(t.judge.verifyArgs[0]?.patch.linesChanged).toBe(2);
    expect((await t.workspace.getPatchOutcome(t.cf.id))?.accepted).toBe(false);
  });

  it('records a diff that touches an unsafe path as inadmissible without calling the Judge', async () => {
    const bad = `--- a/../x.js\n+++ b/../x.js\n@@ -1 +1 @@\n-x\n+y\n`;
    const t = await run([submit({ diff: bad }), submit({ diff: DIFF1 })], {
      [sha256Hex(DIFF1)]: PASS,
    });
    expect(await t.final()).toBe('verdict');
    expect(t.judge.verifyArgs).toHaveLength(1);
    const inadmissible = t.events().find((e) => e.type === 'exhibit-inadmissible');
    expect(inadmissible?.payload.rejectedBy).toBe('schema');
    expect(t.model.requests[1]?.user).toContain('unsafe path');
  });

  it('records no patch outcome as not accepted when the agent submits nothing', async () => {
    const t = await run([none], {});
    expect(await t.final()).toBe('verdict');
    expect(t.judge.verifyArgs).toHaveLength(0);
    expect(await t.workspace.getPatchOutcome(t.cf.id)).toMatchObject({ accepted: false });
  });

  it('records schema failures as inadmissible and feeds them back', async () => {
    const t = await run([submit({ prose: 'fixed' }), submit({ diff: DIFF1 })], {
      [sha256Hex(DIFF1)]: PASS,
    });
    expect(await t.final()).toBe('verdict');
    expect(t.events().find((e) => e.type === 'exhibit-inadmissible')?.payload.rejectedBy).toBe(
      'schema',
    );
    expect(t.model.requests[1]?.user).toContain('schema:');
  });

  it('shows the agent the admitted witness and the slices as untrusted data', async () => {
    const t = await run([submit({ diff: DIFF1 })], { [sha256Hex(DIFF1)]: PASS });
    await t.final();
    const user = t.model.requests[0]?.user ?? '';
    expect(user).toContain('witness template');
    expect(user).toContain('case-file-slice');
    expect(t.model.requests[0]?.system).toBe(getPrompt('remedy').system);
  });

  it('fails loudly when no admitted witness was handed over', async () => {
    const t = await run([submit({ diff: DIFF1 })], {}, { witness: false });
    await expect(t.final()).rejects.toThrow(/no admitted witness/);
  });
});
