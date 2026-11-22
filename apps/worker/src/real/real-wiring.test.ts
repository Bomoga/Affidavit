import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaseFile,
  ExhibitResult,
  samples,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type JudgePort,
  type ModelPort,
  type RescanPort,
  type StageCost,
  type TrialEvent,
} from '@affidavit/contracts';
import { GuardedCaseStore, parseStagePayload, reviewReasonOf, type StageEnv } from '@affidavit/db';
import { DiscoveryRescan, type DiscoverCaseOutcome } from '@affidavit/discovery';
import {
  FakeCaseStore,
  FakeEventSink,
  FakeJudge,
  FakeRescan,
  readFixtureJson,
} from '@affidavit/testing';
import { DEFAULT_TRACE_ROOT } from '@affidavit/sandbox';
import {
  ModelCallError,
  Orchestrator,
  createModelPortFromEnv,
  resolveModelTable,
  witnessExhibitId,
  witnessSha256,
} from '@affidavit/trial';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEPENDENCY_SCAN_WARNING,
  describeConfig,
  loadConfig,
  startupWarnings,
} from '../config.js';
import { fakeJudge } from '../fakes/stages.js';
import { prepareCores } from '../handlers.js';
import {
  CaseFileMismatchError,
  DiscoveryOutcomeError,
  IntakeRefusedError,
  NoSourceError,
  realIntakeCores,
  type Discover,
} from './intake.js';
import type { RealJudge, RealJudgeHostProbe } from '@affidavit/judge';
import { PrerequisiteError, checkPrerequisites, realHostProbe, type HostProbe } from './prereqs.js';
import { buildModel, realJudgeConfig } from './components.js';
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
  AFFIDAVIT_JUDGE_WORK_ROOT: '/srv/affidavit/judge',
  AFFIDAVIT_WITNESS_RUNNER_IMAGE: `sha256:${'a'.repeat(64)}`,
  AFFIDAVIT_PATCH_APPLY_IMAGE: `sha256:${'d'.repeat(64)}`,
  AFFIDAVIT_EVIDENCE_DIR: '/srv/affidavit/evidence',
  AFFIDAVIT_SIGNER_SOCKET: '/run/affidavit/signer.sock',
};

interface Host {
  probe: HostProbe;
  judge: RealJudgeHostProbe;
}

/** Both host probes, healthy unless told otherwise. */
function host(
  o: {
    platform?: NodeJS.Platform;
    missing?: string[];
    dockerInfo?: string[] | null;
    daemonConfig?: string[] | null;
    socket?: boolean;
    missingImages?: string[];
  } = {},
): Host {
  const missing = o.missing ?? [];
  const platform = o.platform ?? 'linux';
  const runtimes = ['runc', 'runsc', 'runsc-affidavit'];
  return {
    probe: {
      platform,
      isDirectory: (p) => Promise.resolve(!missing.includes(p)),
      isRegularFile: (p) => Promise.resolve(!missing.includes(p)),
      dockerRuntimes: () => Promise.resolve(o.dockerInfo === undefined ? runtimes : o.dockerInfo),
    },
    judge: {
      platform,
      isDirectory: (p) => Promise.resolve(!missing.includes(p)),
      isSocket: () => Promise.resolve(o.socket ?? true),
      realpath: (p) => Promise.resolve(missing.includes(p) ? null : p),
      dockerRuntimes: () =>
        Promise.resolve(o.daemonConfig === undefined ? runtimes : o.daemonConfig),
      imagePresent: (id) => Promise.resolve(!(o.missingImages ?? []).includes(id)),
      pins: () => [{ app: 'nodegoat', commit: 'pinned', bundleSha256: 'c'.repeat(64) }],
      pinBundle: () => Promise.resolve({} as Awaited<ReturnType<RealJudgeHostProbe['pinBundle']>>),
    },
  };
}

