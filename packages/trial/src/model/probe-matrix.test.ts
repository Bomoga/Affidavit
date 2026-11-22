// L3-19: the P8 model matrix, which sends the real Defense input on every model in the table.
// Every test uses a stubbed transport; nothing reaches the network.
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { renderPrompt } from '@affidavit/prompts';
import { describe, expect, it } from 'vitest';
import { defenseBlocks } from '../defense.js';
import { DEFAULT_MODEL_TABLE, type ModelTable } from './models.js';
import {
  FIXTURE_CASE_DIR,
  P8_EXTRA_MODEL,
  REFUSAL_POLICY_SENTENCE,
  buildModelMatrix,
  formatResult,
  formatSummary,
  interpret,
  isFixtureText,
  isSynthetic,
  loadFixtureCase,
  runLadder,
  type ProbeDeps,
} from './probe.js';
import { qualifiedToolName } from './submit-tools.js';
import {
  CANARY_KEY,
  GOOD_WITNESS,
  assistant,
  refusalAssistant,
  result,
  stubTransport,
  type Harness,
  type Script,
} from './test-stubs.js';
import type { AgentTransport } from './transport.js';

const FIXTURE = join(FIXTURE_CASE_DIR, 'nodegoat-nosqli-where-001.json');
const ENV = { ANTHROPIC_API_KEY: CANARY_KEY, PATH: '/usr/bin' };
const WORKER = {
  maxTurns: 6,
  budget: { maxInputTokens: 100_000, maxOutputTokens: 8_000, maxUsd: 0.5 },
};
const fixture = loadFixtureCase(FIXTURE);

function deps(transport: AgentTransport, modelTable: ModelTable = DEFAULT_MODEL_TABLE): ProbeDeps {
  return {
    transport,
    fetch: () => Promise.reject(new Error('no fetch in P8')),
    env: () => ENV,
    modelTable,
    timeoutMs: 5_000,
  };
}

const modelOf = (h: Harness): string => String(h.options.model);

/** The agent submits a witness and the turn ends cleanly. */
async function* submits(h: Harness): AsyncGenerator<SDKMessage, void, unknown> {
  await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
  yield result('success', { usd: 0.01 });
}

/** The provider's safeguards refuse the request, as the runtime reports it. */
async function* refuses(): AsyncGenerator<SDKMessage, void, unknown> {
  await Promise.resolve();
  yield refusalAssistant();
  yield result('success', { isError: true, usd: 0.02, text: 'refused' });
}

/** The runtime answers a refused request on another model and says so. */
async function* fallsBack(): AsyncGenerator<SDKMessage, void, unknown> {
  await Promise.resolve();
  yield {
    type: 'system',
    subtype: 'model_refusal_fallback',
    api_refusal_category: 'cyber',
    fallback_model: 'claude-opus-5',
    uuid: '00000000-0000-0000-0000-000000000003',
    session_id: 's',
  } as unknown as SDKMessage;
  yield result('success', { usd: 0.02 });
}

/** Another model answers with no notice; the port's backstop refuses the turn. */
async function* otherModelAnswers(h: Harness): AsyncGenerator<SDKMessage, void, unknown> {
  await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
  const m = assistant('m-other', 10, 5) as unknown as { message: Record<string, unknown> };
  m.message.model = 'claude-opus-5';
  yield m as unknown as SDKMessage;
  yield result('success', { usd: 0.02 });
}

/** The model id is not available to the organization. */
async function* notFound(): AsyncGenerator<SDKMessage, void, unknown> {
  await Promise.resolve();
  yield assistant('m-404', 0, 0, 'invalid_request', 'API Error: 404 model not found');
  yield result('success', { isError: true, usd: 0, input: 0, output: 0, text: 'not found' });
}

/** A script per requested model. */
function perModel(scripts: Record<string, Script>, fallback: Script = submits): Script {
  return (h) => (scripts[modelOf(h)] ?? fallback)(h);
}

