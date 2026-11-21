import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseFile, Witness, type BootHints, type ParamSpace } from '@affidavit/contracts';
import { RUN_LABEL, readDependencyBundlePins } from '@affidavit/sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateCaseFile, patchExhibit } from '../test-helpers.js';
import { buildRunnerImage } from './harness.js';
import { createRealJudge, type RealJudge } from './real.js';
import { directorySources } from './targets.js';
import { buildPatchApplyImage } from './workbench.js';

// One real NodeGoat case end to end through `createRealJudge` (CR-11): a discovery-style case file
// with no imageDigest, both variants booted by the provider, the gate witness judged on the
// differential rule, the corpus safe patch verified, and nothing left behind. Needs a sandbox
// host and the human-built dependency bundle; see docs/lanes/lane2/real-judge-host.md. Skipped in
// plain `pnpm test`, with the reason in the suite title.
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';
const vulnerableDir = process.env.AFFIDAVIT_NODEGOAT_DIR;
const safeDir = process.env.AFFIDAVIT_NODEGOAT_SAFE_DIR;
const bundle = process.env.AFFIDAVIT_NODEGOAT_BUNDLE;
const bundleStore = process.env.AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT;
const SKIP_REASON = !onSandboxHost
  ? 'not a sandbox host'
  : vulnerableDir === undefined || safeDir === undefined
    ? 'AFFIDAVIT_NODEGOAT_DIR and AFFIDAVIT_NODEGOAT_SAFE_DIR are not both set'
    : bundle === undefined || bundleStore === undefined
      ? 'no NodeGoat dependency bundle (AFFIDAVIT_NODEGOAT_BUNDLE, AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT); deny-all egress, PR #18 decision'
      : null;

const HINTS: BootHints = {
  kind: 'compose',
  path: 'docker-compose.yml',
  service: 'web',
  ports: [4000],
  healthRoute: '/login',
  healthTimeoutMs: 60_000,
  stubs: [],
  env: {},
};
const NOSQLI_PARAMS: ParamSpace = [
  {
    name: 'payload',
    values: [
      "1'; return 1 == '1",
      "0'; return true; var x = '",
      "99'; return this.userId != 2; var y = '",
    ],
  },
];
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const leftovers = (kind: 'ps' | 'network') =>
  execFileSync(
    'docker',
    kind === 'ps'
      ? ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`]
      : ['network', 'ls', '--quiet', '--filter', `label=${RUN_LABEL}`],
    { encoding: 'utf8' },
  ).trim();

describe.skipIf(SKIP_REASON !== null)(
  `createRealJudge on one real NodeGoat case${SKIP_REASON === null ? '' : ` (skipped: ${SKIP_REASON})`}`,
  { timeout: 1_800_000 },
  () => {
    let root = '';
    let real: RealJudge | undefined;
    let signerStandIn: Server | undefined;
    let cf: CaseFile;
    let witness: Witness;

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'affidavit-real-judge-'));
      const workRoot = join(root, 'work');
      const evidenceRoot = join(root, 'evidence');
      mkdirSync(workRoot);
      mkdirSync(evidenceRoot);
      // A listening unix socket stands in for apps/signer, so the startup check runs unmodified
      // (it resolves the socket path and checks where it lives). Nothing signs in this test.
      const signerSocket = join(root, 'signer.sock');
      const server = createServer((conn) => conn.destroy());
      signerStandIn = server;
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(signerSocket, () => done());
      });
      const pin = readDependencyBundlePins().find((p) => p.app === 'nodegoat');
      if (pin === undefined) throw new Error('pins.json has no nodegoat entry');
      const base = gateCaseFile();
      cf = CaseFile.parse({
        ...base,
        target: { repo: base.target.repo, commit: pin.commit, variant: 'vulnerable' },
        safeVariant: { repo: base.target.repo, commit: pin.commit, variant: 'safe' },
        bootHints: HINTS,
      });
      witness = Witness.parse({
        schemaVersion: 1,
        id: `witness-${cf.id}`,
        caseId: cf.id,
        cls: 'injection',
        template: readFileSync(
          join(
            ROOT,
            'packages',
            'judge',
            'witnesses',
            'nodegoat-nosqli-allocations-where.witness.ts',
          ),
          'utf8',
        ),
        params: NOSQLI_PARAMS,
        author: 'defense',
        sha256: '0'.repeat(64),
      });
      real = await createRealJudge({
        workRoot,
        runnerImage: await buildRunnerImage(),
        applyImage: await buildPatchApplyImage(),
        evidenceRoot,
        evidence: {
          put: () => Promise.reject(new Error('unused')),
          get: () => Promise.resolve(null),
        },
        signerSocket: join(root, 'signer.sock'),
        signer: { sign: () => Promise.reject(new Error('unused')) },
        sources: directorySources([
          {
            repo: cf.target.repo,
            commit: pin.commit,
            variant: 'vulnerable',
            dir: vulnerableDir as string,
          },
          { repo: cf.target.repo, commit: pin.commit, variant: 'safe', dir: safeDir as string },
        ]),
        dependencyBundles: [
          {
            app: 'nodegoat',
            repo: cf.target.repo,
            path: bundle as string,
            storeRoot: bundleStore as string,
          },
        ],
        rescan: { rescan: () => Promise.resolve({ clean: true, candidates: [] }) },
      });
    }, 1_800_000);

    afterAll(async () => {
      try {
        await real?.close();
      } finally {
        await new Promise<void>((done) =>
          signerStandIn ? signerStandIn.close(() => done()) : done(),
        );
        rmSync(root, { recursive: true, force: true });
      }
      expect(leftovers('ps')).toBe('');
      expect(leftovers('network')).toBe('');
    }, 300_000);

    it('boots both variants for a case file with no imageDigest and records both digests', async () => {
      const out = await real!.targets.boot(cf);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.digests.vulnerable).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(out.digests.safe).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(out.digests.safe).not.toBe(out.digests.vulnerable);
      const used = await real!.targets.dependencyBundles(cf);
      expect(used.vulnerable).toMatch(/^sha256:/);
      expect(used.safe).toBe(used.vulnerable);
    });

    it('admits the gate witness on the differential rule', async () => {
      const r = await real!.judge.runWitness(cf, witness, ['vulnerable']);
      expect(r).toMatchObject({
        admissible: true,
        vulnPass: true,
        safeVariantFail: true,
        egressAttempts: 0,
      });
    });

    it('verifies the corpus safe patch: the family flips, the suite builds and passes vacuously', async () => {
      const diff = readFileSync(
        join(
          ROOT,
          'packages',
          'corpus',
          'data',
          'nodegoat',
          'patches',
          'safe-allocations-where-int.patch',
        ),
        'utf8',
      );
      const { result, suite } = await real!.judge.verifyPatchReport(
        cf,
        patchExhibit(diff, {}, { raw: true }),
        witness,
        [],
      );
      expect(suite).toEqual({ state: 'passed' });
      expect(result).toMatchObject({ familyFlipped: true, suitePassed: true, rescanClean: true });
      expect(result.rejectedBy).toBeUndefined();
    });

    it('release tears down both targets', async () => {
      await real!.release(cf.id);
      expect(leftovers('ps')).toBe('');
      expect(leftovers('network')).toBe('');
    });
  },
);
