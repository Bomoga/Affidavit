import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaseFile,
  samples,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type TrialEvent,
} from '@affidavit/contracts';
import { parseStagePayload, type StageEnv } from '@affidavit/db';
import type { DiscoverCaseOutcome } from '@affidavit/discovery';
import { DEFAULT_TRACE_ROOT } from '@affidavit/sandbox';
import { createModelPortFromEnv, resolveModelTable } from '@affidavit/trial';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '../config.js';
import { fakeJudge } from '../fakes/stages.js';
import { prepareCores } from '../handlers.js';
import {
  CaseFileMismatchError,
  IntakeRefusedError,
  NoSourceError,
  realIntakeCores,
  type Discover,
} from './intake.js';
import { PrerequisiteError, checkPrerequisites, realHostProbe, type HostProbe } from './prereqs.js';
import { TrialHaltedError, realTrialCores } from './trial.js';

const SECRET = 'hunter2-not-a-real-password';
const stored = CaseFile.parse(samples.CaseFile);
const REPO = stored.target.repo;

const realEnv: Record<string, string> = {
  AFFIDAVIT_APP_DATABASE_URL: `postgres://affidavit_app:${SECRET}@127.0.0.1:5432/affidavit`,
  AFFIDAVIT_WORKER_DATABASE_URL: `postgres://affidavit_worker:${SECRET}@127.0.0.1:5432/affidavit`,
  AFFIDAVIT_INTAKE_IMPL: 'real',
  AFFIDAVIT_TRIAL_IMPL: 'real',
  AFFIDAVIT_JUDGE_IMPL: 'real',
  AFFIDAVIT_JURY_ENABLED: 'false',
  AFFIDAVIT_INTAKE_WORK_ROOT: '/srv/affidavit/intake',
  AFFIDAVIT_REPO_SOURCES: JSON.stringify({ [REPO]: `https://bot:${SECRET}@git.example/r.git` }),
  AFFIDAVIT_TOOLRUNNER: 'gvisor',
  AFFIDAVIT_JUDGE_WORK_ROOT: '/srv/affidavit/judge',
  AFFIDAVIT_WITNESS_RUNNER_IMAGE: `sha256:${'a'.repeat(64)}`,
  AFFIDAVIT_EVIDENCE_DIR: '/srv/affidavit/evidence',
  AFFIDAVIT_SIGNER_SOCKET: '/run/affidavit/signer.sock',
};

function probe(overrides: Partial<HostProbe> = {}, missingDirs: string[] = []): HostProbe {
  return {
    platform: 'linux',
    isDirectory: (p) => Promise.resolve(!missingDirs.includes(p)),
    isSocket: () => Promise.resolve(true),
    isRegularFile: (p) => Promise.resolve(!missingDirs.includes(p)),
    dockerRuntimes: () => Promise.resolve(['runc', 'runsc', 'runsc-affidavit']),
    imagePresent: () => Promise.resolve(true),
    ...overrides,
  };
}

async function refusal(env: Record<string, string>, p: HostProbe): Promise<PrerequisiteError> {
  const err = await checkPrerequisites(loadConfig(env), p).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PrerequisiteError);
  const e = err as PrerequisiteError;
  expect(e.message).not.toContain(SECRET);
  expect(e.message).toContain('nothing was started');
  return e;
}

