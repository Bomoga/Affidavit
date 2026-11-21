import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceStore, SignerPort } from '@affidavit/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEASE_SCHEMA } from './lease.js';
import { gateCaseFile, gateWitness, GATE_PATCH_DIFF, patchExhibit } from '../test-helpers.js';
import {
  checkRealJudgePrerequisites,
  createRealJudge,
  RealJudgePrerequisiteError,
  type RealJudgeConfig,
  type RealJudgeHostProbe,
} from './real.js';
import type { TargetBootDeps } from './targets.js';

// Distinctive markers: no message may echo a configured value.
const SECRETISH = 'zz-marker-7f3a';
const WORK = `/srv/${SECRETISH}/judge`;
const EVIDENCE = `/srv/${SECRETISH}/evidence`;
const SOCKET = `/run/${SECRETISH}/signer.sock`;
const BUNDLE = `/srv/${SECRETISH}/bundles/nodegoat.tar`;
const STORE = `/srv/${SECRETISH}/bundles`;
const RUNNER = `sha256:${'1'.repeat(64)}`;
const APPLY = `sha256:${'2'.repeat(64)}`;
const COMMIT = 'c5cb68a7084e4ae7dcc60e6a98768720a81841e8';

const store: EvidenceStore & { root: string } = {
  root: EVIDENCE,
  put: () => Promise.resolve('0'.repeat(64)),
  get: () => Promise.resolve(null),
};
const signer: SignerPort = { sign: () => Promise.reject(new Error('not in this test')) };

const config = (over: Partial<RealJudgeConfig> = {}): RealJudgeConfig => ({
  workRoot: WORK,
  runnerImage: RUNNER,
  applyImage: APPLY,
  evidenceRoot: EVIDENCE,
  evidence: store,
  signerSocket: SOCKET,
  signer,
  sources: (_cf, v) => Promise.resolve({ ok: true, dir: `/src/${v}` }),
  dependencyBundles: [{ app: 'nodegoat', repo: 'repo-nodegoat', path: BUNDLE, storeRoot: STORE }],
  rescan: { rescan: () => Promise.resolve({ clean: true, candidates: [] }) },
  ...over,
});

const goodProbe = (over: Partial<RealJudgeHostProbe> = {}): RealJudgeHostProbe => ({
  platform: 'linux',
  isDirectory: () => Promise.resolve(true),
  isSocket: () => Promise.resolve(true),
  realpath: (p) => Promise.resolve(p),
  dockerRuntimes: () => Promise.resolve(['runc', 'runsc', 'runsc-affidavit']),
  imagePresent: () => Promise.resolve(true),
  pins: () => [{ app: 'nodegoat', commit: COMMIT, bundleSha256: 'd'.repeat(64) }],
  pinBundle: (i) =>
    Promise.resolve({ path: i.path, sha256: 'd'.repeat(64), allowedRoot: i.storeRoot }),
  ...over,
});

const noSecrets = (lines: readonly string[]) => {
  for (const l of lines) expect(l).not.toContain(SECRETISH);
};

