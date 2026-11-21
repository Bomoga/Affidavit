import { describe, expect, it } from 'vitest';
import {
  ExhibitResult,
  IllegalTransitionError,
  Verdict,
  VerifyResult,
  type CaseStage,
  type ExhibitId,
  type StageCost,
} from '@affidavit/contracts';
import { getPrompt, renderPrompt } from '@affidavit/prompts';
import {
  FakeCaseFileSource,
  FakeCaseStore,
  FakeEventSink,
  FakeJudge,
  ReplayModel,
  readFixtureJson,
  sha256Hex,
} from '@affidavit/testing';
import { createDefenseHandler } from './defense.js';
import { Orchestrator, type ModelTurnResult, type StageHandler } from './orchestrator.js';
import { buildPatchExhibit } from './patch.js';
import { createRemedyHandler } from './remedy.js';
import {
  BIG_BUDGET,
  NOW,
  PATH_TO,
  assertSchemaValid,
  inOrder,
  makeCaseFile,
  openAt,
  withRecipeIds,
} from './test-support.js';
import {
  buildVerdict,
  checkSummary,
  decideOutcome,
  finalizeVerdict,
  lintGeneratedText,
  renderSummary,
  type StructuredVerdict,
} from './verdict.js';
import { createVerifyHandler } from './verify.js';
import { buildWitness, witnessExhibitId, witnessSha256 } from './witness.js';
import { InMemoryWorkspace } from './workspace.js';

const EM_DASH = '—';
const W_ID = 'exhibit-witness-001' as ExhibitId;
const P_ID = 'exhibit-patch-001' as ExhibitId;

const cost = (stage: CaseStage, attempt: number, usd: number): StageCost => ({
  stage,
  attempt,
  inputTokens: 120,
  outputTokens: 40,
  usd,
  wallMs: 900,
});

const CF = makeCaseFile();

const base = (overrides: Partial<StructuredVerdict> = {}): StructuredVerdict => ({
  ...buildVerdict({
    caseId: CF.id,
    outcome: 'proven-fixed',
    exhibits: [W_ID, P_ID],
    promptVersions: { defense: '1.0.0', remedy: '1.0.0' },
    modelIds: { defense: 'model-a', remedy: 'model-a' },
    cost: [cost('defense', 1, 0.07), cost('remedy', 2, 0.1)],
  }),
  ...overrides,
});

const OUTCOMES = [
  'proven-fixed',
  'proven-unfixed',
  'not-proven',
  'dismissed',
  'escalated',
] as const;

