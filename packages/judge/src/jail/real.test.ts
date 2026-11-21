import type { EvidenceStore, SignerPort } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
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
  sources: () => Promise.resolve({ ok: true, dir: '/src' }),
  dependencyBundles: [{ app: 'nodegoat', repo: 'repo-nodegoat', path: BUNDLE, storeRoot: STORE }],
  rescan: { rescan: () => Promise.resolve({ clean: true, candidates: [] }) },
  ...over,
});

const goodProbe = (over: Partial<RealJudgeHostProbe> = {}): RealJudgeHostProbe => ({
  platform: 'linux',
  isDirectory: () => Promise.resolve(true),
  isSocket: () => Promise.resolve(true),
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

  it('a daemon config that cannot be read is a problem, and images are not probed then', async () => {
    let probed = 0;
    const r = await checkRealJudgePrerequisites(
      config(),
      goodProbe({
        dockerRuntimes: () => Promise.resolve(null),
        imagePresent: () => (probed++, Promise.resolve(true)),
      }),
    );
    expect(r.problems.join('\n')).toMatch(/Docker daemon config cannot be read/);
    expect(probed).toBe(0);
  });
});

describe('createRealJudge', () => {
  const nothingStarts: TargetBootDeps = {
    buildTarget: () => Promise.reject(new Error('must not build')),
    createCaseNetwork: () => Promise.reject(new Error('must not start')),
    bootTarget: () => Promise.reject(new Error('must not start')),
    removeCaseNetwork: () => Promise.resolve(),
  };

  it('throws a RealJudgePrerequisiteError before anything is built', async () => {
    const err = await createRealJudge(config(), {
      probe: goodProbe({ isSocket: () => Promise.resolve(false) }),
      deps: nothingStarts,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealJudgePrerequisiteError);
    expect((err as Error).message).toMatch(/signerSocket/);
    noSecrets([(err as Error).message]);
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
    const real = await createRealJudge(config(), { probe: goodProbe(), deps });
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
      buildTarget: () =>
        Promise.resolve({
          ok: true,
          imageId: `sha256:${'a'.repeat(64)}`,
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
    };
    const real = await createRealJudge(noRescan, { probe: goodProbe(), deps });
    expect(real.notes.join('\n')).toMatch(/RescanPort/);
    const cf = gateCaseFile();
    await expect(
      real.judge.verifyPatch(cf, patchExhibit(GATE_PATCH_DIFF), gateWitness(), []),
    ).rejects.toThrow(/needs a PatchWorkbench and a RescanPort/);
    await real.close();
  });
});