describe('building the P8 matrix', () => {
  const matrix = buildModelMatrix(DEFAULT_MODEL_TABLE, fixture, WORKER);

  it('covers every distinct table model, the second attempt, the extra, then the skipped stages', () => {
    expect(matrix.map((p) => p.id)).toEqual([
      'P8:defense:claude-opus-5-5',
      'P8:defense:claude-haiku-5-5',
      'P8:defense:claude-sonnet-5-5',
      'P8:defense-second-attempt:claude-sonnet-5-5',
      `P8x:defense:${P8_EXTRA_MODEL}`,
      'P8:prosecution:claude-sonnet-5-5',
      'P8:remedy:claude-sonnet-5-5',
      'P8:jury:claude-sonnet-5-5',
    ]);
  });

  it('sends the same real Defense input and the packaged prompts, unchanged, with the worker budget', () => {
    const defense = renderPrompt('defense', defenseBlocks(fixture.caseFile, []));
    const second = renderPrompt('defense-second-attempt', defenseBlocks(fixture.caseFile, []));
    for (const p of matrix.filter((x) => x.promptId === 'defense')) {
      expect(p.user.text).toBe(defense.user);
      expect(p.system.text).toBe(defense.system);
      expect(p).toMatchObject({ path: 'port', mode: 'live', turn: WORKER });
      expect(p.modelTable?.defense).toBe(p.model);
      expect(isFixtureText(p.user)).toBe(true);
      expect(isSynthetic(p.system)).toBe(true);
    }
    const s = matrix.find((x) => x.promptId === 'defense-second-attempt')!;
    expect(s.user.text).toBe(second.user);
    expect(s.system.text).toBe(second.system);
    expect(s.model).toBe(DEFAULT_MODEL_TABLE['defense-second-attempt']);
    expect(s.modelTable).toBeUndefined();
  });

  it('labels the extra probe and skips it when the table already uses that model', () => {
    const extra = matrix.find((p) => p.extra === true)!;
    expect(extra.model).toBe(P8_EXTRA_MODEL);
    expect(extra.name).toContain('may legitimately fail as model not found');
    const withFable: ModelTable = { ...DEFAULT_MODEL_TABLE, 'juror-blast-radius': P8_EXTRA_MODEL };
    const ids = buildModelMatrix(withFable, fixture, WORKER).map((p) => p.id);
    expect(ids).toContain(`P8:defense:${P8_EXTRA_MODEL}`);
    expect(ids.some((id) => id.startsWith('P8x'))).toBe(false);
  });

  it('says why prosecution, remedy and the jury are not run, rather than faking their input', () => {
    const skipped = matrix.filter((p) => p.skipReason !== undefined);
    expect(skipped.map((p) => p.promptId)).toEqual(['prosecution', 'remedy', 'juror-security']);
    for (const p of skipped) expect(p.skipReason).toMatch(/^not run: .*Not faked\.$/);
  });
});

