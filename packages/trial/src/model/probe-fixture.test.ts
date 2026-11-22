// L3-18: the P7 probes, which replay the worker's Defense turn on a checked-in fixture case file.
// Every test uses a stubbed transport; nothing reaches the network.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt } from '@affidavit/prompts';
import { afterEach, describe, expect, it } from 'vitest';
import { defenseBlocks } from '../defense.js';
import { DEFAULT_MODEL_TABLE } from './models.js';
import {
  FIXTURE_BANNER,
  FIXTURE_CASE_DIR,
  FixtureCaseError,
  P7_MAX_TURN_USD,
  REPO_ROOT,
  WORKER_TURN_DEFAULTS,
  buildFixtureLadder,
  describeOptions,
  formatResult,
  interpret,
  isFixtureText,
  isSynthetic,
  loadFixtureCase,
  runLadder,
  workerTurnFrom,
  type ProbeDeps,
  type ProbeResult,
} from './probe.js';
import { buildAgentOptions } from './anthropic.js';
import { SubmissionBox, buildSubmitTools, qualifiedToolName } from './submit-tools.js';
import {
  CANARY_KEY,
  GOOD_WITNESS,
  refusalAssistant,
  result,
  stubTransport,
  type Script,
} from './test-stubs.js';
import type { AgentTransport } from './transport.js';

const FIXTURE = join(FIXTURE_CASE_DIR, 'nodegoat-nosqli-where-001.json');
const ENV_SECRET_VALUE = 'postgres://worker:CANARY-DB-PASSWORD@db/affidavit';
const ENV = {
  ANTHROPIC_API_KEY: CANARY_KEY,
  PATH: '/usr/bin',
  AFFIDAVIT_WORKER_DATABASE_URL: ENV_SECRET_VALUE,
};
const WORKER = {
  maxTurns: 6,
  budget: { maxInputTokens: 100_000, maxOutputTokens: 8_000, maxUsd: 0.5 },
};

function deps(transport: AgentTransport): ProbeDeps {
  return {
    transport,
    fetch: () => Promise.reject(new Error('no fetch in P7')),
    env: () => ENV,
    modelTable: DEFAULT_MODEL_TABLE,
    timeoutMs: 5_000,
  };
}

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe('loading a fixture case file', () => {
  it('accepts the checked-in fixture, by absolute or repo-relative path', () => {
    const abs = loadFixtureCase(FIXTURE);
    expect(abs.relPath).toBe('fixtures/casefiles/nodegoat-nosqli-where-001.json');
    expect(abs.caseFile.id).toBe('case-nodegoat-nosqli-where-001');
    const rel = loadFixtureCase('fixtures/casefiles/nodegoat-nosqli-where-001.json');
    expect(rel.caseFile.id).toBe(abs.caseFile.id);
  });

  for (const [kind, path] of [
    ['a file outside fixtures/casefiles', join(REPO_ROOT, 'package.json')],
    ['a traversal out of the directory', join(FIXTURE_CASE_DIR, '..', '..', 'package.json')],
    ['the directory itself', FIXTURE_CASE_DIR],
    ['a file that does not exist', join(FIXTURE_CASE_DIR, 'missing.json')],
    ['a path in another fixtures folder', join(REPO_ROOT, 'fixtures')],
  ] as const) {
    it(`refuses ${kind}`, () => {
      expect(() => loadFixtureCase(path)).toThrow(FixtureCaseError);
    });
  }

  it('refuses a nested file, a non-json file, bad JSON, a non-CaseFile and an oversized file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'affidavit-fixture-test-'));
    temps.push(dir);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.json'), '{}');
    writeFileSync(join(dir, 'case.txt'), '{}');
    writeFileSync(join(dir, 'bad.json'), '{not json');
    writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(join(dir, 'big.json'), ' '.repeat(300 * 1024));
    for (const f of ['sub/nested.json', 'case.txt', 'bad.json', 'wrong.json', 'big.json']) {
      expect(() => loadFixtureCase(join(dir, f), dir)).toThrow(FixtureCaseError);
    }
  });
});

