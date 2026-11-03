import { describe, expect, it } from 'vitest';
import type { CaseStage, StageCost, WitnessSubmission } from './interim/types.js';
import { Orchestrator } from './orchestrator.js';
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
import { FakeCaseStore, FakeEventSink, FakeModel, InMemoryWorkspace } from './testing/fakes.js';

const EM_DASH = '—';

const cost = (stage: CaseStage, attempt: number, usd: number): StageCost => ({
  stage,
  attempt,
  inputTokens: 120,
  outputTokens: 40,
  usd,
  wallMs: 900,
});

const base = (overrides: Partial<StructuredVerdict> = {}): StructuredVerdict =>
  buildVerdict({
    caseId: 'case-7',
    outcome: 'proven-fixed',
    exhibits: ['ex_w1', 'ex_p1'],
    promptVersions: { defense: '1.0.0', remedy: '1.0.0' },
    modelIds: { defense: 'model-a', remedy: 'model-a' },
    cost: [cost('defense', 1, 0.07), cost('remedy', 2, 0.1)],
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
    expect(v.exhibits).toEqual(['ex_w1', 'ex_p1']);
    expect(v.promptVersions.defense).toBe('1.0.0');
    expect(v.cost).toHaveLength(2);
  });

  it('generates the summary from the structured verdict, deterministically', () => {
    const v = base();
    expect(renderSummary(v)).toBe(renderSummary(v));
    expect(renderSummary(v)).not.toBe(renderSummary(base({ outcome: 'proven-unfixed' })));
  });

  it('puts only numbers and exhibit ids from the structured verdict in the summary', () => {
    for (const outcome of OUTCOMES) {
      const v = finalizeVerdict(base({ outcome, severity: 'high' }));
      expect(checkSummary(v)).toEqual([]);
    }
  });

  it('writes the ids and costs it was given', () => {
    const summary = renderSummary(base());
    expect(summary).toContain('ex_w1');
    expect(summary).toContain('ex_p1');
    expect(summary).toContain('0.07');
    expect(summary).toContain('0.1');
  });

  it('flags a number that is not in the structured verdict', () => {
    const v = { ...base(), summary: 'Fixed 42 weaknesses.' };
    const problems = checkSummary(v);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('42');
  });

  it('flags an exhibit id that is not in the structured verdict', () => {
    const v = { ...base(), summary: 'See ex_made_up for proof.' };
    const problems = checkSummary(v);
    expect(problems.some((p) => p.includes('ex_made_up'))).toBe(true);
  });

  it('refuses to finalize a verdict whose summary breaks the rules', () => {
    // Case ids are data. One that smuggles a number or id into the summary must not pass.
    const hostile = base({ caseId: 'case-1' });
    expect(() => finalizeVerdict(hostile)).not.toThrow();
    expect(() => finalizeVerdict(base(), { summaryOverride: `Solved ${EM_DASH} done` })).toThrow(
      /em dash/i,
    );
    expect(() => finalizeVerdict(base(), { summaryOverride: 'Found 999 issues.' })).toThrow(/999/);
  });

  it('lints generated text for em dashes', () => {
    expect(lintGeneratedText('plain text, nothing odd')).toEqual([]);
    expect(lintGeneratedText(`a ${EM_DASH} b`)).toHaveLength(1);
  });

  it('never emits an em dash in any outcome summary', () => {
    for (const outcome of OUTCOMES) {
      expect(renderSummary(base({ outcome }))).not.toContain(EM_DASH);
    }
  });

  it('states what was and was not proven in plain language', () => {
    expect(renderSummary(base({ outcome: 'proven-fixed' }))).toMatch(/fix .*stop/i);
    expect(renderSummary(base({ outcome: 'proven-unfixed' }))).toMatch(/no fix has been proven/i);
    expect(renderSummary(base({ outcome: 'escalated' }))).toMatch(/human/i);
  });

  it('picks the outcome from Judge-derived facts', () => {
    expect(decideOutcome({ patchAccepted: true })).toBe('proven-fixed');
    expect(decideOutcome({ patchAccepted: false })).toBe('proven-unfixed');
    expect(decideOutcome({ patchAccepted: false, appealsExhausted: true })).toBe('not-proven');
  });
});

describe('verify stage writes the verdict', () => {
  const witness: WitnessSubmission = { template: 'sqli-union', params: {} };

  async function runVerify(accepted: boolean) {
    const log: string[] = [];
    const store = new FakeCaseStore(log, { usd: 10, tokens: 1_000_000 }, 'verify');
    await store.settleCost(
      'c1',
      (await store.chargeBudget('c1', cost('defense', 1, 0.07))).chargeId,
      cost('defense', 1, 0.07),
    );
    const sink = new FakeEventSink();
    const workspace = new InMemoryWorkspace();
    await workspace.saveWitness('c1', witness);
    await workspace.addExhibit('c1', 'ex_w1');
    await workspace.addExhibit('c1', 'ex_p1');
    await workspace.savePatchOutcome('c1', { accepted });
    const orch = new Orchestrator({
      store,
      sink,
      model: new FakeModel(log, []),
      validate: () => ({ ok: true }),
      handlers: {
        verify: createVerifyHandler({
          store,
          workspace,
          runInfo: {
            promptVersions: { defense: '1.0.0', remedy: '1.0.0' },
            modelIds: { defense: 'model-a', remedy: 'model-a' },
          },
        }),
      },
      config: { killSwitch: () => false, maxStageAttempts: 1, now: () => 1_700_000_000_000 },
    });
    const final = await orch.run('c1');
    return { final, sink, workspace };
  }

  it('records a proven-fixed verdict that cites its exhibits, then reaches the verdict stage', async () => {
    const { final, sink, workspace } = await runVerify(true);
    expect(final).toBe('verdict');
    const v = await workspace.getVerdict('c1');
    expect(v).toMatchObject({ outcome: 'proven-fixed', exhibits: ['ex_w1', 'ex_p1'] });
    expect(v?.promptVersions).toEqual({ defense: '1.0.0', remedy: '1.0.0' });
    expect(v?.cost).toHaveLength(1);
    expect(v && checkSummary(v)).toEqual([]);
    expect(sink.events.some((e) => e.type === 'verdict-written')).toBe(true);
  });

  it('records proven-unfixed when the Judge did not accept a patch', async () => {
    const { final, workspace } = await runVerify(false);
    expect(final).toBe('verdict');
    expect((await workspace.getVerdict('c1'))?.outcome).toBe('proven-unfixed');
  });
});