describe('real wiring config', () => {
  it('loads every real setting with conservative defaults', () => {
    const c = loadConfig(realEnv);
    expect(c.intakeSettings?.toolRunner).toBe('gvisor');
    expect(c.trialSettings?.killSwitch).toBe(false);
    expect(c.trialSettings?.turnBudget).toEqual({
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      maxUsd: 1,
    });
    expect(c.judgeSettings?.nodegoatBundle).toBeNull();
    expect(c.caseBudget.maxUsd).toBe(10);
  });

  it('refuses trial=real with the jury enabled (no jury handler yet)', () => {
    expect(() => loadConfig({ ...realEnv, AFFIDAVIT_JURY_ENABLED: 'true' })).toThrow(
      /AFFIDAVIT_TRIAL_IMPL=real needs AFFIDAVIT_JURY_ENABLED=false/,
    );
  });

  it('never echoes a repository source, in an error or in describeConfig', () => {
    const bad = `{"bad key with spaces":"https://bot:${SECRET}@x/y.git"}`;
    let err: unknown;
    try {
      loadConfig({ ...realEnv, AFFIDAVIT_REPO_SOURCES: bad });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).toContain('AFFIDAVIT_REPO_SOURCES');
    for (const v of [`{${SECRET}`, '[]', '{}']) {
      expect(() => loadConfig({ ...realEnv, AFFIDAVIT_REPO_SOURCES: v })).toThrow(ConfigError);
    }
    const described = JSON.stringify(describeConfig(loadConfig(realEnv)));
    expect(described).not.toContain(SECRET);
    expect(described).toContain(REPO);
  });
});