async function refusal(env: Record<string, string>, h: Host): Promise<PrerequisiteError> {
  const err = await checkPrerequisites(loadConfig(env), h.probe, h.judge).then(
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
    // Scanners run under gVisor unless plain Docker is asked for by name.
    expect(c.intakeSettings?.toolRunner).toBe('gvisor');
    expect(c.intakeSettings?.toolRunnerExplicit).toBe(false);
    expect(startupWarnings(c)).toEqual([DEPENDENCY_SCAN_WARNING]);
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
    const h = host();
    await expect(
      checkPrerequisites(loadConfig(realEnv), h.probe, h.judge),
    ).resolves.toBeUndefined();
  });

  const RUNNER = realEnv.AFFIDAVIT_WITNESS_RUNNER_IMAGE!;
  const APPLY = realEnv.AFFIDAVIT_PATCH_APPLY_IMAGE!;
  const BUNDLE = {
    AFFIDAVIT_NODEGOAT_BUNDLE: '/srv/bundles/nodegoat.tar',
    AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT: '/srv/bundles',
  };
  const cases: [string, Host, Record<string, string>, string[]][] = [
    [
      'a non-Linux host',
      host({ platform: 'win32' }),
      {},
      [
        'AFFIDAVIT_TOOLRUNNER=gvisor needs a Linux sandbox host with gVisor (this host is win32) (AFFIDAVIT_TOOLRUNNER is unset, so gVisor is the default; set AFFIDAVIT_TOOLRUNNER=docker',
        'the real Judge needs a Linux sandbox host with gVisor (this host is win32)',
      ],
    ],
    [
      'an unreachable Docker daemon',
      host({ dockerInfo: null }),
      {},
      ['the Docker daemon cannot be reached'],
    ],
    [
      'an unreadable Docker daemon config',
      host({ daemonConfig: null }),
      {},
      ['the Docker daemon config cannot be read (dockerDaemonConfig'],
    ],
    [
      'no runsc runtime',
      host({ daemonConfig: ['runc', 'runsc-affidavit'] }),
      {},
      ['Docker has no "runsc" runtime'],
    ],
    [
      'no audit runtime',
      host({ daemonConfig: ['runc', 'runsc'] }),
      {},
      ['Docker has no "runsc-affidavit" runtime'],
    ],
    [
      'no intake work root',
      host({ missing: ['/srv/affidavit/intake'] }),
      {},
      ['AFFIDAVIT_INTAKE_WORK_ROOT is not an existing directory'],
    ],
    [
      'no trace root',
      host({ missing: [DEFAULT_TRACE_ROOT] }),
      {},
      ['the syscall trace directory (traceRoot) does not exist'],
    ],
    [
      'no judge work root',
      host({ missing: ['/srv/affidavit/judge'] }),
      {},
      ['workRoot (AFFIDAVIT_JUDGE_WORK_ROOT) is not an existing directory'],
    ],
    [
      'no evidence directory',
      host({ missing: ['/srv/affidavit/evidence'] }),
      {},
      [
        'evidenceRoot (AFFIDAVIT_EVIDENCE_DIR) is not an existing directory',
        'the evidence store is rooted somewhere other than evidenceRoot',
      ],
    ],
    [
      'no signer socket',
      host({ socket: false }),
      {},
      ['signerSocket (AFFIDAVIT_SIGNER_SOCKET) is not a listening unix socket'],
    ],
    [
      'no witness runner image',
      host({ missingImages: [RUNNER] }),
      {},
      ['the runnerImage (AFFIDAVIT_WITNESS_RUNNER_IMAGE) image is not present locally'],
    ],
    [
      'no patch-apply image',
      host({ missingImages: [APPLY] }),
      {},
      ['the applyImage (AFFIDAVIT_PATCH_APPLY_IMAGE) image is not present locally'],
    ],
    [
      'a NodeGoat bundle that is not a regular file',
      host({ missing: [BUNDLE.AFFIDAVIT_NODEGOAT_BUNDLE] }),
      BUNDLE,
      ['AFFIDAVIT_NODEGOAT_BUNDLE is set but is not an existing regular file'],
    ],
    [
      'a NodeGoat tree that is not there',
      host({ missing: ['/srv/trees/nodegoat-safe'] }),
      {
        AFFIDAVIT_NODEGOAT_DIR: '/srv/trees/nodegoat',
        AFFIDAVIT_NODEGOAT_SAFE_DIR: '/srv/trees/nodegoat-safe',
      },
      ['AFFIDAVIT_NODEGOAT_SAFE_DIR is set but is not an existing directory'],
    ],
    [
      'an evidence store inside the judge work root',
      host(),
      { AFFIDAVIT_EVIDENCE_DIR: '/srv/affidavit/judge/evidence' },
      ['workRoot and evidenceRoot must not contain one another'],
    ],
    [
      'an evidence store inside the intake work root',
      host(),
      { AFFIDAVIT_EVIDENCE_DIR: '/srv/affidavit/intake/evidence' },
      ['AFFIDAVIT_INTAKE_WORK_ROOT and AFFIDAVIT_EVIDENCE_DIR must not contain one another'],
    ],
  ];

  it.each(cases)('refuses %s with a precise message', async (_name, h, extra, expected) => {
    const e = await refusal({ ...realEnv, ...extra }, h);
    expect(e.problems).toHaveLength(expected.length);
    expected.forEach((s, i) => expect(e.problems[i]).toContain(s));
  });

  it('passes a configured NodeGoat bundle and trees to the Judge check', async () => {
    const h = host();
    const env = {
      ...realEnv,
      ...BUNDLE,
      AFFIDAVIT_NODEGOAT_DIR: '/srv/trees/nodegoat',
      AFFIDAVIT_NODEGOAT_SAFE_DIR: '/srv/trees/nodegoat-safe',
    };
    await expect(checkPrerequisites(loadConfig(env), h.probe, h.judge)).resolves.toBeUndefined();
  });

  it('refuses Judge settings at load by variable name', () => {
    const load = (extra: Record<string, string | undefined>) => {
      try {
        loadConfig({ ...realEnv, ...extra });
        return '';
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
    };
    expect(load({ AFFIDAVIT_PATCH_APPLY_IMAGE: undefined })).toContain(
      'AFFIDAVIT_PATCH_APPLY_IMAGE is required',
    );
    expect(load({ AFFIDAVIT_PATCH_APPLY_IMAGE: 'latest' })).toContain(
      'AFFIDAVIT_PATCH_APPLY_IMAGE must be a local image ID',
    );
    expect(load({ AFFIDAVIT_NODEGOAT_BUNDLE: '/srv/bundles/nodegoat.tar' })).toContain(
      'AFFIDAVIT_NODEGOAT_BUNDLE needs AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT',
    );
    expect(load({ AFFIDAVIT_SWEEP_ORPHANS: 'yes' })).toContain('AFFIDAVIT_SWEEP_ORPHANS must be');
  });

  it('leaves the orphan sweep off unless asked', () => {
    expect(loadConfig(realEnv).judgeSettings?.sweepOrphans).toBe(false);
    expect(
      loadConfig({ ...realEnv, AFFIDAVIT_SWEEP_ORPHANS: '1' }).judgeSettings?.sweepOrphans,
    ).toBe(true);
    expect(
      loadConfig({ ...realEnv, AFFIDAVIT_SWEEP_ORPHANS: 'force' }).judgeSettings?.sweepOrphans,
    ).toBe('force');
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
      { ...realEnv, AFFIDAVIT_TOOLRUNNER: 'gvisor' },
      host({
        platform: 'darwin',
        missing: [
          '/srv/affidavit/intake',
          DEFAULT_TRACE_ROOT,
          '/srv/affidavit/judge',
          '/srv/affidavit/evidence',
        ],
        dockerInfo: ['runc'],
        daemonConfig: ['runc'],
        socket: false,
        missingImages: [RUNNER, APPLY],
      }),
    );
    const expected = [
      'AFFIDAVIT_TOOLRUNNER=gvisor needs a Linux sandbox host',
      'Docker has no "runsc" runtime (run docker/sandbox/install-gvisor.sh',
      'AFFIDAVIT_INTAKE_WORK_ROOT',
      'the real Judge needs a Linux sandbox host',
      '"runsc" runtime',
      '"runsc-affidavit" runtime',
      'traceRoot',
      'AFFIDAVIT_JUDGE_WORK_ROOT',
      'AFFIDAVIT_EVIDENCE_DIR',
      'the evidence store is rooted somewhere other than evidenceRoot',
      'AFFIDAVIT_WITNESS_RUNNER_IMAGE',
      'AFFIDAVIT_PATCH_APPLY_IMAGE',
      'AFFIDAVIT_SIGNER_SOCKET',
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
    const h = host({ platform: 'win32', dockerInfo: ['runc'] });
    // Unset: gVisor is the default, and this host has none, so it refuses and says how to opt out.
    const e = await refusal(env, h);
    expect(e.problems).toEqual([
      expect.stringContaining('set AFFIDAVIT_TOOLRUNNER=docker to scan under plain Docker'),
      expect.stringContaining('Docker has no "runsc" runtime'),
    ]);
    // Plain Docker only by name, with a startup warning.
    const docker = loadConfig({ ...env, AFFIDAVIT_TOOLRUNNER: 'docker' });
    expect(docker.intakeSettings?.toolRunnerExplicit).toBe(true);
    await expect(checkPrerequisites(docker, h.probe, h.judge)).resolves.toBeUndefined();
    expect(startupWarnings(docker)).toEqual([
      DEPENDENCY_SCAN_WARNING,
      expect.stringContaining(
        'AFFIDAVIT_TOOLRUNNER=docker: scanners run on untrusted repository content under plain Docker',
      ),
    ]);
    expect(startupWarnings(loadConfig({ ...env, AFFIDAVIT_TOOLRUNNER: 'gvisor' }))).toEqual([
      DEPENDENCY_SCAN_WARNING,
    ]);
    expect(() => loadConfig({ ...env, AFFIDAVIT_TOOLRUNNER: 'runc' })).toThrow(
      /AFFIDAVIT_TOOLRUNNER must be "docker" or "gvisor"/,
    );
  });

  it('prepareCores refuses before building anything, and skips checks for injected parts', async () => {
    const config = loadConfig(realEnv);
    const bad = host({ platform: 'win32' });
    await expect(
      prepareCores(config, {
        env: realEnv,
        probe: bad.probe,
        judgeProbe: bad.judge,
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(PrerequisiteError);
    const logs: string[] = [];
    const broken = host({ platform: 'win32', dockerInfo: null, daemonConfig: null });
    const prepared = await prepareCores(config, {
      env: realEnv,
      probe: broken.probe,
      judgeProbe: broken.judge,
      discover: () => Promise.reject(new Error('unused')),
      judge: fakeJudge(),
      log: (m) => logs.push(m),
    });
    expect(Object.keys(prepared.cores).sort()).toEqual(
      ['arraign', 'defense', 'intake', 'jury', 'map', 'prosecution', 'remedy', 'verify'].sort(),
    );
    await prepared.close();
    // The key is named, never valued, and only when it is missing.
    expect(logs).toEqual([
      `warning: ${DEPENDENCY_SCAN_WARNING}`,
      expect.stringContaining('ANTHROPIC_API_KEY is not set'),
    ]);
    logs.length = 0;
    const ok = host();
    await prepareCores(config, {
      env: { ...realEnv, ANTHROPIC_API_KEY: SECRET },
      probe: ok.probe,
      judgeProbe: ok.judge,
      discover: () => Promise.reject(new Error('unused')),
      judge: fakeJudge(),
      log: (m) => logs.push(m),
    });
    // Real intake always says the dependency scan is not run.
    expect(logs).toEqual([`warning: ${DEPENDENCY_SCAN_WARNING}`]);
  });

  /** A RealJudge stand-in that records whether it was closed. */
  function fakeRealJudge(notes: string[] = []) {
    const state = { built: 0, closed: 0 };
    const factory = () => {
      state.built++;
      return Promise.resolve({
        judge: fakeJudge(),
        notes,
        release: () => Promise.resolve(),
        close: () => {
          state.closed++;
          return Promise.resolve();
        },
      } as unknown as RealJudge);
    };
    return { state, factory };
  }

  it('lists host and environment problems in one error and never builds the Judge then', async () => {
    const config = loadConfig(realEnv);
    const { state, factory } = fakeRealJudge();
    const err = await prepareCores(config, {
      env: {
        ...realEnv,
        AFFIDAVIT_ESCALATION_FLOOR: '7',
        AFFIDAVIT_MODEL_MODE: 'sometimes',
        ANTHROPIC_MODEL_DEFENSE: 'not-a-model',
        ANTHROPIC_API_KEY: SECRET,
      },
      probe: host({ missing: ['/srv/affidavit/intake'] }).probe,
      judgeProbe: host().judge,
      realJudgeFactory: factory,
      log: () => {},
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PrerequisiteError);
    const problems = (err as PrerequisiteError).problems;
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('AFFIDAVIT_INTAKE_WORK_ROOT');
    expect(problems[1]).toContain('discovery: escalationFloor must be a number in 0..1');
    expect(problems[2]).toContain('the model port: AFFIDAVIT_MODEL_MODE');
    expect(problems[3]).toContain('the model table');
    expect((err as Error).message).not.toContain(SECRET);
    expect(state.built).toBe(0);
  });

  it('builds the Judge last and closes it when a later step throws', async () => {
    const config = loadConfig(realEnv);
    const h = host();
    const { state, factory } = fakeRealJudge(['no RescanPort']);
    const err = await prepareCores(config, {
      env: realEnv,
      probe: h.probe,
      judgeProbe: h.judge,
      discover: () => Promise.reject(new Error('unused')),
      realJudgeFactory: factory,
      log: (m) => {
        if (m.startsWith('real Judge:')) throw new Error('log sink is down');
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('log sink is down');
    expect(state).toEqual({ built: 1, closed: 1 });

    // A healthy start keeps it open until close().
    const ok = fakeRealJudge();
    const prepared = await prepareCores(config, {
      env: realEnv,
      probe: h.probe,
      judgeProbe: h.judge,
      discover: () => Promise.reject(new Error('unused')),
      realJudgeFactory: ok.factory,
      log: () => {},
    });
    expect(ok.state).toEqual({ built: 1, closed: 0 });
    await prepared.close();
    expect(ok.state).toEqual({ built: 1, closed: 1 });
  });
});

describe('the real Judge re-scan (L1-17)', () => {
  /** A RealJudge factory that records the RescanPort it was handed. */
  function recordingFactory() {
    const seen: { rescan: RescanPort | undefined; calls: number } = { rescan: undefined, calls: 0 };
    const factory = (_s: unknown, _p?: unknown, rescan?: RescanPort) => {
      seen.calls++;
      seen.rescan = rescan;
      return Promise.resolve({
        judge: fakeJudge(),
        notes: [],
        release: () => Promise.resolve(),
        close: () => Promise.resolve(),
      } as unknown as RealJudge);
    };
    return { seen, factory };
  }

  it('hands the real Judge the discovery re-scan when intake is real', async () => {
    const h = host();
    const { seen, factory } = recordingFactory();
    const prepared = await prepareCores(loadConfig(realEnv), {
      env: realEnv,
      probe: h.probe,
      judgeProbe: h.judge,
      discover: () => Promise.reject(new Error('unused')),
      realJudgeFactory: factory,
      log: () => {},
    });
    expect(seen.calls).toBe(1);
    expect(seen.rescan).toBeInstanceOf(DiscoveryRescan);
    await prepared.close();
  });

  it('passes an injected RescanPort through unchanged (fake-backed)', async () => {
    const h = host();
    const { seen, factory } = recordingFactory();
    const fake = new FakeRescan({ clean: false });
    const prepared = await prepareCores(loadConfig(realEnv), {
      env: realEnv,
      probe: h.probe,
      judgeProbe: h.judge,
      discover: () => Promise.reject(new Error('unused')),
      realJudgeFactory: factory,
      rescan: fake,
      log: () => {},
    });
    expect(seen.rescan).toBe(fake);
    expect(await seen.rescan?.rescan(stored, '/unused')).toEqual({ clean: false, candidates: [] });
    await prepared.close();
  });

  it('has no re-scan without real intake, so verifyPatch keeps failing closed', async () => {
    const env = { ...realEnv, AFFIDAVIT_INTAKE_IMPL: 'fake' };
    const h = host();
    const { seen, factory } = recordingFactory();
    const prepared = await prepareCores(loadConfig(env), {
      env,
      probe: h.probe,
      judgeProbe: h.judge,
      realJudgeFactory: factory,
      log: () => {},
    });
    expect(seen.calls).toBe(1);
    expect(seen.rescan).toBeUndefined();
    await prepared.close();
  });

  it('puts the re-scan on the RealJudgeConfig, and leaves it off when there is none', () => {
    const s = loadConfig(realEnv).judgeSettings!;
    const fake = new FakeRescan();
    expect(realJudgeConfig(s, fake).rescan).toBe(fake);
    expect('rescan' in realJudgeConfig(s)).toBe(false);
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
  holds: [],
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

  const otherOutcomes: [DiscoverCaseOutcome, string][] = [
    [{ kind: 'not-found', candidateId: stored.candidate.id, holds: [] }, 'not found'],
    [
      {
        kind: 'review',
        candidateId: stored.candidate.id,
        wouldDismiss: 'unreachable',
        route: 'person-or-trial',
        detail: 'the map found no path to it (no-route)',
        holds: [],
      },
      'held for review (F3: would dismiss as unreachable, route person-or-trial)',
    ],
    [
      {
        kind: 'dismissed',
        dismissal: {
          schemaVersion: 1,
          candidateId: stored.candidate.id,
          reason: 'below-threshold',
          detail: 'score 0.1 is below the dismissal threshold 0.2',
        },
        holds: [],
      },
      'would be dismissed (below-threshold)',
    ],
  ];

  it.each(otherOutcomes)(
    'never dismisses, and names the outcome: %o fails intake and map precisely',
    async (outcome, label) => {
      for (const stage of ['intake', 'map', 'arraign'] as const) {
        const cores = realIntakeCores({ discover: () => Promise.resolve(outcome), sources });
        const h = stageEnv(stage, { stage });
        const err = await failure(cores[stage]!(h.env));
        expect(err).toBeInstanceOf(DiscoveryOutcomeError);
        expect(err).not.toBeInstanceOf(CaseFileMismatchError);
        expect((err as DiscoveryOutcomeError).outcome).toBe(outcome.kind);
        expect(err.message).toContain(`${stage}: `);
        expect(err.message).toContain(label);
        expect(err.message).toContain('never dismissed here');
        expect(err.message).not.toContain('does not reproduce');
        expect(h.transitions).toEqual([]);
      }
    },
  );

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

  it('reads the API key from the sealed snapshot, never from process.env', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'would-be-used-if-read-from-process-env';
    try {
      // buildModel is what prepareCores uses; the snapshot (sealSecrets) has no key.
      const cores = realTrialCores({
        model: buildModel({}, () => false),
        judge: fakeJudge(),
        modelTable: resolveModelTable({}),
        settings: trialSettings,
        maxStageAttempts: 3,
        killSwitch: () => false,
      });
      const h = stageEnv('defense', { stage: 'defense' });
      const err = await failure(cores.defense!(h.env));
      expect((err as TrialHaltedError).reason).toBe('model-unconfigured');
      expect(h.charges).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
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

  it('names the halt reason, and only a model refusal skips the retries', () => {
    const cases = [
      ['kill-switch', /kill switch is on/, undefined],
      ['model-unconfigured', /ANTHROPIC_API_KEY missing or refused/, undefined],
      [
        'model-refusal',
        /refused the request on safety grounds; flagged for review/,
        'model-refusal',
      ],
      ['budget-exhausted', /case budget is exhausted/, undefined],
    ] as const;
    for (const [reason, text, review] of cases) {
      const err = new TrialHaltedError('defense', reason);
      expect(err.message).toMatch(text);
      expect(err.message, reason).not.toMatch(reason === 'kill-switch' ? /model/ : /kill switch/);
      expect(err.message).not.toContain('—');
      expect(reviewReasonOf(err)).toBe(review);
    }
  });

  /**
   * A Defense job over the reference fakes, at the case's defense stage. `seedEntered` stores a
   * `stage-entered` for defense first, as the arraign job leaves behind in production (its
   * orchestrator run emits the next stage's entry before the job stops).
   */
  async function defenseJob(withRelease = true, seedEntered = false) {
    const events = new FakeEventSink();
    const fake = new FakeCaseStore({ events, juryEnabled: false });
    await fake.open(stored, { maxInputTokens: 1_000_000, maxOutputTokens: 200_000, maxUsd: 2 });
    for (const to of ['map', 'arraign', 'defense'] as const) await fake.transition(stored.id, to);
    // Earlier stages' events, so stored seqs and the orchestrator's placeholders differ.
    for (const stage of seedEntered
      ? (['map', 'arraign', 'defense'] as const)
      : (['map', 'arraign'] as const)) {
      await events.emit({
        schemaVersion: 1,
        caseId: stored.id,
        seq: await fake.nextSeq(stored.id),
        stage,
        at: new Date(0).toISOString(),
        actor: 'stenographer',
        type: 'stage-entered',
        payload: stage === 'defense' ? { from: 'arraign' } : {},
      });
    }
    const inner: CaseStore = withRelease
      ? fake
      : ({
          open: (f, b) => fake.open(f, b),
          stage: (id) => fake.stage(id),
          transition: (id, to) => fake.transition(id, to),
          chargeBudget: (id, c) => fake.chargeBudget(id, c),
          nextSeq: (id) => fake.nextSeq(id),
          appendVerdict: (v) => fake.appendVerdict(v),
          getVerdict: (id) => fake.getVerdict(id),
        } satisfies CaseStore);
    const signal = new AbortController().signal;
    const env: StageEnv = {
      job: parseStagePayload({
        tenantId: stored.tenantId,
        caseId: stored.id,
        stage: 'defense',
        attempt: 1,
      }),
      store: new GuardedCaseStore(inner, signal),
      sink: events,
      caseFiles: { next: () => Promise.resolve(null), get: () => Promise.resolve(stored) },
      signal,
      events: (id) => Promise.resolve(events.events(id).filter((e) => e.stage === 'defense')),
      checkpoint: () => Promise.resolve(),
    };
    return { env, fake, events };
  }

  describe('settlement of an up-front charge (contracts v1.2, CR-T1)', () => {
    /** A port that fails every call and reports what it spent (illustrative amounts). */
    const spent: StageCost = {
      stage: 'defense',
      attempt: 1,
      inputTokens: 1_000,
      outputTokens: 0,
      usd: 0.003,
      wallMs: 5,
    };
    const failingModel: ModelPort = {
      runTurn: () =>
        Promise.reject(new ModelCallError('the provider refused the request', { cost: spent })),
    };

    function cores() {
      return realTrialCores({
        model: failingModel,
        judge: fakeJudge(),
        modelTable: resolveModelTable({}),
        settings: trialSettings,
        maxStageAttempts: 3,
        killSwitch: () => false,
      });
    }

    /** The settlement checks shared by the shapes below. */
    function expectReleasedAgainstStoredCharges(
      fake: FakeCaseStore,
      events: FakeEventSink,
      minSeq: number,
    ) {
      const charges = events.events(stored.id).filter((e) => e.type === 'cost-charged');
      expect(charges.length).toBeGreaterThan(0);
      const charged = charges[0]!;
      if (charged.type !== 'cost-charged') throw new Error('unreachable');
      expect(charged.seq).toBeGreaterThanOrEqual(minSeq);
      const released = fake.releases(stored.id);
      expect([...released.keys()]).toContain(charged.seq);
      const refund = released.get(charged.seq)!;
      const cap = charged.payload.cost;
      expect(refund).toMatchObject({ stage: 'defense', attempt: 1 });
      expect(refund.inputTokens).toBe(cap.inputTokens - spent.inputTokens);
      expect(refund.outputTokens).toBe(cap.outputTokens);
      expect(refund.usd).toBeCloseTo(cap.usd - spent.usd, 6);
      // Every release names a charge event this job really stored.
      const chargeSeqs = charges.map((e) => e.seq);
      for (const seq of released.keys()) expect(chargeSeqs).toContain(seq);
    }

    it('gives back the unspent part of the charge, naming the stored seq of its event', async () => {
      const { env, fake, events } = await defenseJob();
      await cores().defense!(env).catch(() => undefined);
      expectReleasedAgainstStoredCharges(fake, events, 2);
    });

    it('settles in the production shape: the arraign job already stored the defense stage-entered', async () => {
      const { env, fake, events } = await defenseJob(true, true);
      await cores().defense!(env).catch(() => undefined);
      // The orchestrator's own stage-entered for defense was dropped (the visit has one), so its
      // placeholder seq has no stored event; the release still names the stored charge.
      const entered = events
        .events(stored.id)
        .filter((e) => e.type === 'stage-entered' && e.stage === 'defense');
      expect(entered).toHaveLength(1);
      expect(entered[0]!.seq).toBe(2);
      expectReleasedAgainstStoredCharges(fake, events, 3);
      // Stored seqs have no gap where the dropped event would have been.
      const seqs = events.events(stored.id).map((e) => e.seq);
      expect(seqs).toEqual([...seqs.keys()]);
    });

    it('leaves the charge standing when the store cannot release', async () => {
      const { env, fake, events } = await defenseJob(false);
      await cores().defense!(env).catch(() => undefined);
      expect(events.events(stored.id).some((e) => e.type === 'cost-charged')).toBe(true);
      expect(fake.releases(stored.id).size).toBe(0);
    });
  });

  describe('one stage per job (the stop hook), against the installed orchestrator', () => {
    const W = { template: 'witness template', params: [{ name: 'n', values: [1, 2] }] };
    const ADMITTED = ExhibitResult.parse(readFixtureJson('exhibit-results/admissible.json'));
    const turnCost: StageCost = {
      stage: 'defense',
      attempt: 1,
      inputTokens: 10,
      outputTokens: 5,
      usd: 0.01,
      wallMs: 1,
    };

    /** Defense submits a witness the Judge admits, so the stage advances to prosecution. */
    function advancingCores(killSwitch: () => boolean | Promise<boolean>) {
      const requests: string[] = [];
      const model: ModelPort = {
        runTurn: (req) => {
          requests.push(req.promptId);
          return Promise.resolve({ outcome: 'submitted', submission: W, cost: turnCost });
        },
      };
      const fakeJ = new FakeJudge({
        witnessResults: { [witnessSha256(W.template, W.params)]: ADMITTED },
      });
      // The Judge stamps the exhibit id it ran, as the real one does.
      const judge: JudgePort = {
        runCounterexample: fakeJ.runCounterexample.bind(fakeJ),
        verifyPatch: fakeJ.verifyPatch.bind(fakeJ),
        runWitness: async (...a: Parameters<FakeJudge['runWitness']>) => ({
          ...(await fakeJ.runWitness(...a)),
          exhibitId: witnessExhibitId(a[0].id, a[1].template, a[1].params),
        }),
      };
      const cores = realTrialCores({
        model,
        judge,
        modelTable: resolveModelTable({}),
        settings: trialSettings,
        maxStageAttempts: 3,
        killSwitch,
      });
      return { cores, requests };
    }

    /**
     * Whether the installed @affidavit/trial reads `stopAfterTransition` (PR #84). TEMPORARY and
     * deliberately crude (a text search of the class source; a rename or minifier would fool it).
     * Remove it, and make the gated test below unconditional, in the Lane 1 follow-up that drops
     * the `quietStop` fallback in trial.ts once #84 is merged to main.
     */
    const orchestratorReadsStopHook = /stopAfterTransition/.test(Orchestrator.toString());

    async function runDefense(killSwitch: () => boolean | Promise<boolean>) {
      const { env, fake, events } = await defenseJob(true, true);
      const { cores, requests } = advancingCores(killSwitch);
      const error = await cores.defense!(env).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { error, fake, events, requests };
    }

    it('moves the case exactly one stage, then the job ends', async () => {
      const { error, fake, events, requests } = await runDefense(() => false);
      expect(error).toBeUndefined();
      expect(await fake.stage(stored.id)).toBe('prosecution');
      // Only Defense ran a model turn; Prosecution is the next job's.
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((p) => p.startsWith('defense'))).toBe(true);
      const all = events.events(stored.id);
      expect(all.filter((e) => e.type === 'stage-exited').map((e) => e.stage)).toEqual(['defense']);
      expect(all.some((e) => e.stage === 'prosecution' && e.type !== 'stage-entered')).toBe(false);
    });

    it('never reports a normal advance as a kill-switch halt', async () => {
      const { error, events } = await runDefense(() => false);
      expect(error).toBeUndefined();
      expect(events.events(stored.id).filter((e) => e.type === 'halted')).toEqual([]);
    });

    it('still halts on a real kill switch, without moving the case', async () => {
      const { error, fake, events, requests } = await runDefense(() => true);
      expect(error).toBeInstanceOf(TrialHaltedError);
      expect((error as TrialHaltedError).reason).toBe('kill-switch');
      expect(reviewReasonOf(error)).toBeUndefined();
      expect(await fake.stage(stored.id)).toBe('defense');
      expect(requests).toEqual([]);
      expect(events.events(stored.id).some((e) => e.type === 'cost-charged')).toBe(false);
    });

    it('still halts when the kill switch turns on during the stage, before it moves', async () => {
      let calls = 0;
      // Off for the stage's first check, on from the next check (before the model call) on.
      const { error, fake, requests } = await runDefense(() => ++calls > 1);
      expect(error).toBeInstanceOf(TrialHaltedError);
      expect((error as TrialHaltedError).reason).toBe('kill-switch');
      expect(await fake.stage(stored.id)).toBe('defense');
      expect(requests).toEqual([]);
    });

    // Runs only once #84 (Lane 3, `stopAfterTransition`) is installed; make it unconditional when
    // it merges. Its orchestrator emits a `halted` event when the kill switch stops a run, so this
    // proves the worker stops through the quiet hook. Then drop the kill-switch fallback in
    // trial.ts (see docs/lanes/lane1/contract-requests.md).
    it.runIf(orchestratorReadsStopHook)(
      '#84: stops through stopAfterTransition, with no halted event of any reason',
      async () => {
        const { error, fake, events } = await runDefense(() => false);
        expect(error).toBeUndefined();
        expect(await fake.stage(stored.id)).toBe('prosecution');
        expect(events.events(stored.id).filter((e) => e.type === 'halted')).toEqual([]);
        // The real switch still halts with the hook in place.
        const killed = await runDefense(() => true);
        expect((killed.error as TrialHaltedError).reason).toBe('kill-switch');
      },
    );
  });
});