describe('checkRealJudgePrerequisites', () => {
  it('passes on a prepared host and returns the verified bundle', async () => {
    const r = await checkRealJudgePrerequisites(config(), goodProbe());
    expect(r.problems).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.bundles).toEqual([
      {
        repo: 'repo-nodegoat',
        commit: COMMIT,
        ref: { path: BUNDLE, sha256: 'd'.repeat(64), allowedRoot: STORE },
      },
    ]);
  });

  it('lists every missing prerequisite at once, naming fields and never values', async () => {
    const r = await checkRealJudgePrerequisites(
      config(),
      goodProbe({
        platform: 'win32',
        isDirectory: () => Promise.resolve(false),
        isSocket: () => Promise.resolve(false),
        dockerRuntimes: () => Promise.resolve(['runc']),
        imagePresent: () => Promise.resolve(false),
        pins: () => [{ app: 'nodegoat', commit: COMMIT, bundleSha256: null }],
      }),
    );
    const text = r.problems.join('\n');
    for (const want of [
      /Linux sandbox host/,
      /no "runsc" runtime/,
      /no "runsc-affidavit" runtime/,
      /syscall trace directory/,
      /workRoot \(AFFIDAVIT_JUDGE_WORK_ROOT\) is not an existing directory/,
      /evidenceRoot \(AFFIDAVIT_EVIDENCE_DIR\) is not an existing directory/,
      /runnerImage \(AFFIDAVIT_WITNESS_RUNNER_IMAGE\) image is not present/,
      /applyImage \(AFFIDAVIT_PATCH_APPLY_IMAGE\) image is not present/,
      /signerSocket \(AFFIDAVIT_SIGNER_SOCKET\)/,
      /no bundleSha256 for nodegoat/,
    ]) {
      expect(text).toMatch(want);
    }
    expect(r.problems).toHaveLength(10);
    noSecrets(r.problems);
  });

  it('refuses an evidence store inside the work root, or rooted elsewhere', async () => {
    const r = await checkRealJudgePrerequisites(
      config({ evidenceRoot: `${WORK}/evidence`, evidence: store }),
      goodProbe(),
    );
    expect(r.problems.join('\n')).toMatch(/must not contain one another/);
    expect(r.problems.join('\n')).toMatch(/rooted somewhere other than evidenceRoot/);
    noSecrets(r.problems);
  });

  it('refuses relative paths and malformed image IDs', async () => {
    const r = await checkRealJudgePrerequisites(
      config({ workRoot: 'judge', runnerImage: 'affidavit/witness-runner:local' }),
      goodProbe(),
    );
    expect(r.problems.join('\n')).toMatch(
      /workRoot \(AFFIDAVIT_JUDGE_WORK_ROOT\) must be an absolute path/,
    );
    expect(r.problems.join('\n')).toMatch(/runnerImage .* must be a local image ID/);
  });

  it('reports a refused bundle with its paths scrubbed', async () => {
    const r = await checkRealJudgePrerequisites(
      config(),
      goodProbe({
        pinBundle: (i) =>
          Promise.reject(
            new Error(
              `dependency bundle sha256 x does not match the pinned y (${i.path}) in ${i.storeRoot}`,
            ),
          ),
      }),
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/does not match the pinned y \(<bundle>\) in <bundle store>/);
    noSecrets(r.problems);
  });

  it('notes, without blocking, a missing bundle and a missing re-scan', async () => {
    const { rescan: _r, ...noRescan } = config({ dependencyBundles: [] });
    void _r;
    const r = await checkRealJudgePrerequisites(noRescan, goodProbe());
    expect(r.problems).toEqual([]);
    expect(r.notes.join('\n')).toMatch(/no dependency bundle is configured/);
    expect(r.notes.join('\n')).toMatch(/verifyPatch fails closed/);
  });

  it('a daemon config that cannot be read is a problem, and everything else is still checked', async () => {
    let probed = 0;
    const r = await checkRealJudgePrerequisites(
      config(),
      goodProbe({
        dockerRuntimes: () => Promise.resolve(null),
        imagePresent: () => (probed++, Promise.resolve(false)),
        isSocket: () => Promise.resolve(false),
      }),
    );
    const text = r.problems.join('\n');
    expect(text).toMatch(/Docker daemon config cannot be read/);
    expect(text).toMatch(/runnerImage .* image is not present/);
    expect(text).toMatch(/applyImage .* image is not present/);
    expect(text).toMatch(/signerSocket/);
    expect(probed).toBe(2);
  });

  describe('isolation of the evidence store and the signer (review of #61)', () => {
    const link = (map: Record<string, string>) => (p: string) => Promise.resolve(map[p] ?? p);

    it('refuses a work root that is a symlink into the evidence store', async () => {
      const r = await checkRealJudgePrerequisites(
        config(),
        goodProbe({ realpath: link({ [WORK]: `${EVIDENCE}/judge` }) }),
      );
      expect(r.problems.join('\n')).toMatch(
        /workRoot and evidenceRoot must not contain one another/,
      );
      noSecrets(r.problems);
    });

    const rootedAt = (workRoot: string, evidenceRoot: string) => {
      const evidence: EvidenceStore & { root: string } = { ...store, root: evidenceRoot };
      return config({ workRoot, evidenceRoot, evidence });
    };

    it('a directory literally named `..evidence` under the work root is inside it', async () => {
      const r = await checkRealJudgePrerequisites(
        rootedAt('/data', '/data/..evidence'),
        goodProbe(),
      );
      expect(r.problems.join('\n')).toMatch(/must not contain one another/);
    });

    it('siblings and other drives are not contained', async () => {
      for (const [w, e] of [
        ['/data/work', '/data/work-evidence'],
        ['/data/..work', '/data/evidence'],
        ['C:/data', 'D:/data/evidence'],
      ] as const) {
        const r = await checkRealJudgePrerequisites(rootedAt(w, e), goodProbe());
        expect(r.problems.join('\n')).not.toMatch(/must not contain one another/);
      }
    });

    it('refuses an evidence store that resolves inside the work root, or to the same directory', async () => {
      for (const target of [`${WORK}/ev`, WORK]) {
        const r = await checkRealJudgePrerequisites(
          config(),
          goodProbe({ realpath: link({ [EVIDENCE]: target }) }),
        );
        expect(r.problems.join('\n')).toMatch(/must not contain one another/);
      }
    });

    it('compares case-insensitively where the filesystem is (Windows, macOS)', async () => {
      const r = await checkRealJudgePrerequisites(
        config(),
        goodProbe({
          platform: 'darwin',
          realpath: link({ [WORK]: `${EVIDENCE.toUpperCase()}/judge` }),
        }),
      );
      expect(r.problems.join('\n')).toMatch(/must not contain one another/);
    });

    it('refuses a signer socket under the work root, the bundle store or the evidence store', async () => {
      for (const sock of [`${WORK}/s.sock`, `${STORE}/s.sock`, `${EVIDENCE}/s.sock`]) {
        const r = await checkRealJudgePrerequisites(
          config(),
          goodProbe({ realpath: link({ [SOCKET]: sock }) }),
        );
        expect(r.problems.join('\n')).toMatch(/signerSocket .* must not be under/);
        noSecrets(r.problems);
      }
    });

    it('refuses an evidence store under the bundle store (mounted read only into builds)', async () => {
      const r = await checkRealJudgePrerequisites(
        config(),
        goodProbe({ realpath: link({ [EVIDENCE]: `${STORE}/ev` }) }),
      );
      expect(r.problems.join('\n')).toMatch(
        /evidenceRoot must not be under a dependency bundle store/,
      );
    });

    it('a path that cannot be resolved is a problem, not a pass', async () => {
      const r = await checkRealJudgePrerequisites(
        config(),
        goodProbe({ realpath: (p) => Promise.resolve(p === SOCKET ? null : p) }),
      );
      expect(r.problems.join('\n')).toMatch(/signerSocket .* cannot be resolved/);
    });
  });
});

