import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseFile, Witness, type BootHints, type ParamSpace } from '@affidavit/contracts';
import {
  RUN_LABEL,
  pinnedDependencyBundle,
  readDependencyBundlePins,
  removeCaseNetwork,
  type DependencyBundleRef,
} from '@affidavit/sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Judge } from '../judge.js';
import { DEFAULT_POLICY } from '../rules.js';
import { gateCaseFile, patchExhibit } from '../test-helpers.js';
import { BootedTargets, bootVariant, type BootedTarget } from './booted.js';
import { JailExecutor } from './executor.js';
import { buildRunnerImage } from './harness.js';
import { JailedPatchWorkbench, buildPatchApplyImage } from './workbench.js';

// The hand-written Phase 1 witnesses against real NodeGoat, booted with the L2-04 recipes. Needs a
// sandbox host and AFFIDAVIT_NODEGOAT_DIR (the L1-08 corpus checkout:
// `node packages/corpus/scripts/fetch-pinned.mjs nodegoat`). Run with
// `pnpm --filter @affidavit/judge test:sandbox-host`; skipped in plain `pnpm test`.
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';
const nodegoat = process.env.AFFIDAVIT_NODEGOAT_DIR;
/**
 * Since the lead decision on PR #18 (2026-11-20, deny-all egress with no exception for a
 * build-time fetch), NodeGoat builds only with a reviewed offline dependency bundle
 * (`lane2/L2-04c-dependency-bundle`), named by AFFIDAVIT_NODEGOAT_BUNDLE. Without it every test
 * here would fail in beforeAll with TargetBootError (build unsupported, dependency fetch), so the
 * suite is skipped, and the reason is in its title in the test output. With it set, beforeAll
 * checks the file against pins.json (`pinnedDependencyBundle`) and fails closed on a null pin or
 * a mismatch: a human builds the bundle, reviews the manifest and sets the pin.
 */
const bundle = process.env.AFFIDAVIT_NODEGOAT_BUNDLE;
const SKIP_REASON = !onSandboxHost
  ? 'not a sandbox host'
  : nodegoat === undefined
    ? 'AFFIDAVIT_NODEGOAT_DIR is not set'
    : bundle === undefined
      ? 'no NodeGoat dependency bundle (AFFIDAVIT_NODEGOAT_BUNDLE); deny-all egress, PR #18 decision'
      : null;

const WITNESSES = join(import.meta.dirname, '..', '..', 'witnesses');
const witnessSource = (name: string) => readFileSync(join(WITNESSES, name), 'utf8');

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

/** NodeGoat's own documented fix for the IDOR: the user id comes from the session. */
const IDOR_VULNERABLE = `        /*
        // Fix for A4 Insecure DOR -  take user id from session instead of from URL param
        const { userId } = req.session;
        */
        const {
            userId
        } = req.params;`;
const IDOR_SAFE = `        const { userId } = req.session;`;

/** NodeGoat's own documented fix for the `$where` injection (same as the L2-04 boot tests). */
const NOSQLI_VULNERABLE = `return {
                    $where: \`this.userId == \${parsedUserId} && this.stocks > '\${threshold}'\`
                };`;
const NOSQLI_SAFE = `const parsedThreshold = parseInt(threshold, 10);
                if (parsedThreshold >= 0 && parsedThreshold <= 99) {
                    return {$where: \`this.userId == \${parsedUserId} && this.stocks > \${parsedThreshold}\`};
                }
                throw \`The user supplied threshold: \${parsedThreshold} was not valid.\`;`;

const ACCOUNTS = {
  admin: { userId: 1, userName: 'admin', password: 'Admin_123', name: 'Node Goat Admin' },
  user1: { userId: 2, userName: 'user1', password: 'User1_123', name: 'John Doe' },
  user2: { userId: 3, userName: 'user2', password: 'User2_123', name: 'Will Smith' },
};
const pair = (a: keyof typeof ACCOUNTS, v: keyof typeof ACCOUNTS) => ({
  attacker: {
    userName: ACCOUNTS[a].userName,
    password: ACCOUNTS[a].password,
    name: ACCOUNTS[a].name,
  },
  victim: { userId: ACCOUNTS[v].userId, name: ACCOUNTS[v].name },
});

const IDOR_PARAMS: ParamSpace = [
  {
    name: 'pair',
    values: [pair('user1', 'user2'), pair('user2', 'user1'), pair('user1', 'admin')],
  },
];
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