describe('startup prerequisites', () => {
  it('passes when every host fact is present', async () => {
    await expect(checkPrerequisites(loadConfig(realEnv), probe())).resolves.toBeUndefined();
  });

  const cases: [string, HostProbe, Record<string, string>, string][] = [
    [
      'a non-Linux host',
      probe({ platform: 'win32' }),
      {},
      'needs a Linux sandbox host with gVisor',
    ],
    [
      'an unreachable Docker daemon',
      probe({ dockerRuntimes: () => Promise.resolve(null) }),
      {},
      'the Docker daemon cannot be reached',
    ],
    [
      'no runsc runtime',
      probe({ dockerRuntimes: () => Promise.resolve(['runc', 'runsc-affidavit']) }),
      {},
      'Docker has no "runsc" runtime',
    ],
    [
      'no audit runtime',
      probe({ dockerRuntimes: () => Promise.resolve(['runc', 'runsc']) }),
      {},
      'Docker has no "runsc-affidavit" runtime',
    ],
    [
      'no intake work root',
      probe({}, ['/srv/affidavit/intake']),
      {},
      'AFFIDAVIT_INTAKE_WORK_ROOT is not an existing directory',
    ],
    [
      'no trace root',
      probe({}, [DEFAULT_TRACE_ROOT]),
      {},
      `the syscall trace directory ${DEFAULT_TRACE_ROOT} does not exist`,
    ],
    [
      'no judge work root',
      probe({}, ['/srv/affidavit/judge']),
      {},
      'AFFIDAVIT_JUDGE_WORK_ROOT is not an existing directory',
    ],
    [
      'no evidence directory',
      probe({}, ['/srv/affidavit/evidence']),
      {},
      'AFFIDAVIT_EVIDENCE_DIR is not an existing directory',
    ],
    [
      'no signer socket',
      probe({ isSocket: () => Promise.resolve(false) }),
      {},
      'AFFIDAVIT_SIGNER_SOCKET is not a listening unix socket',
    ],
    [
      'a NodeGoat bundle that is not there',
      probe({}, ['/srv/affidavit/nodegoat-bundle.tar']),
      { AFFIDAVIT_NODEGOAT_BUNDLE: '/srv/affidavit/nodegoat-bundle.tar' },
      'AFFIDAVIT_NODEGOAT_BUNDLE is set but is not an existing regular file',
    ],
    [
      'no witness runner image',
      probe({ imagePresent: () => Promise.resolve(false) }),
      {},
      'the AFFIDAVIT_WITNESS_RUNNER_IMAGE image is not present',
    ],
    [
      'an evidence store inside the judge work root',
      probe(),
      { AFFIDAVIT_EVIDENCE_DIR: '/srv/affidavit/judge/evidence' },
      'AFFIDAVIT_JUDGE_WORK_ROOT and AFFIDAVIT_EVIDENCE_DIR must not contain one another',
    ],
    [
      'an evidence store inside the intake work root',
      probe(),
      { AFFIDAVIT_EVIDENCE_DIR: '/srv/affidavit/intake/evidence' },
      'AFFIDAVIT_INTAKE_WORK_ROOT and AFFIDAVIT_EVIDENCE_DIR must not contain one another',
    ],
  ];

  it.each(cases)('refuses %s with a precise message', async (_name, p, extra, expected) => {
    const e = await refusal({ ...realEnv, ...extra }, p);
    expect(e.problems).toEqual([expect.stringContaining(expected)]);
  });

  it('takes the NodeGoat bundle as a regular file only: not a directory, not a symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'affidavit-bundle-'));
    try {
      const tar = join(dir, 'bundle.tar');
      writeFileSync(tar, 'not a real bundle');
      expect(await realHostProbe.isRegularFile(tar)).toBe(true);
      expect(await realHostProbe.isRegularFile(dir)).toBe(false);
      expect(await realHostProbe.isRegularFile(join(dir, 'missing.tar'))).toBe(false);
      const link = join(dir, 'link.tar');
      let linked = true;
      try {
        symlinkSync(tar, link);
      } catch {
        linked = false; // Windows without symlink rights: the lstat rule is the same.
      }
      if (linked) expect(await realHostProbe.isRegularFile(link)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists every missing piece at once', async () => {
    const e = await refusal(
      realEnv,
      probe({
        platform: 'darwin',
        isDirectory: () => Promise.resolve(false),
        isSocket: () => Promise.resolve(false),
        dockerRuntimes: () => Promise.resolve(['runc']),
        imagePresent: () => Promise.resolve(false),
      }),
    );
    const expected = [
      'Linux sandbox host',
      '"runsc" runtime',
      '"runsc-affidavit" runtime',
      'AFFIDAVIT_INTAKE_WORK_ROOT',
      DEFAULT_TRACE_ROOT,
      'AFFIDAVIT_JUDGE_WORK_ROOT',
      'AFFIDAVIT_EVIDENCE_DIR',
      'AFFIDAVIT_SIGNER_SOCKET',
      'AFFIDAVIT_WITNESS_RUNNER_IMAGE',
    ];
    expect(e.problems).toHaveLength(expected.length);
    expected.forEach((s, i) => expect(e.problems[i]).toContain(s));
  });

  it('checks only Docker for intake on plain Docker', async () => {
    const env = {
      AFFIDAVIT_APP_DATABASE_URL: realEnv.AFFIDAVIT_APP_DATABASE_URL!,
      AFFIDAVIT_WORKER_DATABASE_URL: realEnv.AFFIDAVIT_WORKER_DATABASE_URL!,
      AFFIDAVIT_INTAKE_IMPL: 'real',
      AFFIDAVIT_INTAKE_WORK_ROOT: '/srv/affidavit/intake',
      AFFIDAVIT_REPO_SOURCES: realEnv.AFFIDAVIT_REPO_SOURCES!,
    };
    const p = probe({ platform: 'win32', dockerRuntimes: () => Promise.resolve(['runc']) });
    await expect(checkPrerequisites(loadConfig(env), p)).resolves.toBeUndefined();
  });

  it('prepareCores refuses before building anything, and skips checks for injected parts', async () => {
    const config = loadConfig(realEnv);
    await expect(
      prepareCores(config, { env: realEnv, probe: probe({ platform: 'win32' }), log: () => {} }),
    ).rejects.toBeInstanceOf(PrerequisiteError);
    const logs: string[] = [];
    const cores = await prepareCores(config, {
      env: realEnv,
      probe: probe({ platform: 'win32', dockerRuntimes: () => Promise.resolve(null) }),
      discover: () => Promise.reject(new Error('unused')),
      judge: fakeJudge(),
      log: (m) => logs.push(m),
    });
    expect(Object.keys(cores).sort()).toEqual(
      ['arraign', 'defense', 'intake', 'jury', 'map', 'prosecution', 'remedy', 'verify'].sort(),
    );
    // The key is named, never valued, and only when it is missing.
    expect(logs).toEqual([expect.stringContaining('ANTHROPIC_API_KEY is not set')]);
    logs.length = 0;
    await prepareCores(config, {
      env: { ...realEnv, ANTHROPIC_API_KEY: SECRET },
      probe: probe(),
      discover: () => Promise.reject(new Error('unused')),
      judge: fakeJudge(),
      log: (m) => logs.push(m),
    });
    expect(logs).toEqual([]);
  });
});

/** A StageEnv over in-memory state, for one stage job. */
function stageEnv(stage: CaseStage, at: { stage: CaseStage }) {
  const events: TrialEvent[] = [];
  const transitions: CaseStage[] = [];
  const charges: unknown[] = [];
  let seq = 0;
  const store: CaseStore = {
    open: () => Promise.reject(new Error('unused')),
    stage: () => Promise.resolve(at.stage),
    transition: (_id: CaseId, to: CaseStage) => {
      transitions.push(to);
      at.stage = to;
      return Promise.resolve();
    },
    chargeBudget: (_id: CaseId, c: unknown) => {
      charges.push(c);
      return Promise.resolve();
    },
    nextSeq: () => Promise.resolve(seq++),
    appendVerdict: () => Promise.resolve(),
    getVerdict: () => Promise.resolve(null),
  } as unknown as CaseStore;
  const env: StageEnv = {
    job: parseStagePayload({ tenantId: stored.tenantId, caseId: stored.id, stage, attempt: 1 }),
    store,
    sink: {
      emit: (e: TrialEvent) => {
        events.push(e);
        return Promise.resolve();
      },
    },
    caseFiles: {
      next: () => Promise.resolve(null),
      get: () => Promise.resolve(stored),
    },
    signal: new AbortController().signal,
    events: () => Promise.resolve(events.filter((e) => e.stage === stage)),
    checkpoint: () => Promise.resolve(),
  };
  return { env, events, transitions, charges };
}

const sources = { [REPO]: `https://bot:${SECRET}@git.example/r.git` };
const reproduced: DiscoverCaseOutcome = {
  kind: 'case-file',
  caseFile: stored,
  withheld: [],
  scanPartial: false,
};

async function failure(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).not.toContain(SECRET);
  return err as Error;
}