describe('verdict writer', () => {
  it('builds the structured verdict first, without a summary', () => {
    const v = base();
    expect(v).not.toHaveProperty('summary');
    expect(v.schemaVersion).toBe(1);
    expect(v.exhibits).toEqual([W_ID, P_ID]);
  });

  it('finalizes into a contract Verdict', () => {
    const v = finalizeVerdict(base({ severity: 'high' }));
    expect(Verdict.parse(v)).toEqual(v);
  });

  it('generates the summary from the structured verdict, deterministically', () => {
    expect(renderSummary(base())).toBe(renderSummary(base()));
    expect(renderSummary(base())).not.toBe(renderSummary(base({ outcome: 'proven-unfixed' })));
  });

  it('puts only numbers and exhibit ids from the structured verdict in the summary', () => {
    for (const outcome of OUTCOMES) {
      expect(checkSummary(finalizeVerdict(base({ outcome, severity: 'high' })))).toEqual([]);
    }
    const summary = renderSummary(base());
    expect(summary).toContain(W_ID);
    expect(summary).toContain(P_ID);
    expect(summary).toContain('0.07');
  });

  it('flags a number that is not in the structured verdict', () => {
    const problems = checkSummary({ ...finalizeVerdict(base()), summary: 'Fixed 42 weaknesses.' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('42');
  });

  it('checks exhibit ids against the ids the verdict actually cites', () => {
    const v = finalizeVerdict(base());
    expect(checkSummary({ ...v, summary: `See ${W_ID}.` })).toEqual([]);
    expect(checkSummary({ ...v, summary: 'See exhibit-witness-abc.' })).toEqual([
      'summary has exhibit id exhibit-witness-abc not in the verdict',
    ]);
    expect(checkSummary({ ...v, summary: 'See exhibit-counterexample-abc.' })).toHaveLength(1);
    // A near miss of a real id is caught, not matched as a prefix.
    expect(checkSummary({ ...v, summary: `See ${W_ID}x.` })).toEqual([
      `summary has exhibit id ${W_ID}x not in the verdict`,
    ]);
  });

  it('checks ids that do not use the exhibit- prefix by their family', () => {
    const v = finalizeVerdict(base({ exhibits: ['ex_w1' as ExhibitId] }));
    expect(checkSummary({ ...v, summary: 'See ex_w1.' })).toEqual([]);
    expect(checkSummary({ ...v, summary: 'See ex_made_up.' })).toHaveLength(1);
  });

  it('refuses to finalize a verdict whose summary breaks the rules', () => {
    expect(() => finalizeVerdict(base(), { summaryOverride: `Solved ${EM_DASH} done` })).toThrow(
      /em dash/i,
    );
    expect(() => finalizeVerdict(base(), { summaryOverride: 'Found 999 issues.' })).toThrow(/999/);
  });

  it('lints generated text for em dashes and never emits one', () => {
    expect(lintGeneratedText('plain text, nothing odd')).toEqual([]);
    expect(lintGeneratedText(`a ${EM_DASH} b`)).toHaveLength(1);
    for (const outcome of OUTCOMES) expect(renderSummary(base({ outcome }))).not.toContain(EM_DASH);
  });

  it('picks the outcome from Judge-derived facts', () => {
    expect(decideOutcome({ patchAccepted: true })).toBe('proven-fixed');
    expect(decideOutcome({ patchAccepted: false })).toBe('proven-unfixed');
    expect(decideOutcome({ patchAccepted: false, appealsExhausted: true })).toBe('not-proven');
  });
});

const ADMITTED = ExhibitResult.parse(readFixtureJson('exhibit-results/admissible.json'));
const PASS = VerifyResult.parse({
  ...(readFixtureJson('exhibit-results/verify-pass.json') as object),
  counterexamples: [],
});
const W = { template: 'witness template', params: [{ name: 'n', values: [1, 2] }] };
const FILE = 'app/data/allocations-dao.js';
const DIFF = `--- a/${FILE}\n+++ b/${FILE}\n@@ -1,1 +1,1 @@\n-q(id)\n+q("?", [id])\n`;

describe('verify stage writes the verdict (jury disabled)', () => {
  async function verifyOnly(opts: { witness?: boolean; accepted?: boolean; jury?: boolean } = {}) {
    const store = new FakeCaseStore({ juryEnabled: opts.jury ?? false });
    await openAt(store, CF, BIG_BUDGET, PATH_TO.verify);
    const sink = new FakeEventSink();
    const workspace = new InMemoryWorkspace();
    if (opts.witness !== false) {
      await workspace.saveWitness(CF.id, { witness: buildWitness(CF, W), result: ADMITTED });
      await workspace.addExhibit(CF.id, ADMITTED.exhibitId);
    }
    const patch = buildPatchExhibit(CF, DIFF);
    if (opts.accepted !== undefined) {
      if (opts.accepted) await workspace.addExhibit(CF.id, patch.id);
      await workspace.savePatchOutcome(CF.id, {
        accepted: opts.accepted,
        patch,
        result: PASS,
        reason: 'x',
        verifyResults: [{ ...PASS, patchExhibitId: patch.id }],
      });
    }
    const orch = new Orchestrator({
      store,
      sink,
      model: new ReplayModel(new Map()),
      handlers: { verify: createVerifyHandler({ store, workspace, jury: 'disabled' }) },
      config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
    });
    return { orch, store, events: () => assertSchemaValid(sink.events(CF.id)), patch };
  }

  it('appends the verdict through CaseStore and emits verdict-written {verdict}', async () => {
    const t = await verifyOnly({ accepted: true });
    expect((await t.orch.run(CF.id)).stage).toBe('verdict');
    const stored = await t.store.getVerdict(CF.id);
    expect(stored).toMatchObject({
      outcome: 'proven-fixed',
      exhibits: [ADMITTED.exhibitId, t.patch.id],
    });
    const written = t.events().find((e) => e.type === 'verdict-written');
    expect(written?.payload).toEqual({ verdict: stored });
    expect(stored && checkSummary(stored)).toEqual([]);
  });

  it('writes proven-unfixed when the Judge did not accept a patch', async () => {
    const t = await verifyOnly({ accepted: false });
    await t.orch.run(CF.id);
    expect((await t.store.getVerdict(CF.id))?.outcome).toBe('proven-unfixed');
  });

  it('escalates instead of writing a proven outcome without an admitted witness exhibit', async () => {
    const t = await verifyOnly({ witness: false, accepted: true });
    expect((await t.orch.run(CF.id)).stage).toBe('escalated');
    // Terminal verdicts (L3-06b): the only verdict written is an `escalated` one, never proven.
    expect((await t.store.getVerdict(CF.id))?.outcome).toBe('escalated');
    const written = t.events().filter((e) => e.type === 'verdict-written');
    expect(written.map((e) => e.payload.verdict.outcome)).toEqual(['escalated']);
    expect(t.events().find((e) => e.type === 'escalated')?.payload).toMatchObject({
      escalation: { reason: 'no-admissible-witness-above-floor' },
    });
  });

  it('records one verify-result per verifyPatch call, as the Judge, inside verify (CR-1)', async () => {
    const t = await verifyOnly({ accepted: true });
    await t.orch.run(CF.id);
    const events = t.events();
    const results = events.filter((e) => e.type === 'verify-result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ actor: 'judge', stage: 'verify' });
    expect(results[0]?.payload).toEqual({ result: { ...PASS, patchExhibitId: t.patch.id } });
    const i = events.indexOf(results[0] as (typeof events)[number]);
    expect(events[i - 1]).toMatchObject({ type: 'stage-entered', stage: 'verify' });
    const after = events.slice(i + 1).map((e) => e.type);
    expect(after.indexOf('verdict-written')).toBeLessThan(after.indexOf('stage-exited'));
  });

  it('records no verify-result when Remedy never called verifyPatch', async () => {
    const t = await verifyOnly({});
    await t.orch.run(CF.id);
    expect(t.events().some((e) => e.type === 'verify-result')).toBe(false);
  });

  it('records a verify-result even when the case escalates for want of a witness', async () => {
    const t = await verifyOnly({ witness: false, accepted: true });
    expect((await t.orch.run(CF.id)).stage).toBe('escalated');
    expect(t.events().filter((e) => e.type === 'verify-result')).toHaveLength(1);
  });

  it('is refused by a store wired with the jury enabled', async () => {
    const t = await verifyOnly({ accepted: true, jury: true });
    await expect(t.orch.run(CF.id)).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

describe('a full trial on fakes records what actually ran', () => {
  async function trial(defenseScript: ModelTurnResult[], remedyResult = PASS) {
    const store = new FakeCaseStore({ juryEnabled: false });
    await openAt(store, CF, BIG_BUDGET, PATH_TO.defense);
    const sink = new FakeEventSink();
    const workspace = new InMemoryWorkspace();
    const caseFiles = new FakeCaseFileSource([CF]);
    const judge = new FakeJudge({
      witnessResults: { [witnessSha256(W.template, W.params)]: ADMITTED },
      verifyResults: { [sha256Hex(DIFF)]: remedyResult },
    });
    const model = new ReplayModel(
      inOrder([
        ...defenseScript,
        { outcome: 'submitted', submission: { diff: DIFF }, cost: cost('remedy', 1, 0.03) },
      ]),
    );
    const passThrough: StageHandler = {
      run: () => Promise.resolve({ kind: 'advance', next: 'remedy' }),
    };
    const turnBudget = { maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: 0.1 };
    const orch = new Orchestrator({
      store,
      sink,
      model,
      handlers: {
        defense: createDefenseHandler({
          caseFiles,
          judge: withRecipeIds(judge),
          render: renderPrompt,
          workspace,
          config: {
            first: { promptId: 'defense', model: 'model-a' },
            second: { promptId: 'defense-second-attempt', model: 'model-b' },
            maxIterations: 1,
            maxTurns: 3,
            turnBudget,
          },
        }),
        prosecution: passThrough,
        remedy: createRemedyHandler({
          caseFiles,
          judge,
          render: renderPrompt,
          workspace,
          config: {
            promptId: 'remedy',
            model: 'model-c',
            maxIterations: 1,
            maxTurns: 3,
            turnBudget,
          },
        }),
        verify: createVerifyHandler({ store, workspace, jury: 'disabled' }),
      },
      config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
    });
    const out = await orch.run(CF.id);
    return { out, store, events: assertSchemaValid(sink.events(CF.id)) };
  }

  const witnessTurn: ModelTurnResult = {
    outcome: 'submitted',
    submission: W,
    cost: cost('defense', 1, 0.05),
  };

  it('ends proven-fixed with prompt versions, model ids, and costs from the calls made', async () => {
    const t = await trial([witnessTurn]);
    expect(t.out.stage).toBe('verdict');
    const v = await t.store.getVerdict(CF.id);
    expect(v?.outcome).toBe('proven-fixed');
    expect(v?.promptVersions).toEqual({
      defense: getPrompt('defense').version,
      remedy: getPrompt('remedy').version,
    });
    expect(v?.modelIds).toEqual({ defense: 'model-a', remedy: 'model-c' });
    expect(v?.cost.map((c) => [c.stage, c.usd])).toEqual([
      ['defense', 0.05],
      ['remedy', 0.03],
    ]);
    expect(v?.exhibits[0]).toBe(witnessExhibitId(CF.id, W.template, W.params));
    expect(v?.exhibits).toHaveLength(2);
    expect(v && checkSummary(v)).toEqual([]);
  });

  it('records the second Defense prompt under its own id when it ran', async () => {
    const t = await trial([
      { outcome: 'no-submission', cost: cost('defense', 1, 0.01) },
      witnessTurn,
    ]);
    const v = await t.store.getVerdict(CF.id);
    expect(v?.promptVersions).toEqual({
      defense: getPrompt('defense').version,
      'defense-second-attempt': getPrompt('defense-second-attempt').version,
      remedy: getPrompt('remedy').version,
    });
    expect(v?.modelIds['defense-second-attempt']).toBe('model-b');
  });

  it('ends proven-unfixed when the Judge rejects the patch', async () => {
    const t = await trial([witnessTurn], {
      ...PASS,
      familyFlipped: false,
      rejectedBy: 'literal-only-patch',
    });
    expect((await t.store.getVerdict(CF.id))?.outcome).toBe('proven-unfixed');
    // The failing check is on the record too, as the Judge returned it (CR-1).
    const results = t.events.filter((e) => e.type === 'verify-result');
    expect(results.map((e) => e.payload.result.rejectedBy)).toEqual(['literal-only-patch']);
  });

  it('streams the Judge VerifyResult for the patch between verify entered and exited (CR-1)', async () => {
    const t = await trial([witnessTurn]);
    const verify = t.events.filter((e) => e.stage === 'verify');
    expect(verify[0]?.type).toBe('stage-entered');
    expect(verify.at(-1)?.type).toBe('stage-exited');
    const results = verify.filter((e) => e.type === 'verify-result');
    expect(results).toHaveLength(1);
    expect(results[0]?.actor).toBe('judge');
    const patch = t.events.find(
      (e) => e.type === 'exhibit-submitted' && e.payload.kind === 'patch',
    );
    if (patch?.type !== 'exhibit-submitted') throw new Error('no patch submitted');
    expect(results[0]?.payload.result).toEqual(PASS);
    // The verdict cites the patch the Judge checked.
    const v = await t.store.getVerdict(CF.id);
    expect(v?.exhibits).toContain(patch.payload.exhibitId);
  });
});
