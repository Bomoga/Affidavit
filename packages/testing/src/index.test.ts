import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  VerdictAlreadyWrittenError,
  samples,
  type Budget,
  type CaseFile,
  type CaseId,
  type ExhibitResult,
  type TrialEvent,
  type Verdict,
  type Witness,
  type StageCost,
} from '@affidavit/contracts';
import {
  FakeCaseFileSource,
  FakeCaseStore,
  FakeEventSink,
  FakeEvidenceStore,
  FakeJudge,
  FakeSigner,
  NoRecordingError,
  NoScriptedResultError,
  ReplayModel,
  ZERO_COST,
  buildDockerRunArgs,
  readFixtureJson,
  recordingKey,
  sha256Hex,
} from './index.js';
import {
  BundleManifest,
  CaseFile as CaseFileSchema,
  ExhibitResult as ResultSchema,
} from '@affidavit/contracts';

const caseFile = CaseFileSchema.parse(readFixtureJson('casefiles/nodegoat-sqli-001.json'));
const budget: Budget = { maxInputTokens: 1000, maxOutputTokens: 1000, maxUsd: 1 };
const cost = (over: Partial<StageCost> = {}): StageCost => ({
  stage: 'defense',
  inputTokens: 100,
  outputTokens: 10,
  usd: 0.1,
  wallMs: 5,
  attempt: 1,
  ...over,
});

async function storeAt(
  stage: Parameters<FakeCaseStore['transition']>[1],
  file: CaseFile = caseFile,
  jury = true,
) {
  const store = new FakeCaseStore({ juryEnabled: jury });
  await store.open(file, budget);
  const path = ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'] as const;
  for (const s of path) {
    if ((await store.stage(file.id)) === stage) break;
    await store.transition(file.id, s);
  }
  return store;
}

describe('FakeJudge', () => {
  const witness = ResultSchema.parse(samples['ExhibitResult']);
  const w = samples['Witness'] as Witness;

  it('returns the scripted result keyed by witness sha256', async () => {
    const judge = new FakeJudge({ witnessResults: { [w.sha256]: witness } });
    await expect(judge.runWitness(caseFile, w, ['vulnerable'])).resolves.toEqual(witness);
    expect(judge.calls).toEqual([
      { method: 'runWitness', sha256: w.sha256, variants: ['vulnerable'] },
    ]);
  });

  it('fails loudly on an unscripted witness instead of passing', async () => {
    const judge = new FakeJudge({ witnessResults: {} });
    await expect(judge.runWitness(caseFile, w, ['vulnerable'])).rejects.toBeInstanceOf(
      NoScriptedResultError,
    );
  });

  it('returns an inadmissible result as a value, not an error', async () => {
    const rejected = ResultSchema.parse(
      readFixtureJson('exhibit-results/rejected-differential.json'),
    );
    const judge = new FakeJudge({ witnessResults: { [w.sha256]: rejected } });
    const r: ExhibitResult = await judge.runWitness(caseFile, w, ['vulnerable', 'safe']);
    expect(r.admissible).toBe(false);
  });
});

