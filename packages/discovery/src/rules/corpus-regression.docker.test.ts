/**
 * Corpus regression for our own Semgrep rules (L1-04). Skipped unless AFFIDAVIT_DOCKER_TESTS=1.
 * Needs Docker with the pinned Semgrep image, git, and network access to github.com (the NodeGoat
 * corpus is fetched at the pinned commit and verified by commit, tree and archive hash; nothing
 * from it is executed).
 *
 *   PowerShell: $env:AFFIDAVIT_DOCKER_TESTS = '1'
 *               pnpm --filter @affidavit/discovery exec vitest run corpus-regression.docker
 *
 * Optional environment:
 *   AFFIDAVIT_RULES_STAMP=write       on a passing run, write rules/regression-stamp.json
 *   AFFIDAVIT_RULES_REPORT_OUT=<file> write the per-rule table (markdown) to this file
 *
 * What it does:
 *   1. Runs Semgrep's own rule tests (`semgrep --test`) for every rule file.
 *   2. Fetches NodeGoat (vulnerable), the safe variant and the negative control from the corpus.
 *   3. Runs the rules over each tree through runTool (the hardened wrapper, pinned image, no
 *      network, read-only source) and compares per-rule results with the corpus labels.
 */
import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadToolManifest, quarantineSnapshot, repoRoot, runTool } from '../tools/index.js';
import {
  evaluate,
  formatEvaluation,
  handlerEndLine,
  handlerEndProblems,
  type CorpusLite,
  listRuleIds,
  parseSemgrepSarif,
  regressionInputsDigest,
  runOutputDigest,
  type TreeRun,
  type TreeVariant,
} from './corpus-regression.js';
import { corpusDataDir, loadCorpusLite, loadExpectations, rulesRoot, writeStamp } from './load.js';

const enabled = process.env['AFFIDAVIT_DOCKER_TESTS'] === '1';

/**
 * The jail flags, in the order the fake ToolRunner uses (see tools.docker.test.ts, which pins them
 * against packages/testing/src/infra.ts).
 */
const JAIL_FLAGS: readonly string[] = [
  '--rm',
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '256',
  '--memory',
  '1g',
];

function dockerArgs(
  image: string,
  args: readonly string[],
  mounts: readonly { hostPath: string; containerPath: string; readOnly: boolean }[],
): string[] {
  return [
    'run',
    ...JAIL_FLAGS,
    ...mounts.flatMap((m) => ['-v', `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`]),
    image,
    ...args,
  ];
}

const runner: ToolRunnerPort = {
  run(image, args, mounts) {
    return new Promise((resolve) => {
      execFile('docker', dockerArgs(image, args, mounts), (error) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ exitCode, outputPath: tmpdir() });
      });
    });
  },
};

interface Pin {
  repoUrl: string;
  commit: string;
  tree: string;
  archiveSha256: string;
  patches: Record<string, { path: string; sha256: string }>;
}

interface FetchPinned {
  fetchPinned(opts: {
    repoUrl: string;
    commit: string;
    tree: string;
    archiveSha256: string;
    dest: string;
    patches?: { path: string; sha256: string }[];
  }): Promise<void>;
}