describe('real intake cores', () => {
  it('moves a reproduced case intake, map, arraign, defense and runs discovery once', async () => {
    let calls = 0;
    const discover: Discover = (input) => {
      calls++;
      expect(input).toMatchObject({ repo: REPO, commit: stored.target.commit });
      expect(input.candidateId).toBe(stored.candidate.id);
      return Promise.resolve(reproduced);
    };
    const cores = realIntakeCores({ discover, sources });
    const at = { stage: 'intake' as CaseStage };
    for (const [stage, next] of [
      ['intake', 'map'],
      ['map', 'arraign'],
      ['arraign', 'defense'],
    ] as const) {
      const h = stageEnv(stage, at);
      await cores[stage]!(h.env);
      expect(h.transitions).toEqual([next]);
    }
    expect(calls).toBe(1);
  });

  it.each([
    [{ kind: 'unsupported', reason: 'no-package-json', detail: 'no package.json' }, 'unsupported'],
    [{ kind: 'incomplete', reason: 'partial-secret-scan', coverageLosses: 2 }, 'incomplete'],
  ] as const)('fails intake visibly on %o, with no transition', async (outcome, kind) => {
    const cores = realIntakeCores({ discover: () => Promise.resolve(outcome), sources });
    const h = stageEnv('intake', { stage: 'intake' });
    const err = await failure(cores.intake!(h.env));
    expect(err).toBeInstanceOf(IntakeRefusedError);
    expect(err.message).toContain(`(${kind})`);
    expect(h.transitions).toEqual([]);
  });

  it('fails arraign when real discovery does not reproduce the stored case file', async () => {
    const changed = CaseFile.parse({
      ...stored,
      candidate: { ...stored.candidate, score: stored.candidate.score === 1 ? 0.99 : 1 },
    });
    const cores = realIntakeCores({
      discover: () => Promise.resolve({ ...reproduced, caseFile: changed }),
      sources,
    });
    const h = stageEnv('arraign', { stage: 'arraign' });
    const err = await failure(cores.arraign!(h.env));
    expect(err).toBeInstanceOf(CaseFileMismatchError);
    expect(err.message).toContain('candidate');
    expect(h.transitions).toEqual([]);
  });

  it('never dismisses: a dismissal or a held candidate fails the job', async () => {
    for (const outcome of [
      { kind: 'not-found', candidateId: stored.candidate.id },
      {
        kind: 'review',
        candidateId: stored.candidate.id,
        wouldDismiss: 'below-floor',
        route: null,
        detail: 'held',
      },
    ] as unknown as DiscoverCaseOutcome[]) {
      const cores = realIntakeCores({ discover: () => Promise.resolve(outcome), sources });
      const h = stageEnv('map', { stage: 'map' });
      expect(await failure(cores.map!(h.env))).toBeInstanceOf(CaseFileMismatchError);
      expect(h.transitions).toEqual([]);
    }
  });

  it('names a repository with no source, without printing other sources', async () => {
    const cores = realIntakeCores({
      discover: () => Promise.resolve(reproduced),
      sources: { other: `https://bot:${SECRET}@git.example/o.git` },
    });
    const err = await failure(cores.intake!(stageEnv('intake', { stage: 'intake' }).env));
    expect(err).toBeInstanceOf(NoSourceError);
  });

  it('retries discovery after a failure instead of caching it', async () => {
    let calls = 0;
    const discover: Discover = () =>
      ++calls === 1 ? Promise.reject(new Error('clone failed')) : Promise.resolve(reproduced);
    const cores = realIntakeCores({ discover, sources });
    await failure(cores.intake!(stageEnv('intake', { stage: 'intake' }).env));
    const h = stageEnv('intake', { stage: 'intake' });
    await cores.intake!(h.env);
    expect(h.transitions).toEqual(['map']);
  });
});