/** A weak IDOR witness: it only checks that the page loads, which the safe variant also does. */
const WEAK_IDOR = `import { expect } from 'vitest';
import { witness } from '@affidavit/witness';
witness<{ pair: { attacker: { userName: string; password: string }; victim: { userId: number } } }>(
  async ({ pair: { attacker, victim } }, { target }) => {
    const login = await fetch(\`\${target!.url}/login\`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userName: attacker.userName, password: attacker.password }).toString(),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const res = await fetch(\`\${target!.url}/allocations/\${victim.userId}\`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(200);
  },
);
`;

/**
 * Positive control for the `$where` safe variant: the same login and the same allocations request
 * as the injection witness, with a threshold the safe code accepts. It must pass on both variants:
 * user1 logs in (302) and sees their own allocations page, so the seed and session work.
 * NodeGoat seeds each user's `stocks` at random from 1 to 40 (`artifacts/db-reset.js`), so only a
 * threshold below 1 shows the allocation on every boot, and the safe fix accepts 0 to 99 only: the
 * one threshold both variants always accept is 0, written three ways that parseInt reads as 0.
 * The earlier values 50 and 99 failed on both variants on the sandbox host (2026-11-21), because
 * no allocation was above them.
 */
const BENIGN_WHERE = `import { expect } from 'vitest';
import { witness } from '@affidavit/witness';
witness<{ threshold: string }>(async ({ threshold }, { target }) => {
  const base = target!.url;
  const login = await fetch(\`\${base}/login\`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ userName: 'user1', password: 'User1_123' }).toString(),
  });
  expect(login.status).toBe(302);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(\`\${base}/allocations/2?threshold=\${encodeURIComponent(threshold)}\`, {
    headers: { cookie }, redirect: 'manual',
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Asset Allocations for John Doe');
});
`;
const BENIGN_PARAMS: ParamSpace = [{ name: 'threshold', values: ['0', '00', '0.5'] }];

