import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseFile, Witness, type BootHints, type ParamSpace } from '@affidavit/contracts';
import { RUN_LABEL, removeCaseNetwork } from '@affidavit/sandbox';
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

/** A real `git diff` of one file changed from `from` to `to`, made with the host's git. */
function realDiff(file: string, from: string, to: string): string {
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

describe.runIf(onSandboxHost && nodegoat !== undefined)(
  'hand-written NodeGoat witnesses against booted targets',
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

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'affidavit-nodegoat-it-'));
      const workRoot = join(root, 'work');
      mkdirSync(workRoot);
      runnerImage = await buildRunnerImage();
      booted.vulnerable = await bootVariant(nodegoat as string, HINTS, { workRoot });
      booted.safeIdor = await bootVariant(
        variantSource('safe-idor', 'app/routes/allocations.js', IDOR_VULNERABLE, IDOR_SAFE),
        HINTS,
        { workRoot },
      );
      booted.safeNosqli = await bootVariant(
        variantSource('safe-nosqli', 'app/data/allocations-dao.js', NOSQLI_VULNERABLE, NOSQLI_SAFE),
        HINTS,
        { workRoot },
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

    describe('verifyPatch with the real workbench', () => {
      let applyImage = '';
      beforeAll(async () => {
        applyImage = await buildPatchApplyImage();
      }, 600_000);

      /**
       * NodeGoat's suite cannot be built in the sandbox: its devDependencies take `grunt-if` from
       * a GitHub tarball (unpinned master), and the fetch only reaches the npm registry. (Its
       * `npm test` also points at `test/unit/*.js`, which the repository does not have.)
       */
      const NO_SUITE = {
        state: 'unavailable',
        reason:
          'the suite cannot be built: node_modules/grunt-if resolves outside the npm registry',
      };

      const verifierFor = (safe: BootedTarget) => {
        const targets = new BootedTargets({ vulnerable: booted.vulnerable!, safe });
        const workbench = new JailedPatchWorkbench({
          workRoot: join(root, 'work'),
          applyImage,
          vulnerableSource: () => nodegoat as string,
          targets,
        });
        return new Judge(new JailExecutor({ workRoot: root, runnerImage, targets }), POLICY, {
          workbench,
          rescan: RESCAN_CLEAN,
        });
      };

      it("verifies NodeGoat's own $where fix: the whole family flips; the suite is unavailable", async () => {
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
        expect(suite).toEqual(NO_SUITE);
        expect(r).toMatchObject({
          familyFlipped: true,
          suitePassed: false,
          rescanClean: true,
          counterexamples: [],
        });
        expect(r.rejectedBy).toBeUndefined();
      });

      it("verifies NodeGoat's own IDOR fix: every (attacker, victim) pair flips", async () => {
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
        expect(suite).toEqual(NO_SUITE);
        expect(r).toMatchObject({ familyFlipped: true, suitePassed: false });
        expect(r.rejectedBy).toBeUndefined();
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
        // It applied, built and booted; only the family stayed vulnerable.
        expect(r).toMatchObject({
          familyFlipped: false,
          suitePassed: false,
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