describe('the P7 ladder', () => {
  const fixture = loadFixtureCase(FIXTURE);

  it('builds the worker Defense input with the real builder, in order of what it tells apart', () => {
    const ladder = buildFixtureLadder(DEFAULT_MODEL_TABLE, fixture, WORKER, 0.05);
    expect(ladder.map((p) => p.id)).toEqual([
      'P7a',
      'P7c:no-slices',
      'P7c:trivial',
      'P7b',
      'P7c:slices-only',
      'P7c:probe-budget',
    ]);
    const expected = renderPrompt('defense', defenseBlocks(fixture.caseFile, []));
    const p7a = ladder[0]!;
    expect(p7a.user.text).toBe(expected.user);
    expect(p7a.system.text).toBe(expected.system);
    expect(p7a).toMatchObject({ path: 'port', mode: 'live', turn: WORKER });
    expect(p7a.model).toBe(DEFAULT_MODEL_TABLE.defense);
    expect(ladder.find((p) => p.id === 'P7b')).toMatchObject({ mode: 'record', turn: WORKER });
    expect(ladder.find((p) => p.id === 'P7b')?.user.text).toBe(expected.user);
    const noSlices = ladder.find((p) => p.id === 'P7c:no-slices')!.user.text;
    expect(noSlices).toContain('source=candidate');
    expect(noSlices).not.toContain('source=case-file-slice');
    const slicesOnly = ladder.find((p) => p.id === 'P7c:slices-only')!.user.text;
    expect(slicesOnly).not.toContain('source=candidate');
    expect(slicesOnly).toContain('source=case-file-slice');
    expect(ladder.find((p) => p.id === 'P7c:probe-budget')?.turn).toEqual({
      maxTurns: 2,
      budget: { maxInputTokens: 200_000, maxOutputTokens: 2_000, maxUsd: 0.05 },
    });
    // The fixture text is marked as fixture input, never as synthetic; the trivial one is synthetic.
    expect(isFixtureText(p7a.user)).toBe(true);
    expect(isSynthetic(p7a.user)).toBe(false);
    expect(isSynthetic(p7a.system)).toBe(true);
    expect(isSynthetic(ladder.find((p) => p.id === 'P7c:trivial')!.user)).toBe(true);
  });

  it('is refused without allowFixtureInput, with no call made', async () => {
    const t = stubTransport(async function* () {
      await Promise.resolve();
      yield result('success');
    });
    const ladder = buildFixtureLadder(DEFAULT_MODEL_TABLE, fixture, WORKER, 0.05);
    const run = await runLadder(ladder, deps(t.transport), { maxUsd: 2 });
    expect(t.calls).toHaveLength(1); // only the synthetic P7c:trivial ran
    for (const r of run.results.filter((x) => x.id !== 'P7c:trivial')) {
      expect(r.status).toBe('REFUSED');
    }
  });

  it('passes the worker turn values to the SDK exactly as the worker would', async () => {
    const t = stubTransport(async function* () {
      await Promise.resolve();
      yield result('success', { usd: 0.01 });
    });
    const p7a = buildFixtureLadder(DEFAULT_MODEL_TABLE, fixture, WORKER, 0.05).slice(0, 1);
    const run = await runLadder(p7a, deps(t.transport), { maxUsd: 2, allowFixtureInput: true });
    const call = t.calls[0]!;
    expect(call.prompt).toBe(p7a[0]!.user.text);
    expect(call.options).toMatchObject({
      maxTurns: 6,
      maxBudgetUsd: 0.5,
      model: 'claude-opus-5-5',
    });
    const r = run.results[0]!;
    expect(r.turnUsed).toContain('maxTurns 6');
    expect(r.turnUsed).toContain('maxOutputTokens 8000');
    expect(r.optionsUsed).toContain('maxBudgetUsd 0.5');
    expect(r.optionsUsed).toContain('includePartialMessages false');
    expect(r.optionsUsed).toContain('resume unset');
    expect(r.userShape).toMatch(/^\d+ bytes, \d+ lines/);
  });
});