/** A real `git diff` of one file changed from `from` to `to`, made with the host's git. */
function realDiff(
  file: string,
  from: string,
  to: string,
  added: Readonly<Record<string, string>> = {},
): string {
  const repo = mkdtempSync(join(tmpdir(), 'affidavit-diff-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
    git('init', '-q');
    const original = readFileSync(join(nodegoat as string, file), 'utf8');
    expect(original).toContain(from);
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), original);
    git('add', '.');
    git('commit', '-q', '-m', 'v');
    writeFileSync(join(repo, file), original.replace(from, to));
    for (const [path, text] of Object.entries(added)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git('add', '-N', '.');
    return git('diff');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const RESCAN_CLEAN = { rescan: () => Promise.resolve({ clean: true, candidates: [] }) };

const POLICY = { ...DEFAULT_POLICY, hardTimeoutMs: 30_000, timeBudgetMs: 20_000 };

const leftovers = (kind: 'ps' | 'network') =>
  execFileSync(
    'docker',
    kind === 'ps'
      ? ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`]
      : ['network', 'ls', '--quiet', '--filter', `label=${RUN_LABEL}`],
    { encoding: 'utf8' },
  ).trim();

function caseFor(
  cls: 'injection' | 'idor',
  id: string,
  vulnerable: BootedTarget,
  safe: BootedTarget,
): CaseFile {
  const base = gateCaseFile();
  return CaseFile.parse({
    ...base,
    id,
    candidate: { ...base.candidate, cls },
    target: { ...base.target, imageDigest: vulnerable.imageId },
    safeVariant: { ...base.safeVariant, imageDigest: safe.imageId },
  });
}

const witnessFor = (
  caseId: string,
  cls: 'injection' | 'idor',
  template: string,
  params: ParamSpace,
) =>
  Witness.parse({
    schemaVersion: 1,
    id: `witness-${caseId}`,
    caseId,
    cls,
    template,
    params,
    author: 'defense',
    sha256: '0'.repeat(64),
  });

describe.skipIf(SKIP_REASON !== null)(
  `hand-written NodeGoat witnesses against booted targets${SKIP_REASON === null ? '' : ` (skipped: ${SKIP_REASON})`}`,
  { timeout: 600_000 },
  () => {
    let root = '';
    let runnerImage = '';
    const booted: Record<'vulnerable' | 'safeIdor' | 'safeNosqli', BootedTarget | undefined> = {
      vulnerable: undefined,
      safeIdor: undefined,
      safeNosqli: undefined,
    };

    /** A copy of the NodeGoat checkout with one documented fix applied. */
    function variantSource(name: string, file: string, from: string, to: string): string {
      const dir = join(root, name);
      cpSync(nodegoat as string, dir, { recursive: true });
      const path = join(dir, file);
      const code = readFileSync(path, 'utf8');
      expect(code).toContain(from);
      writeFileSync(path, code.replace(from, to));
      return dir;
    }

    let dependencyBundle: DependencyBundleRef | undefined;
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'affidavit-nodegoat-it-'));
      const workRoot = join(root, 'work');
      mkdirSync(workRoot);
      const pin = readDependencyBundlePins().find((p) => p.app === 'nodegoat');
      if (pin === undefined) throw new Error('pins.json has no nodegoat entry');
      // The configured bundle store (host setup); the bundle file must resolve inside it.
      const storeRoot = process.env.AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT;
      if (storeRoot === undefined) {
        throw new Error('set AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT to the dependency bundle store');
      }
      dependencyBundle = await pinnedDependencyBundle({
        app: 'nodegoat',
        commit: pin.commit,
        path: bundle as string,
        storeRoot,
      });
      runnerImage = await buildRunnerImage();
      booted.vulnerable = await bootVariant(nodegoat as string, HINTS, {
        workRoot,
        dependencyBundle,
      });
      booted.safeIdor = await bootVariant(
        variantSource('safe-idor', 'app/routes/allocations.js', IDOR_VULNERABLE, IDOR_SAFE),
        HINTS,
        { workRoot, dependencyBundle },
      );
      booted.safeNosqli = await bootVariant(
        variantSource('safe-nosqli', 'app/data/allocations-dao.js', NOSQLI_VULNERABLE, NOSQLI_SAFE),
        HINTS,
        { workRoot, dependencyBundle },
      );
    }, 1_800_000);

    afterAll(async () => {
      try {
        for (const t of Object.values(booted))
          if (t !== undefined) await removeCaseNetwork(t.endpoint.net);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      expect(leftovers('ps')).toBe('');
      expect(leftovers('network')).toBe('');
    }, 300_000);

    const judgeFor = (safe: BootedTarget) =>
      new Judge(
        new JailExecutor({
          workRoot: root,
          runnerImage,
          targets: new BootedTargets({ vulnerable: booted.vulnerable!, safe }),
        }),
        POLICY,
      );

    it('admits the IDOR family on the differential rule: every pair passes on vulnerable, fails on safe', async () => {
      const cf = caseFor('idor', 'case-nodegoat-idor-001', booted.vulnerable!, booted.safeIdor!);
      const w = witnessFor(
        cf.id,
        'idor',
        witnessSource('nodegoat-idor-allocations.witness.ts'),
        IDOR_PARAMS,
      );
      const r = await judgeFor(booted.safeIdor!).runWitness(cf, w, ['vulnerable', 'safe']);
      expect(r).toMatchObject({
        admissible: true,
        vulnPass: true,
        safeVariantFail: true,
        egressAttempts: 0,
      });
      expect(r.familyResults).toEqual(
        [0, 1, 2].map((paramIndex) => ({ paramIndex, passed: true })),
      );
      expect(r.runs.map((x) => [x.variant, x.passed])).toEqual([
        ['vulnerable', true],
        ['vulnerable', true],
        ['vulnerable', true],
        ['safe', false],
        ['safe', false],
        ['safe', false],
      ]);
    });

    it('rejects a weak IDOR witness that only checks the page loads (differential)', async () => {
      const cf = caseFor('idor', 'case-nodegoat-idor-001', booted.vulnerable!, booted.safeIdor!);
      const w = witnessFor(cf.id, 'idor', WEAK_IDOR, IDOR_PARAMS);
      const r = await judgeFor(booted.safeIdor!).runWitness(cf, w, ['vulnerable', 'safe']);
      expect(r).toMatchObject({ admissible: false, rejectedBy: 'differential', vulnPass: true });
    });

    it('admits the $where injection family (the gate case) on the differential rule', async () => {
      const cf = caseFor('injection', gateCaseFile().id, booted.vulnerable!, booted.safeNosqli!);
      const w = witnessFor(
        cf.id,
        'injection',
        witnessSource('nodegoat-nosqli-allocations-where.witness.ts'),
        NOSQLI_PARAMS,
      );
      const r = await judgeFor(booted.safeNosqli!).runWitness(cf, w, ['vulnerable', 'safe']);
      expect(r).toMatchObject({
        admissible: true,
        vulnPass: true,
        safeVariantFail: true,
        egressAttempts: 0,
      });
      expect(r.familyResults).toEqual(
        [0, 1, 2].map((paramIndex) => ({ paramIndex, passed: true })),
      );
    });

    it('positive control for the $where safe variant: login, seed and the benign query work', async () => {
      // Without this, a safe variant whose login, seed or allocations page were broken would also
      // make the injection witness fail there, and "fails on safe" would prove nothing.
      const cf = caseFor('injection', gateCaseFile().id, booted.vulnerable!, booted.safeNosqli!);
      const w = witnessFor(cf.id, 'injection', BENIGN_WHERE, BENIGN_PARAMS);
      const r = await judgeFor(booted.safeNosqli!).runWitness(cf, w, ['vulnerable', 'safe']);
      expect(r.runs.map((x) => [x.variant, x.passed])).toEqual([
        ['vulnerable', true],
        ['vulnerable', true],
        ['vulnerable', true],
        ['safe', true],
        ['safe', true],
        ['safe', true],
      ]);
      // It passes on both, so it is (correctly) not admissible evidence of anything.
      expect(r).toMatchObject({ admissible: false, rejectedBy: 'differential' });
    });

    describe('verifyPatch with the real workbench', () => {
      let applyImage = '';
      beforeAll(async () => {
        applyImage = await buildPatchApplyImage();
      }, 600_000);

      /**
       * With the pinned bundle (dev section ok after the reviewed exclusions; `prepare` in registry
       * tarballs is recorded, not run), NodeGoat's suite image builds offline. Its suite runs no
       * meaningful tests: `npm test` is `grunt test`, whose `mochaTest:unit` globs `test/unit/*.js`,
       * which the repository does not have, and the Gruntfile sets `force`. On the bundle host,
       * `grunt test` printed "No files to check...OK" and exited 0. So a passing suite here proves
       * only that the patched image builds; the patch evidence on NodeGoat is the family rerun and
       * the counterexamples.
       */
      const expectVacuousSuite = (suite: unknown) => {
        expect(suite).toEqual({ state: 'passed' });
      };

      const verifierFor = (safe: BootedTarget) => {
        const targets = new BootedTargets({ vulnerable: booted.vulnerable!, safe });
        const workbench = new JailedPatchWorkbench({
          workRoot: join(root, 'work'),
          applyImage,
          vulnerableSource: () => nodegoat as string,
          targets,
          ...(dependencyBundle === undefined ? {} : { dependencyBundle }),
        });
        return new Judge(new JailExecutor({ workRoot: root, runnerImage, targets }), POLICY, {
          workbench,
          rescan: RESCAN_CLEAN,
        });
      };

      it("accepts NodeGoat's own $where fix on the family rerun: the family flips; the suite builds and passes vacuously", async () => {
        const cf = caseFor('injection', gateCaseFile().id, booted.vulnerable!, booted.safeNosqli!);
        const w = witnessFor(
          cf.id,
          'injection',
          witnessSource('nodegoat-nosqli-allocations-where.witness.ts'),
          NOSQLI_PARAMS,
        );
        const diff = realDiff('app/data/allocations-dao.js', NOSQLI_VULNERABLE, NOSQLI_SAFE);
        const { result: r, suite } = await verifierFor(booted.safeNosqli!).verifyPatchReport(
          cf,
          patchExhibit(diff, {}, { raw: true }),
          w,
          [],
        );
        expectVacuousSuite(suite);
        expect(r).toMatchObject({
          familyFlipped: true,
          suitePassed: true,
          rescanClean: true,
          counterexamples: [],
        });
        expect(r.rejectedBy).toBeUndefined();
      });

      it("accepts NodeGoat's own IDOR fix on the family rerun: every pair flips; the suite passes vacuously", async () => {
        const cf = caseFor('idor', 'case-nodegoat-idor-001', booted.vulnerable!, booted.safeIdor!);
        const w = witnessFor(
          cf.id,
          'idor',
          witnessSource('nodegoat-idor-allocations.witness.ts'),
          IDOR_PARAMS,
        );
        const diff = realDiff('app/routes/allocations.js', IDOR_VULNERABLE, IDOR_SAFE);
        const patch = patchExhibit(diff, { caseId: cf.id }, { raw: true });
        const { result: r, suite } = await verifierFor(booted.safeIdor!).verifyPatchReport(
          cf,
          patch,
          w,
          [],
        );
        expectVacuousSuite(suite);
        expect(r).toMatchObject({ familyFlipped: true, suitePassed: true });
        expect(r.rejectedBy).toBeUndefined();
      });

      // runAddedTests: the patch's own test file runs with NodeGoat's mocha (2.5.3, from the dev
      // bundle) on the suite image, separately from `npm test`.
      const whereFixWithTest = (body: string) =>
        realDiff('app/data/allocations-dao.js', NOSQLI_VULNERABLE, NOSQLI_SAFE, {
          'test/unit/threshold.test.js': [
            "const assert = require('assert');",
            "describe('threshold parsing', function () {",
            "  it('reads the threshold as a base 10 integer', function () {",
            `    ${body}`,
            '  });',
            '});',
            '',
          ].join('\n'),
        });

      it('runs a test file the patch adds and accepts the fix when it passes', async () => {
        const cf = caseFor('injection', gateCaseFile().id, booted.vulnerable!, booted.safeNosqli!);
        const w = witnessFor(
          cf.id,
          'injection',
          witnessSource('nodegoat-nosqli-allocations-where.witness.ts'),
          NOSQLI_PARAMS,
        );
        const diff = whereFixWithTest("assert.strictEqual(parseInt('42', 10), 42);");
        const { result: r, suite } = await verifierFor(booted.safeNosqli!).verifyPatchReport(
          cf,
          patchExhibit(diff, {}, { raw: true }),
          w,
          [],
        );
        expectVacuousSuite(suite);
        expect(r).toMatchObject({ familyFlipped: true, suitePassed: true });
        expect(r.rejectedBy).toBeUndefined();
      });

      it('rejects the same fix when the test file it adds fails (suite-fails)', async () => {
        const cf = caseFor('injection', gateCaseFile().id, booted.vulnerable!, booted.safeNosqli!);
        const w = witnessFor(
          cf.id,
          'injection',
          witnessSource('nodegoat-nosqli-allocations-where.witness.ts'),
          NOSQLI_PARAMS,
        );
        const diff = whereFixWithTest("assert.strictEqual(parseInt('42', 10), 43);");
        const r = await verifierFor(booted.safeNosqli!).verifyPatch(
          cf,
          patchExhibit(diff, {}, { raw: true }),
          w,
          [],
        );
        // The family still flips; only the patch's own failing test rejects it.
        expect(r).toMatchObject({
          familyFlipped: true,
          suitePassed: false,
          rejectedBy: 'suite-fails',
        });
      });

      it('rejects a patch that changes the file but not the bug: the family does not flip', async () => {
        const cf = caseFor('injection', gateCaseFile().id, booted.vulnerable!, booted.safeNosqli!);
        const w = witnessFor(
          cf.id,
          'injection',
          witnessSource('nodegoat-nosqli-allocations-where.witness.ts'),
          NOSQLI_PARAMS,
        );
        const from = 'const parsedUserId = parseInt(userId);';
        const diff = realDiff(
          'app/data/allocations-dao.js',
          from,
          `${from}\n        const checkedAt = Date.now();`,
        );
        const r = await verifierFor(booted.safeNosqli!).verifyPatch(
          cf,
          patchExhibit(diff, {}, { raw: true }),
          w,
          [],
        );
        // It applied, built and booted; only the family stayed vulnerable. NodeGoat's suite builds
        // from the dev bundle and passes vacuously, so the rejection rests on the family alone.
        expect(r).toMatchObject({
          familyFlipped: false,
          suitePassed: true,
          rejectedBy: 'differential',
        });
      });

      it('rejects a patch that does not apply to the vulnerable commit as schema, before any build', async () => {
        const cf = caseFor('injection', gateCaseFile().id, booted.vulnerable!, booted.safeNosqli!);
        const w = witnessFor(
          cf.id,
          'injection',
          witnessSource('nodegoat-nosqli-allocations-where.witness.ts'),
          NOSQLI_PARAMS,
        );
        const lines = realDiff('app/data/allocations-dao.js', NOSQLI_VULNERABLE, NOSQLI_SAFE).split(
          '\n',
        );
        const ctx = lines.findIndex(
          (l, n) => n > lines.findIndex((h) => h.startsWith('@@')) && l.startsWith(' '),
        );
        // Same line counts, so the Judge and git --numstat agree; only the context is wrong.
        lines[ctx] = `${lines[ctx]} // context that is not in the file`;
        const diff = lines.join('\n');
        const r = await verifierFor(booted.safeNosqli!).verifyPatch(
          cf,
          patchExhibit(diff, {}, { raw: true }),
          w,
          [],
        );
        expect(r.rejectedBy).toBe('schema');
      });
    });
  },
);
