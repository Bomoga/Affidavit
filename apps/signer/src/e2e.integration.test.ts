import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaseFile,
  Verdict,
  Witness,
  type BootHints,
  type ParamSpace,
  type PatchExhibit,
} from '@affidavit/contracts';
import {
  caseUsage,
  FsEvidenceStore,
  loadBundle,
  parseKeysFile,
  publicKeyId,
  readTar,
  replay,
  sealingCaseStore,
  verifyBundleFiles,
  verifyPublic,
  VERIFY_EXIT,
  writeTar,
  VerdictSealer,
  type ExhibitRecord,
  type SealedVerdict,
} from '@affidavit/evidence';
import {
  buildPatchApplyImage,
  buildRunnerImage,
  createRealJudge,
  directorySources,
  parseUnifiedDiff,
  sha256Hex,
  type ExhibitRunLog,
  type RealJudge,
} from '@affidavit/judge';
import { RUN_LABEL, readDependencyBundlePins } from '@affidavit/sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignerClient } from './client.js';
import { CosignSigner } from './cosign.js';
import { e2ePrerequisites } from './e2e-prerequisites.js';
import { startSignerServer, type RunningSigner } from './server.js';

// Lane 2 end to end on one real NodeGoat case, with nothing faked inside Lane 2: the real Judge
// boots both variants in gVisor and judges the gate witness and the corpus safe patch, the run
// logs (egress, per-run usage) go into the exhibit records, the bundle is built and stored in the
// filesystem evidence store, the signer service signs its manifest over its unix socket with a
// cosign key, and the public verifier (L2-12) checks the stored bytes from files alone. Replay
// reruns every exhibit through the real Judge and must reach the same outcomes. Only the trial
// (Lane 3) is absent: the verdict is written here from the Judge's results, not by a jury.
// Needs the same host setup as real.integration.test.ts in packages/judge, plus cosign.
// It lives in apps/signer, not packages/evidence: evidence already has judge and sandbox as dev
// dependencies, but it would also need this package, which depends on evidence (a cycle).
// Off a sandbox host it is skipped; with AFFIDAVIT_SANDBOX_HOST=1 a missing prerequisite fails
// the file with its name (e2e-prerequisites.ts), so `test:e2e` can never pass with nothing run.
const hasCosign = (() => {
  try {
    execFileSync('cosign', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const prerequisites = e2ePrerequisites(process.env, hasCosign);
const SKIP_REASON = prerequisites.run ? null : prerequisites.skipReason;

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
const PARAMS: ParamSpace = [
  {
    name: 'payload',
    values: [
      "1'; return 1 == '1",
      "0'; return true; var x = '",
      "99'; return this.userId != 2; var y = '",
    ],
  },
];
const ROOT = join(import.meta.dirname, '..', '..', '..');

const leftovers = (kind: 'ps' | 'network') =>
  execFileSync(
    'docker',
    kind === 'ps'
      ? ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`]
      : ['network', 'ls', '--quiet', '--filter', `label=${RUN_LABEL}`],
    { encoding: 'utf8' },
  ).trim();

describe.skipIf(SKIP_REASON !== null)(
  `Lane 2 end to end on NodeGoat${SKIP_REASON === null ? '' : ` (skipped: ${SKIP_REASON})`}`,
  { timeout: 3_600_000 },
  () => {
    let root = '';
    let real: RealJudge | undefined;
    let signer: RunningSigner | undefined;
    let publicKeyPem = '';
    let cf: CaseFile;
    let witness: Witness;
    const logs = new Map<string, ExhibitRunLog>();
    const records: ExhibitRecord[] = [];
    let stored: { sha256: string; bytes: Uint8Array } | undefined;
    let attestationJson = '';

    beforeAll(async () => {
      if (!prerequisites.run) throw new Error('unreachable: the suite is skipped');
      const { vulnerableDir, safeDir, bundlePath, bundleStore } = prerequisites.setup;
      root = mkdtempSync(join(tmpdir(), 'affidavit-e2e-'));
      const keys = join(root, 'keys');
      mkdirSync(keys, { mode: 0o700 });
      const password = 'e2e-only';
      execFileSync('cosign', ['generate-key-pair'], {
        cwd: keys,
        env: { PATH: process.env.PATH ?? '', HOME: keys, COSIGN_PASSWORD: password },
        stdio: 'ignore',
      });
      publicKeyPem = readFileSync(join(keys, 'cosign.pub'), 'utf8');
      const socketPath = join(root, 'signer.sock');
      signer = await startSignerServer({
        socketPath,
        signer: new CosignSigner({ keyRef: join(keys, 'cosign.key'), publicKeyPem, password }),
      });

      const pin = readDependencyBundlePins().find((p) => p.app === 'nodegoat');
      if (pin === undefined) throw new Error('pins.json has no nodegoat entry');
      const base = CaseFile.parse(
        JSON.parse(
          readFileSync(join(ROOT, 'fixtures', 'casefiles', 'nodegoat-sqli-001.json'), 'utf8'),
        ),
      );
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
        params: PARAMS,
        author: 'defense',
        sha256: '0'.repeat(64),
      });
      const evidenceRoot = join(root, 'evidence');
      const workRoot = join(root, 'work');
      mkdirSync(evidenceRoot);
      mkdirSync(workRoot);
      real = await createRealJudge({
        workRoot,
        runnerImage: await buildRunnerImage(),
        applyImage: await buildPatchApplyImage(),
        evidenceRoot,
        evidence: new FsEvidenceStore(evidenceRoot),
        signerSocket: socketPath,
        signer: new SignerClient(socketPath),
        sources: directorySources([
          { repo: cf.target.repo, commit: pin.commit, variant: 'vulnerable', dir: vulnerableDir },
          { repo: cf.target.repo, commit: pin.commit, variant: 'safe', dir: safeDir },
        ]),
        dependencyBundles: [
          { app: 'nodegoat', repo: cf.target.repo, path: bundlePath, storeRoot: bundleStore },
        ],
        rescan: { rescan: () => Promise.resolve({ clean: true, candidates: [] }) },
        runLogRecorder: { record: (id, log) => logs.set(id, log) },
      });
    }, 1_800_000);

    afterAll(async () => {
      try {
        await real?.close();
        await signer?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      expect(leftovers('ps')).toBe('');
      expect(leftovers('network')).toBe('');
    }, 300_000);

    it('judges the gate witness and the safe patch, with a run log for each', async () => {
      const w = await real!.judge.runWitness(cf, witness, ['vulnerable']);
      expect(w).toMatchObject({ admissible: true, vulnPass: true, safeVariantFail: true });
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
      const parsed = parseUnifiedDiff(diff);
      if (!parsed.ok) throw new Error('the corpus safe patch does not parse');
      const patch: PatchExhibit = {
        schemaVersion: 1,
        id: 'exhibit-patch-e2e' as PatchExhibit['id'],
        caseId: cf.id,
        author: 'remedy',
        kind: 'patch',
        code: diff,
        sha256: sha256Hex(diff),
        diff,
        filesTouched: parsed.diff.files.map((f) => f.path),
        linesChanged: parsed.diff.linesChanged,
      };
      const { result: p } = await real!.judge.verifyPatchReport(cf, patch, witness, []);
      expect(p.rejectedBy).toBeUndefined();

      const wLog = logs.get(w.exhibitId)!;
      const pLog = logs.get(p.patchExhibitId)!;
      expect(wLog.egress).toEqual([]);
      expect(wLog.runs).toHaveLength(6);
      expect(wLog.runs.every((r) => r.memoryPeakBytes !== null && r.cpuMs !== null)).toBe(true);
      // The empty egress log means nothing tried to leave only because every run was observed.
      expect(wLog.runs.every((r) => r.egressObserved)).toBe(true);
      expect(pLog.runs.every((r) => r.egressObserved)).toBe(true);
      expect(pLog.runs.length).toBeGreaterThanOrEqual(6);

      records.push(
        {
          schemaVersion: 1,
          kind: 'witness',
          witness,
          result: w,
          egress: wLog.egress,
          usage: wLog.runs,
        },
        {
          schemaVersion: 1,
          kind: 'patch',
          witnessExhibitId: w.exhibitId,
          counterexampleExhibitIds: [],
          patch,
          result: p,
          egress: pLog.egress,
          usage: pLog.runs,
        },
      );
    });

    it('builds and stores the bundle, and the signer service signs its manifest', async () => {
      const exhibitIds = records.map((r) =>
        r.kind === 'patch' ? r.result.patchExhibitId : r.result.exhibitId,
      );
      // Written from the Judge's results; no trial ran, so no ballots, cost or model ids.
      const verdict = Verdict.parse({
        schemaVersion: 1,
        caseId: cf.id,
        outcome: 'proven-fixed',
        severity: 'high',
        exhibits: exhibitIds,
        ballots: [],
        summary: 'Lane 2 end to end check: witness admitted, safe patch verified. No trial ran.',
        promptVersions: {},
        modelIds: {},
        cost: [],
      });
      // Sealed the way the worker will: the pinned case file from the Judge's targets, the
      // records from the case, and the attestation read back from the store by its digest.
      let sealed: SealedVerdict | undefined;
      const sealer = new VerdictSealer({
        evidence: real!.evidence,
        signer: real!.signer,
        source: {
          pinnedCaseFile: () => real!.targets.bind(cf),
          records: () => Promise.resolve(records),
        },
        toolVersions: { judge: 'e2e' },
        onSealed: (s) => {
          sealed = s;
        },
      });
      const appended: Verdict[] = [];
      const sealing = sealingCaseStore(
        { appendVerdict: (v: Verdict) => Promise.resolve(void appended.push(v)) } as never,
        sealer,
      );
      await sealing.appendVerdict(verdict);
      expect(appended).toHaveLength(1);
      const sha256 = appended[0]!.bundleSha256!;
      expect(sha256).toBe(sealed!.bundleSha256);
      const loaded = await loadBundle(real!.evidence, sha256);
      expect(loaded?.sha256).toBe(sha256);
      expect(Object.keys(loaded?.manifest.targetDigests ?? {}).sort()).toEqual([
        'safe',
        'vulnerable',
      ]);
      stored = { sha256, bytes: (await real!.evidence.get(sha256))! };
      const attBytes = await real!.evidence.get(sealed!.attestationSha256);
      attestationJson = Buffer.from(attBytes!).toString('utf8');
      expect(JSON.parse(attestationJson)).toEqual(sealed!.attestation);
      expect(caseUsage(records)).toMatchObject({
        unmeasuredRuns: 0,
        egressAttempts: 0,
        recordsWithoutUsage: 0,
        egressUnobservedRuns: 0,
      });
    });

    it('verifies from files alone, and refuses one changed byte or a revoked key', async () => {
      // The published keys file (docs/keys/README.md) with the signer's key, as verify requires.
      const keysJson = (status: 'active' | 'revoked') =>
        JSON.stringify({
          schemaVersion: 1,
          keys: [
            {
              keyId: publicKeyId(publicKeyPem),
              publicKey: publicKeyPem,
              status,
              ...(status === 'revoked' ? { revokedAt: new Date().toISOString() } : {}),
            },
          ],
        });
      const files = join(root, 'verify');
      mkdirSync(files);
      const bundleFile = join(files, 'bundle.tar');
      const attestationFile = join(files, 'attestation.json');
      writeFileSync(bundleFile, stored!.bytes);
      writeFileSync(attestationFile, attestationJson);
      writeFileSync(join(files, 'keys.json'), keysJson('active'));
      writeFileSync(join(files, 'revoked.keys.json'), keysJson('revoked'));
      const verify = async (keysFile: string) => {
        const lines: string[] = [];
        const code = await verifyBundleFiles({
          bundlePath: bundleFile,
          attestationPath: attestationFile,
          keysPath: join(files, keysFile),
          expectedSha256: stored!.sha256,
          out: (l) => lines.push(l),
        });
        return { code, lines };
      };
      const ok = await verify('keys.json');
      expect(ok.code).toBe(VERIFY_EXIT.VERIFIED);
      expect(ok.lines).toContain(`case ${cf.id}`);
      expect(ok.lines.at(-1)).toBe('VERIFIED');
      const revoked = await verify('revoked.keys.json');
      expect(revoked.code).toBe(VERIFY_EXIT.FAILED);
      expect(revoked.lines.at(-1)).toMatch(/which is revoked$/);

      const parsed = parseKeysFile(keysJson('active'));
      if (!parsed.ok) throw new Error(`keys file: ${parsed.reason}`);
      const direct = await verifyPublic(stored!.bytes, attestationJson, parsed.keys, {
        expectedSha256: stored!.sha256,
      });
      expect(direct).toMatchObject({ ok: true, caseId: cf.id, outcome: 'proven-fixed' });

      const entries = await readTar(stored!.bytes);
      const name = [...entries.keys()].find((n) => n.startsWith('exhibits/exhibit-witness'))!;
      const changed = new Uint8Array(entries.get(name)!);
      changed[10] = (changed[10] ?? 0) ^ 1;
      entries.set(name, changed);
      const tampered = await writeTar([...entries].map(([n, b]) => ({ name: n, bytes: b })));
      const bad = await verifyPublic(tampered, attestationJson, parsed.keys);
      expect(bad.ok).toBe(false);
      const witnessId = name.slice('exhibits/'.length, -'.json'.length);
      expect(!bad.ok && bad.reason).toBe(
        `bundle integrity (${witnessId}): bytes do not match the manifest digest`,
      );
    });

    it('replays every exhibit through the real Judge to the same outcomes', async () => {
      const report = await replay(stored!.bytes, {
        judge: real!.judge,
        expectedSha256: stored!.sha256,
      });
      expect(report.ok).toBe(true);
    });
  },
);