describe('running the P8 matrix', () => {
  const matrix = buildModelMatrix(DEFAULT_MODEL_TABLE, fixture, WORKER);

  it('is refused without allowFixtureInput, with no call made', async () => {
    const t = stubTransport(submits);
    const run = await runLadder(matrix, deps(t.transport), { maxUsd: 2 });
    expect(t.calls).toHaveLength(0);
    for (const r of run.results) expect(['REFUSED', 'SKIP']).toContain(r.status);
  });

  it('sends each probe on its own model through the real port, and never sends a skipped stage', async () => {
    const t = stubTransport(submits);
    const run = await runLadder(matrix, deps(t.transport), { maxUsd: 2, allowFixtureInput: true });
    expect(t.calls.map((c) => c.options.model)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5-5',
      P8_EXTRA_MODEL,
    ]);
    for (const c of t.calls) expect(c.options).toMatchObject({ maxTurns: 6, maxBudgetUsd: 0.5 });
    const ran = run.results.filter((r) => r.skipReason === undefined);
    for (const r of ran) expect(r).toMatchObject({ status: 'PASS', submission: 'submitted' });
    expect(run.results.find((r) => r.promptId === 'defense-second-attempt')?.status).toBe('PASS');
    const skipped = run.results.filter((r) => r.skipReason !== undefined);
    expect(skipped.map((r) => r.status)).toEqual(['SKIP', 'SKIP', 'SKIP']);
    const lines = interpret(run.results);
    expect(lines.some((l) => l.includes('skipped by the USD cap'))).toBe(false);
    expect(lines.at(-1)).toBe(REFUSAL_POLICY_SENTENCE);
  });

  it('reports a refusal on the Defense model with its category and the outcome refused', async () => {
    const t = stubTransport(perModel({ 'claude-opus-5-5': refuses }));
    const run = await runLadder(matrix, deps(t.transport), { maxUsd: 2, allowFixtureInput: true });
    const opus = run.results.find((r) => r.id === 'P8:defense:claude-opus-5-5')!;
    expect(opus).toMatchObject({
      status: 'FAIL',
      portClass: 'refusal',
      refusalCategory: 'cyber',
      submission: 'refused',
      costUsd: 0.02,
    });
    expect(opus.fallbackModel).toBeUndefined();
    const printed = formatResult(opus);
    expect(printed).toContain('submission: refused');
    expect(printed).toContain('runtime fell back to another model: no');
    expect(printed).not.toContain(CANARY_KEY);
    const text = interpret(run.results).join('\n');
    expect(text).toContain('refused by the provider');
    expect(text).toContain('defense on claude-opus-5-5 (category cyber)');
    expect(text).toContain('The second-attempt prompt on claude-sonnet-5-5 was not refused');
    expect(text).not.toContain('Every model in the table');
    expect(text).toContain(REFUSAL_POLICY_SENTENCE);
  });

  it('says so when every table model and the second attempt are refused', async () => {
    const t = stubTransport(perModel({ [P8_EXTRA_MODEL]: notFound }, refuses));
    const run = await runLadder(matrix, deps(t.transport), { maxUsd: 2, allowFixtureInput: true });
    const text = interpret(run.results).join('\n');
    expect(text).toContain('Every model in the table that ran refused the Defense prompt');
    expect(text).toContain('would end in a second refusal for this input');
    expect(text).toContain('P8 passed (the port returned without an error): none.');
    // The extra failed as not found: a separate line, never counted as a refusal.
    const extra = run.results.find((r) => r.extra === true)!;
    expect(extra).toMatchObject({ status: 'FAIL', portClass: 'invalid_request' });
    expect(extra.submission).toBe('no-submission (port threw: invalid_request)');
    expect(text).toContain('failed for another reason (not a refusal)');
    expect(text).toContain('that says nothing about the case');
  });

  it('names the model the runtime fell back to, with or without a notice', async () => {
    const t = stubTransport(
      perModel({ 'claude-haiku-5-5': fallsBack, 'claude-sonnet-5-5': otherModelAnswers }),
    );
    const run = await runLadder(matrix.slice(0, 3), deps(t.transport), {
      maxUsd: 2,
      allowFixtureInput: true,
    });
    const haiku = run.results.find((r) => r.model === 'claude-haiku-5-5')!;
    expect(haiku).toMatchObject({
      status: 'FAIL',
      portClass: 'refusal',
      fallbackModel: 'claude-opus-5',
      submission: 'refused',
    });
    expect(formatResult(haiku)).toContain('runtime fell back to another model: yes, claude-opus-5');
    const sonnet = run.results.find((r) => r.model === 'claude-sonnet-5-5')!;
    expect(sonnet).toMatchObject({
      status: 'FAIL',
      portClass: 'model_mismatch',
      fallbackModel: 'claude-opus-5',
    });
    // A witness captured before the other model answered is never passed on.
    expect(sonnet.submission).toBe('no-submission (port threw: model_mismatch)');
    expect(interpret(run.results).join('\n')).toContain(
      'the runtime fell back to claude-opus-5 and the port refused the turn',
    );
  });

  it('charges an unreported refusal the whole turn USD and skips what the cap cannot cover', async () => {
    const zeroSpendRefusal: Script = async function* () {
      await Promise.resolve();
      yield refusalAssistant();
      yield result('success', { isError: true, usd: 0, input: 0, output: 0, text: 'refused' });
    };
    const t = stubTransport(zeroSpendRefusal);
    const run = await runLadder(matrix, deps(t.transport), { maxUsd: 1, allowFixtureInput: true });
    expect(t.calls).toHaveLength(2);
    expect(run.chargedUsd).toBeCloseTo(1);
    const capped = run.results.filter((r) => r.status === 'SKIP' && r.skipReason === undefined);
    expect(capped).toHaveLength(3);
    expect(interpret(run.results).join('\n')).toContain('P8 skipped by the USD cap');
  });

  it('prints a matrix table and an interpretation with no em dash and no key', async () => {
    const t = stubTransport(perModel({ 'claude-opus-5-5': refuses }));
    const run = await runLadder(matrix, deps(t.transport), { maxUsd: 2, allowFixtureInput: true });
    const summary = formatSummary(run, 2);
    expect(summary).toContain('P8 model matrix');
    expect(summary).toMatch(/defense on claude-opus-5-5\s+FAIL\s+refusal\s+cyber\s+no\s+refused/);
    expect(summary).toMatch(/remedy on claude-sonnet-5-5\s+SKIP\s+-\s+-\s+-\s+not run/);
    expect(summary).toContain(REFUSAL_POLICY_SENTENCE);
    expect(summary).not.toContain('—');
    expect(summary).not.toContain(CANARY_KEY);
    for (const r of run.results) expect(formatResult(r)).not.toContain('—');
  });
});
