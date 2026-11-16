import { describe, expect, it } from 'vitest';
import { ExhibitId, type CaseStage, type StageCost } from '@affidavit/contracts';
import { FakeEventSink, ReplayModel } from '@affidavit/testing';
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
import { InMemoryWorkspace } from './workspace.js';
import {
  BIG_BUDGET,
  LoggingCaseStore,
  NOW,
  PATH_TO,
  assertSchemaValid,
  inOrder,
  makeCaseFile,
  openAt,
} from './test-support.js';

const EM_DASH = '—';
const CF = makeCaseFile();
const W1 = ExhibitId.parse('exhibit-witness-065ed82f887fd688aef7d3a3');
const P1 = ExhibitId.parse('exhibit-patch-1c2d3e4f5a6b7c8d9e0f1a2b');

const cost = (stage: CaseStage, attempt: number, usd: number): StageCost => ({
  stage,
  attempt,
  inputTokens: 120,
  outputTokens: 40,
  usd,
  wallMs: 900,
});

const base = (overrides: Partial<Parameters<typeof buildVerdict>[0]> = {}): StructuredVerdict =>
  buildVerdict({
    caseId: CF.id,
    outcome: 'proven-fixed',
    exhibits: [W1, P1],
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
    expect(v.exhibits).toEqual([W1, P1]);
    expect(v.promptVersions.defense).toBe('1.0.0');
    expect(v.cost).toHaveLength(2);
  });

  it('generates a contract-valid summary from the structured verdict, deterministically', () => {
    const v = base();
    expect(renderSummary(v)).toBe(renderSummary(v));
    expect(renderSummary(v)).not.toBe(renderSummary(base({ outcome: 'proven-unfixed' })));
    expect(finalizeVerdict(v).schemaVersion).toBe(1);
  });

  it('puts only numbers and exhibit ids from the structured verdict in the summary', () => {
    for (const outcome of OUTCOMES) {
      const v = finalizeVerdict(base({ outcome, severity: 'high' }));
      expect(checkSummary(v)).toEqual([]);
    }
  });

  it('writes the ids and costs it was given', () => {
    const summary = renderSummary(base());
    expect(summary).toContain(W1);
    expect(summary).toContain(P1);
    expect(summary).toContain('0.07');
    expect(summary).toContain('0.1');
  });

  it('flags a number that is not in the structured verdict', () => {
    const problems = checkSummary({ ...finalizeVerdict(base()), summary: 'Fixed 42 weaknesses.' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('42');
  });

  it('flags an exhibit id that is not in the structured verdict', () => {
    const problems = checkSummary({
      ...finalizeVerdict(base()),
      summary: 'See exhibit-witness-made-up for proof.',
    });
    expect(problems.some((p) => p.includes('exhibit-witness-made-up'))).toBe(true);
  });

  it('refuses to finalize a verdict whose summary breaks the rules', () => {
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
  async function runVerify(accepted: boolean) {
    const log: string[] = [];
    // The jury is skipped for the gate case, so the store must allow verify to go to verdict.
    const store = new LoggingCaseStore(log, { juryEnabled: false });
    await openAt(store, CF, BIG_BUDGET, PATH_TO.verify);
    const sink = new FakeEventSink();
    const workspace = new InMemoryWorkspace();
    await workspace.addExhibit(CF.id, W1);
    await workspace.addExhibit(CF.id, P1);
    await workspace.savePatchOutcome(CF.id, {
      accepted,
      reason: accepted ? 'the Judge verified the patch' : 'the Judge did not accept a patch',
    });
    const orch = new Orchestrator({
      store,
      sink,
      model: new ReplayModel(inOrder([])),
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
      config: { killSwitch: () => false, maxStageAttempts: 1, now: () => NOW },
    });
    const out = await orch.run(CF.id);
    return { out, store, events: assertSchemaValid(sink.events(CF.id)) };
  }

  it('records a proven-fixed verdict that cites its exhibits, then reaches the verdict stage', async () => {
    const { out, store, events } = await runVerify(true);
    expect(out).toEqual({ status: 'terminal', stage: 'verdict' });
    const v = await store.getVerdict(CF.id);
    expect(v).toMatchObject({ outcome: 'proven-fixed', exhibits: [W1, P1] });
    expect(v?.promptVersions).toEqual({ defense: '1.0.0', remedy: '1.0.0' });
    expect(v && checkSummary(v)).toEqual([]);
    const written = events.find((e) => e.type === 'verdict-written');
    expect(written?.payload).toMatchObject({ verdict: { outcome: 'proven-fixed' } });
  });

  it('records proven-unfixed when the Judge did not accept a patch', async () => {
    const { out, store } = await runVerify(false);
    expect(out).toEqual({ status: 'terminal', stage: 'verdict' });
    expect((await store.getVerdict(CF.id))?.outcome).toBe('proven-unfixed');
  });
});