describe('FakeCaseStore', () => {
  it('walks the happy path and rejects an illegal jump', async () => {
    const store = await storeAt('defense');
    await expect(store.transition(caseFile.id, 'verdict')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await store.transition(caseFile.id, 'prosecution');
    expect(await store.stage(caseFile.id)).toBe('prosecution');
  });

  it('refuses to dismiss a case at or above the escalation floor (F3)', async () => {
    const store = await storeAt('defense');
    await expect(store.transition(caseFile.id, 'dismissed')).rejects.toThrow(/escalation floor/);
    await store.transition(caseFile.id, 'escalated');
  });

  it('allows dismissal below the floor', async () => {
    const low: CaseFile = { ...caseFile, candidate: { ...caseFile.candidate, score: 0.1 } };
    const store = await storeAt('defense', low);
    await store.transition(low.id, 'dismissed');
    expect(await store.stage(low.id)).toBe('dismissed');
  });

  it('allows at most two appeals', async () => {
    const store = await storeAt('verify');
    for (let i = 0; i < 2; i++) {
      await store.transition(caseFile.id, 'remedy');
      await store.transition(caseFile.id, 'verify');
    }
    await expect(store.transition(caseFile.id, 'remedy')).rejects.toThrow(/appeal limit/);
  });

  it('routes verify to jury when enabled and to verdict when disabled', async () => {
    const on = await storeAt('verify');
    await expect(on.transition(caseFile.id, 'verdict')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await on.transition(caseFile.id, 'jury');

    const off = await storeAt('verify', caseFile, false);
    await expect(off.transition(caseFile.id, 'jury')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await off.transition(caseFile.id, 'verdict');
  });

  it('charges the budget and reports exhaustion without throwing', async () => {
    const store = await storeAt('defense');
    const first = await store.chargeBudget(caseFile.id, cost());
    expect(first).toMatchObject({ remainingInputTokens: 900, remainingUsd: 0.9, exhausted: false });
    const last = await store.chargeBudget(caseFile.id, cost({ usd: 0.9 }));
    expect(last.exhausted).toBe(true);
    expect(store.charges(caseFile.id)).toHaveLength(2);
  });

  it('hands out increasing sequence numbers per case', async () => {
    const store = await storeAt('defense');
    expect([await store.nextSeq(caseFile.id), await store.nextSeq(caseFile.id)]).toEqual([0, 1]);
  });

  it('verdicts are append-only', async () => {
    const store = await storeAt('defense');
    const v = samples['Verdict'] as Verdict;
    await store.appendVerdict(v);
    await expect(store.appendVerdict(v)).rejects.toBeInstanceOf(VerdictAlreadyWrittenError);
    expect(await store.getVerdict(v.caseId)).toEqual(v);
  });
});

describe('FakeEventSink', () => {
  it('is idempotent on (caseId, seq) and orders by seq', async () => {
    const sink = new FakeEventSink();
    const base = samples['TrialEvent'] as TrialEvent;
    await sink.emit({ ...base, seq: 1 });
    await sink.emit({ ...base, seq: 0 });
    await sink.emit({ ...base, seq: 1, actor: 'judge' });
    expect(sink.events().map((e) => [e.seq, e.actor])).toEqual([
      [0, 'stenographer'],
      [1, 'stenographer'],
    ]);
  });
});

describe('FakeCaseFileSource', () => {
  it('serves each case once per tenant and by id', async () => {
    const src = new FakeCaseFileSource([caseFile]);
    expect(await src.get(caseFile.id)).toEqual(caseFile);
    expect(await src.get('missing' as CaseId)).toBeNull();
    expect((await src.next(caseFile.tenantId))?.id).toBe(caseFile.id);
    expect(await src.next(caseFile.tenantId)).toBeNull();
  });
});

describe('FakeEvidenceStore', () => {
  it('is content addressed and rejects non-hash keys', async () => {
    const store = new FakeEvidenceStore();
    const bytes = new TextEncoder().encode('exhibit bytes');
    const sha = await store.put(bytes);
    expect(sha).toBe(sha256Hex(bytes));
    expect(await store.get(sha)).toEqual(Buffer.from(bytes));
    expect(await store.get('../escape')).toBeNull();
  });
});

describe('FakeSigner', () => {
  it('produces a schema-valid attestation', async () => {
    const manifest = BundleManifest.parse(samples['BundleManifest']);
    const att = await new FakeSigner().sign(manifest);
    expect(att.signature.length).toBeGreaterThan(0);
    expect(att.statement.subject[0]?.digest.sha256).toBe(sha256Hex(JSON.stringify(manifest)));
  });
});

describe('ReplayModel', () => {
  const base = {
    promptId: 'defense',
    promptVersion: 'v1',
    model: 'm',
    system: 's',
    user: 'wrapped untrusted content',
    tools: ['submit_witness'] as const,
    outputSchemaRef: 'Witness',
    maxTurns: 3,
    budget,
  };

  it('replays by prompt id, version, and input hash, and throws when unscripted', async () => {
    const recorded = {
      outcome: 'submitted' as const,
      submission: { ok: true },
      cost: { ...ZERO_COST, stage: 'defense' as const },
    };
    const model = new ReplayModel(new Map([[recordingKey('defense', 'v1', base.user), recorded]]));
    await expect(model.runTurn(base)).resolves.toEqual(recorded);
    await expect(model.runTurn({ ...base, user: 'other' })).rejects.toBeInstanceOf(
      NoRecordingError,
    );
  });
});

describe('tool runner arguments', () => {
  it('always disables network, privileges, and writable root', () => {
    const args = buildDockerRunArgs(
      'img@sha256:x',
      ['scan'],
      [{ hostPath: '/repo', containerPath: '/src', readOnly: true }],
    );
    expect(args).toContain('--read-only');
    expect(args.join(' ')).toContain('--network none');
    expect(args).not.toContain('--privileged');
    expect(args).toContain('/repo:/src:ro');
  });

  it('refuses to mount the Docker socket', () => {
    expect(() =>
      buildDockerRunArgs(
        'img',
        [],
        [{ hostPath: '/var/run/docker.sock', containerPath: '/s', readOnly: false }],
      ),
    ).toThrow(/socket/);
  });
});