describe.skipIf(!enabled)('own Semgrep rules, Docker and corpus', { timeout: 900_000 }, () => {
  const manifest = loadToolManifest();
  const semgrep = manifest.tools.find((t) => t.name === 'semgrep');
  const image = semgrep?.reference ?? '';
  const rulesDir = join(rulesRoot(), 'semgrep');
  const testsDir = join(rulesRoot(), 'tests');
  const corpus = loadCorpusLite();
  const expectations = loadExpectations();
  const ruleIds = listRuleIds(rulesDir);
  const pin = JSON.parse(readFileSync(join(corpusDataDir(), 'pin.json'), 'utf8')) as Pin;
  const app = JSON.parse(readFileSync(join(corpusDataDir(), 'app.json'), 'utf8')) as {
    safeVariants: { patches: string[] }[];
    negativeControls: { patches: string[] }[];
  };

  let work = '';
  const runs = {} as Record<TreeVariant, TreeRun>;
  let counter = 0;
  const fetchedDirs: Partial<Record<TreeVariant, string>> = {};

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'affidavit-rules-'));
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('uses the pinned Semgrep image and a rule set of our own', () => {
    expect(image).toMatch(/^docker\.io\/semgrep\/semgrep@sha256:[0-9a-f]{64}$/);
    expect(ruleIds.length).toBeGreaterThan(0);
  });

  it("passes Semgrep's own rule tests (ruleid and ok annotations)", async () => {
    const scratch = join(work, 'ruletests');
    // Writable for the container's root, which runs without CAP_DAC_OVERRIDE (--cap-drop ALL), so
    // a directory left at the umask's 0755 would be read-only to it on a Linux host.
    for (const sub of ['tmp', 'semgrep-home']) {
      mkdirSync(join(scratch, sub), { recursive: true });
      chmodSync(join(scratch, sub), 0o777);
    }
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'docker',
        dockerArgs(
          image,
          [
            'semgrep',
            '--test',
            '--json',
            '--metrics=off',
            '--disable-version-check',
            '--config',
            '/rules',
            '/tests',
          ],
          [
            { hostPath: rulesDir, containerPath: '/rules', readOnly: true },
            { hostPath: testsDir, containerPath: '/tests', readOnly: true },
            { hostPath: join(scratch, 'tmp'), containerPath: '/tmp', readOnly: false },
            {
              hostPath: join(scratch, 'semgrep-home'),
              containerPath: '/root/.semgrep',
              readOnly: false,
            },
          ],
        ),
        { maxBuffer: 64 * 1024 * 1024 },
        (error, out) => {
          if (error && out.length === 0)
            reject(error instanceof Error ? error : new Error('docker'));
          else resolve(out);
        },
      );
    });
    const doc = JSON.parse(stdout) as {
      config_missing_tests: string[];
      config_with_errors: string[];
      results: Record<string, { checks: Record<string, { passed: boolean; errors: unknown[] }> }>;
    };
    expect(doc.config_missing_tests).toEqual([]);
    expect(doc.config_with_errors).toEqual([]);
    const checked: string[] = [];
    for (const file of Object.values(doc.results)) {
      for (const [id, check] of Object.entries(file.checks)) {
        expect(check.passed, `rule test for ${id}`).toBe(true);
        expect(check.errors, `errors in rule test for ${id}`).toEqual([]);
        checked.push(id);
      }
    }
    expect(checked.sort()).toEqual([...ruleIds].sort());
  });

  /** Fetches one corpus tree (commit, tree and archive hash verified), copies it, runs the rules. */
  async function scan(variant: TreeVariant): Promise<TreeRun> {
    const id = `${variant}-${++counter}`;
    const mod = (await import(
      pathToFileURL(join(repoRoot(), 'packages', 'corpus', 'scripts', 'fetch-pinned.mjs')).href
    )) as FetchPinned;
    const patchIds =
      variant === 'safe'
        ? (app.safeVariants[0]?.patches ?? [])
        : variant === 'negative-control'
          ? (app.negativeControls[0]?.patches ?? [])
          : [];
    const fetched = join(work, `fetched-${id}`);
    fetchedDirs[variant] = fetched;
    await mod.fetchPinned({
      repoUrl: pin.repoUrl,
      commit: pin.commit,
      tree: pin.tree,
      archiveSha256: pin.archiveSha256,
      dest: fetched,
      patches: patchIds.map((p) => {
        const entry = pin.patches[p];
        if (!entry) throw new Error(`unknown patch ${p}`);
        return { path: join(corpusDataDir(), entry.path), sha256: entry.sha256 };
      }),
    });
    // A private scan copy without the fetch's own .git (the quarantine step would move it aside
    // anyway; this keeps the snapshot to repo content).
    const snapDir = join(work, `snap-${id}`);
    cpSync(fetched, snapDir, { recursive: true, filter: (p) => basename(p) !== '.git' });
    expect(existsSync(join(snapDir, '.git'))).toBe(false);
    const snapshot = await quarantineSnapshot(snapDir);
    const result = await runTool(runner, manifest, 'semgrep', {
      snapshot,
      outputDir: join(work, `out-${id}`),
      scratchDir: join(work, `scratch-${id}`),
      rulesDir,
    });
    expect(result.empty).toBe(false);
    const report = result.reports[0];
    if (!report) throw new Error('no semgrep report');
    const findings = parseSemgrepSarif(JSON.parse(readFileSync(report.file, 'utf8')) as unknown);
    return {
      variant,
      findings,
      notifications: result.notifications.map((n) => n.message),
    };
  }

  it('matches the corpus labels, safe variant and negative control, rule by rule', async () => {
    for (const variant of ['vulnerable', 'safe', 'negative-control'] as const) {
      runs[variant] = await scan(variant);
    }
    // IDOR findings sit on the data-access call, so an IDOR label also counts findings in the same
    // handler. The handler extent is read from the vulnerable tree.
    const vulnerableDir = fetchedDirs['vulnerable'] ?? '';
    const corpusWithExtents: CorpusLite = {
      ...corpus,
      labels: corpus.labels.map((l) =>
        l.cls === 'idor'
          ? {
              ...l,
              handlerEndLine: handlerEndLine(
                readFileSync(join(vulnerableDir, l.source.file), 'utf8'),
                l.source.range.startLine,
                l.source.range.endLine,
              ),
            }
          : l,
      ),
    };
    const evaluation = evaluate(corpusWithExtents, expectations, ruleIds, runs);
    const table = formatEvaluation(evaluation, corpusWithExtents);
    console.log(
      [
        '',
        `Semgrep image: ${image}`,
        `NodeGoat commit: ${pin.commit}`,
        `Findings per tree: ${(['vulnerable', 'safe', 'negative-control'] as const)
          .map((v) => `${v}=${String(runs[v].findings.length)}`)
          .join(' ')}`,
        `Notifications per tree: ${(['vulnerable', 'safe', 'negative-control'] as const)
          .map((v) => `${v}=${String(runs[v].notifications.length)}`)
          .join(' ')}`,
        table,
        '',
      ].join('\n'),
    );
    const out = process.env['AFFIDAVIT_RULES_REPORT_OUT'];
    if (out) {
      const detail = (['vulnerable', 'safe', 'negative-control'] as const)
        .map(
          (v) =>
            `${v}:\n${runs[v].findings
              .map((f) => `  ${f.ruleId} ${f.file}:${f.startLine}-${f.endLine}`)
              .join(
                '\n',
              )}\nnotifications:\n${runs[v].notifications.map((n) => `  ${n.split('\n')[0] ?? ''}`).join('\n')}`,
        )
        .join('\n');
      writeFileSync(out, `${table}\n\n${detail}\n`);
    }
    const pinProblems = handlerEndProblems(corpusWithExtents.labels, expectations);
    expect([...pinProblems, ...evaluation.problems]).toEqual([]);

    if (process.env['AFFIDAVIT_RULES_STAMP'] === 'write') {
      writeStamp({
        inputsSha256: regressionInputsDigest(repoRoot()),
        runOutputSha256: runOutputDigest(runs, evaluation),
        semgrepImage: image,
        nodegoatCommit: pin.commit,
        ranOn: new Date().toISOString().slice(0, 10),
      });
    }
  });
});