describe('real trial cores', () => {
  const trialSettings = loadConfig(realEnv).trialSettings!;

  it('halts the case without charging when the model has no API key', async () => {
    // The real port from createModelPortFromEnv, live mode, with no key in its environment.
    const model = createModelPortFromEnv({}, { env: () => ({}) });
    const cores = realTrialCores({
      model,
      judge: fakeJudge(),
      modelTable: resolveModelTable({}),
      settings: trialSettings,
      maxStageAttempts: 3,
      killSwitch: () => false,
    });
    const h = stageEnv('defense', { stage: 'defense' });
    const err = await failure(cores.defense!(h.env));
    expect(err).toBeInstanceOf(TrialHaltedError);
    expect((err as TrialHaltedError).reason).toBe('model-unconfigured');
    expect(h.charges).toEqual([]);
    expect(h.transitions).toEqual([]);
  });

  it('halts on the kill switch without moving the case', async () => {
    const cores = realTrialCores({
      model: createModelPortFromEnv({}, { env: () => ({ ANTHROPIC_API_KEY: SECRET }) }),
      judge: fakeJudge(),
      modelTable: resolveModelTable({}),
      settings: trialSettings,
      maxStageAttempts: 3,
      killSwitch: () => true,
    });
    const h = stageEnv('defense', { stage: 'defense' });
    const err = await failure(cores.defense!(h.env));
    expect((err as TrialHaltedError).reason).toBe('kill-switch');
    expect(h.charges).toEqual([]);
    expect(h.transitions).toEqual([]);
  });

  it('refuses the jury stage (no jury handler yet)', async () => {
    const cores = realTrialCores({
      model: createModelPortFromEnv({}, { env: () => ({}) }),
      judge: fakeJudge(),
      modelTable: resolveModelTable({}),
      settings: trialSettings,
      maxStageAttempts: 3,
      killSwitch: () => false,
    });
    await expect(cores.jury!(stageEnv('jury', { stage: 'jury' }).env)).rejects.toThrow(/L3-11/);
  });
});