describe('a P7 refusal', () => {
  const fixture = loadFixtureCase(FIXTURE);
  const refusing: Script = async function* () {
    await Promise.resolve();
    yield refusalAssistant({
      explanation: `explanation mentioning ${CANARY_KEY}`,
      text: `API Error: Claude Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). key ${CANARY_KEY}`,
    });
    yield result('success', { isError: true, usd: 0, input: 0, output: 0, text: 'refused' });
  };

  it('is shown as class refusal with the redacted raw text, the options and the budget', async () => {
    const t = stubTransport(refusing);
    const p7a = buildFixtureLadder(DEFAULT_MODEL_TABLE, fixture, WORKER, 0.05).slice(0, 1);
    const run = await runLadder(p7a, deps(t.transport), { maxUsd: 2, allowFixtureInput: true });
    const r = run.results[0]!;
    expect(r).toMatchObject({ status: 'FAIL', errorClass: 'refusal', refusalCategory: 'cyber' });
    expect(r.rawMessage).toContain('safeguards flagged this message');
    expect(r.portMessage).toContain('provider error refusal');
    const printed = formatResult(r);
    expect(printed).toContain('refusal category: cyber');
    expect(printed).toContain('refusal explanation (redacted)');
    expect(printed).toContain('SDK options:');
    expect(printed).toContain('turn values:');
    expect(printed).not.toContain(CANARY_KEY);
    expect(printed).not.toContain('CANARY-DB-PASSWORD');
    // The child env is the port's minimal one: the worker's database URL never reaches it.
    expect(printed).toContain('env names [');
    expect(printed).not.toContain('AFFIDAVIT_WORKER_DATABASE_URL');
    // A refusal that reports no spend is charged the probe's whole turn USD, not zero.
    expect(run.chargedUsd).toBeCloseTo(0.5);
    const lines = interpret(run.results);
    expect(lines.some((l) => l.includes('REFUSED'))).toBe(true);
  });

  it('names the input, not the budget, when P7a fails and the trivial envelope passes', () => {
    const rs: ProbeResult[] = [
      { id: 'P7a', name: '', status: 'FAIL', errorClass: 'refusal', detail: '' },
      { id: 'P7c:trivial', name: '', status: 'PASS', detail: '' },
      { id: 'P7c:probe-budget', name: '', status: 'FAIL', detail: '' },
      { id: 'P7c:no-slices', name: '', status: 'PASS', detail: '' },
    ];
    const lines = interpret(rs).join('\n');
    expect(lines).toContain('the budget mapping is not the cause');
    expect(lines).toContain('the turn budget values are not the cause');
    expect(lines).toContain('the code slices are what the model or API refuses');
    expect(`${lines}\n${FIXTURE_BANNER}`).not.toContain('—');
  });
});

describe('P7b record mode', () => {
  const fixture = loadFixtureCase(FIXTURE);

  it('writes a recording to a temp dir, reports it, and removes the dir', async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((n) => n.startsWith('affidavit-probe-rec-')),
    );
    const t = stubTransport(async function* (h) {
      await h.callTool(qualifiedToolName('submit_witness'), GOOD_WITNESS);
      yield result('success', { usd: 0.01 });
    });
    const p7b = buildFixtureLadder(DEFAULT_MODEL_TABLE, fixture, WORKER, 0.05).filter(
      (p) => p.id === 'P7b',
    );
    const run = await runLadder(p7b, deps(t.transport), { maxUsd: 2, allowFixtureInput: true });
    const r = run.results[0]!;
    expect(r.status).toBe('PASS');
    expect(r.recording).toContain('1 recording file(s) written');
    expect(r.turnUsed).toContain('mode record');
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('affidavit-probe-rec-'));
    expect(after.filter((n) => !before.has(n))).toEqual([]);
  });
});

describe('worker turn values', () => {
  it('defaults to the worker defaults with the probe USD ceiling', () => {
    expect(workerTurnFrom({})).toEqual({ turn: WORKER_TURN_DEFAULTS, notes: [] });
  });

  it('reads the same variables as the worker and caps the USD', () => {
    const { turn, notes } = workerTurnFrom({
      AFFIDAVIT_AGENT_MAX_TURNS: '4',
      AFFIDAVIT_TURN_MAX_INPUT_TOKENS: '50000',
      AFFIDAVIT_TURN_MAX_OUTPUT_TOKENS: '4000',
      AFFIDAVIT_TURN_MAX_USD: '1',
    });
    expect(turn).toEqual({
      maxTurns: 4,
      budget: { maxInputTokens: 50_000, maxOutputTokens: 4_000, maxUsd: P7_MAX_TURN_USD },
    });
    expect(notes.join(' ')).toContain('capped');
  });

  it('notes and ignores values that are not usable', () => {
    const { turn, notes } = workerTurnFrom({ AFFIDAVIT_AGENT_MAX_TURNS: 'six' });
    expect(turn.maxTurns).toBe(6);
    expect(notes).toHaveLength(1);
  });
});

describe('describeOptions', () => {
  it('shows names and shapes, never env values, the key or the system prompt', () => {
    const o = buildAgentOptions({
      abortController: new AbortController(),
      workdir: join(tmpdir(), 'x'),
      tools: buildSubmitTools(['submit_witness'], new SubmissionBox()),
      system: 'SYSTEM-PROMPT-CANARY',
      model: 'claude-opus-5-5',
      maxTurns: 6,
      maxBudgetUsd: 0.5,
      key: CANARY_KEY,
      parentEnv: ENV,
    });
    const d = describeOptions(o);
    expect(d).toContain('ANTHROPIC_API_KEY');
    expect(d).not.toContain(CANARY_KEY);
    expect(d).not.toContain('SYSTEM-PROMPT-CANARY');
    expect(d).not.toContain('/usr/bin');
    expect(d).toContain('allowedTools [mcp__affidavit__submit_witness]');
  });
});