describe('createRealJudge', () => {
  let listed = 0;
  const nothingStarts: TargetBootDeps = {
    buildTarget: () => Promise.reject(new Error('must not build')),
    createCaseNetwork: () => Promise.reject(new Error('must not start')),
    bootTarget: () => Promise.reject(new Error('must not start')),
    removeCaseNetwork: () => Promise.resolve(),
    fingerprintTree: (d) => Promise.resolve(d),
    listCaseRuns: () => {
      listed++;
      return Promise.resolve([]);
    },
  };
  /** An in-memory lease, so no test writes under the fake work root. */
  const memLease = () => {
    const l = {
      ownerId: 'test-owner',
      hostname: 'test-host',
      runs: [] as string[],
      closed: 0,
      addRun: (r: string) => {
        l.runs.push(r);
        return Promise.resolve();
      },
      removeRun: (r: string) => {
        l.runs = l.runs.filter((x) => x !== r);
        return Promise.resolve();
      },
      close: () => {
        l.closed++;
        return Promise.resolve();
      },
    };
    return l;
  };
  let leaseDir = '';
  beforeEach(() => {
    leaseDir = mkdtempSync(join(tmpdir(), 'affidavit-real-lease-'));
  });
  afterEach(() => {
    rmSync(leaseDir, { recursive: true, force: true });
  });

  it('throws a RealJudgePrerequisiteError before anything is built', async () => {
    const before = listed;
    const lease = memLease();
    const err = await createRealJudge(config({ sweepOrphans: true }), {
      probe: goodProbe({ isSocket: () => Promise.resolve(false) }),
      deps: nothingStarts,
      lease,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealJudgePrerequisiteError);
    expect((err as Error).message).toMatch(/signerSocket/);
    noSecrets([(err as Error).message]);
    expect(listed).toBe(before);
  });

  it('does not sweep by default, and closes its lease after the targets on close', async () => {
    const before = listed;
    const lease = memLease();
    const real = await createRealJudge(config(), {
      probe: goodProbe(),
      deps: nothingStarts,
      lease,
    });
    expect(listed).toBe(before);
    expect(lease.closed).toBe(0);
    await real.close();
    expect(lease.closed).toBe(1);
  });

  it('with sweepOrphans, sweeps only runs a dead lease on this host proves orphaned', async () => {
    const live = 'a'.repeat(16);
    const dead = 'b'.repeat(16);
    const stray = 'c'.repeat(16);
    const mk = (pid: number, runIds: string[]) =>
      JSON.stringify({
        schema: LEASE_SCHEMA,
        ownerId: `o${pid}`,
        hostname: 'test-host',
        pid,
        startedAt: 0,
        heartbeatAt: Date.now(),
        runIds,
      });
    writeFileSync(join(leaseDir, 'live.json'), mk(process.pid, [live]));
    // A pid far above any default pid_max is never a live process.
    writeFileSync(join(leaseDir, 'dead.json'), mk(2 ** 30, [dead]));
    const removed: string[] = [];
    const deps: TargetBootDeps = {
      ...nothingStarts,
      listCaseRuns: () => Promise.resolve([live, dead, stray]),
      removeCaseNetwork: (net) => {
        removed.push(net.runId);
        return Promise.resolve();
      },
    };
    const real = await createRealJudge(config({ sweepOrphans: true, leaseDir }), {
      probe: goodProbe(),
      deps,
      lease: memLease(),
    });
    expect(removed).toEqual([dead]);
    await real.close();
  });

  it('acquires a lease file in leaseDir and deletes it on close', async () => {
    const real = await createRealJudge(config({ leaseDir }), {
      probe: goodProbe(),
      deps: nothingStarts,
    });
    expect(readdirSync(leaseDir)).toHaveLength(1);
    await real.close();
    expect(readdirSync(leaseDir)).toEqual([]);
  });

  it('assembles the Judge on the case targets and hands the case bundle to the builds', async () => {
    const bundles: unknown[] = [];
    const deps: TargetBootDeps = {
      ...nothingStarts,
      buildTarget: (_d, _h, o) => {
        bundles.push(o.dependencyBundle);
        return Promise.resolve({
          ok: false,
          unsupported: true,
          step: 'recipe',
          reason: 'stop here',
        });
      },
    };
    const real = await createRealJudge(config(), { probe: goodProbe(), deps, lease: memLease() });
    expect(real.evidence).toBe(store);
    expect(real.signer).toBe(signer);
    const cf = gateCaseFile();
    // The fixture's commit is not the pinned one, so no bundle is chosen for it.
    await expect(real.judge.runWitness(cf, gateWitness(), ['vulnerable'])).rejects.toThrow(
      /unsupported at build: recipe: stop here/,
    );
    // Same case id with another commit is refused outright (another case file); a new case is not.
    const moved = { ...cf, target: { ...cf.target, commit: COMMIT } };
    await expect(real.judge.runWitness(moved, gateWitness(), ['vulnerable'])).rejects.toThrow(
      /booted from another case file/,
    );
    const pinned = { ...moved, id: 'case-nodegoat-pinned-001' as typeof cf.id };
    await expect(real.judge.runWitness(pinned, gateWitness(), ['vulnerable'])).rejects.toThrow(
      /stop here/,
    );
    expect(bundles).toEqual([
      undefined,
      { path: BUNDLE, sha256: 'd'.repeat(64), allowedRoot: STORE },
    ]);
    await real.close();
  });

  it('without a RescanPort, verifyPatch fails closed', async () => {
    const { rescan: _r, ...noRescan } = config();
    void _r;
    const deps: TargetBootDeps = {
      buildTarget: (d) =>
        Promise.resolve({
          ok: true,
          imageId: `sha256:${(d.endsWith('safe') ? 'b' : 'a').repeat(64)}`,
          baseImage: 'node',
          recipe: {
            base: 'node',
            workdir: '/app',
            command: ['node'],
            env: {},
            port: 4000,
            healthRoute: '/',
            healthTimeoutMs: 1000,
            sidecars: [],
            stubs: [],
            buildScript: false,
          },
          stage: {} as never,
        }),
      createCaseNetwork: () =>
        Promise.resolve({ name: 'affidavit-net-0000000000000001', runId: '1', subnet: '' }),
      bootTarget: () =>
        Promise.resolve({
          status: 'healthy',
          url: 'http://target:4000',
          hosts: { target: '1' },
          services: [],
          sidecarImages: {},
        }),
      removeCaseNetwork: () => Promise.resolve(),
      fingerprintTree: (d) => Promise.resolve(d),
      listCaseRuns: () => Promise.resolve([]),
    };
    const real = await createRealJudge(noRescan, {
      probe: goodProbe(),
      deps,
      lease: memLease(),
    });
    expect(real.notes.join('\n')).toMatch(/RescanPort/);
    const cf = gateCaseFile();
    await expect(
      real.judge.verifyPatch(cf, patchExhibit(GATE_PATCH_DIFF), gateWitness(), []),
    ).rejects.toThrow(/needs a PatchWorkbench and a RescanPort/);
    await real.close();
  });
});
