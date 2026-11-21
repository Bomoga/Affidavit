/**
 * L1-07 acceptance: real discovery on OWASP NodeGoat at the pinned commit produces the gate case
 * file. Every step is the real one: ingestion (git checkout verified by hash, gitleaks through the
 * pinned image, redaction), our own Semgrep rules through the pinned image, the SARIF normalizer,
 * the map, arraignment and assembly. Nothing from the checkout is executed on the host.
 *
 * Needs Docker and a checkout of the pinned NodeGoat tree. Either:
 *   AFFIDAVIT_DOCKER_TESTS=1 AFFIDAVIT_CORPUS_NETWORK=1        fetch it (commit, tree, archive hash)
 *   AFFIDAVIT_DOCKER_TESTS=1 AFFIDAVIT_MAP_NODEGOAT_DIR=<dir>  an existing checkout (with .git)
 * Add AFFIDAVIT_CASEFILE_WRITE=1 to (re)write fixtures/casefiles/nodegoat-nosqli-where-001.json;
 * without it the run is compared with that file.
 *
 *   PowerShell: $env:AFFIDAVIT_DOCKER_TESTS = '1'; $env:AFFIDAVIT_CORPUS_NETWORK = '1'
 *               pnpm --filter @affidavit/discovery test casefile.nodegoat
 */
import { execFile } from 'node:child_process';
import {
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
import {
  CaseFile,
  CaseId,
  RepoId,
  TenantId,
  type Redaction,
  type ToolRunnerPort,
} from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arraign, arraignConfigFrom, type ArraignResult } from '../arraign/index.js';
import { ingestRepo, isEnvName } from '../ingest/index.js';
import { buildMap, reachabilityFor } from '../map/index.js';
import { normalizeReports, readToolRunReports, type NormalizeResult } from '../normalize/index.js';
import { loadToolManifest, quarantineSnapshot, repoRoot, runTool } from '../tools/index.js';
import { assembleCaseFile, type AssembleResult, type CorpusAppLike } from './index.js';

const existing = process.env['AFFIDAVIT_MAP_NODEGOAT_DIR'];
const enabled =
  process.env['AFFIDAVIT_DOCKER_TESTS'] === '1' &&
  (existing !== undefined || process.env['AFFIDAVIT_CORPUS_NETWORK'] === '1');
const write = process.env['AFFIDAVIT_CASEFILE_WRITE'] === '1';
const allowUningested = process.env['AFFIDAVIT_CASEFILE_UNINGESTED_OK'] === '1';

const NODEGOAT_CASEFILE = join(
  repoRoot(),
  'fixtures',
  'casefiles',
  'nodegoat-nosqli-where-001.json',
);
const GATE = { file: 'app/data/allocations-dao.js', startLine: 77, endLine: 79 };

// The jail flags of buildDockerRunArgs in packages/testing/src/infra.ts, as in the other
// discovery Docker tests.
const JAIL = [
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

const runner: ToolRunnerPort = {
  run(image, args, mounts) {
    const argv = [
      'run',
      ...JAIL,
      ...mounts.flatMap((m) => [
        '-v',
        `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`,
      ]),
      image,
      ...args,
    ];
    return new Promise((resolve) => {
      execFile('docker', argv, (error) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ exitCode: code, outputPath: tmpdir() });
      });
    });
  },
};

interface Pin {
  repoUrl: string;
  commit: string;
  tree: string;
  archiveSha256: string;
}

describe.skipIf(!enabled)(
  'real discovery on NodeGoat produces the gate case file',
  { timeout: 900_000 },
  () => {
    let work = '';
    let app: CorpusAppLike;
    let ws: {
      tenantId: TenantId;
      repo: RepoId;
      commit: string;
      workspacePath: string;
      redactions: Redaction[];
      redact: ((s: string) => string) | undefined;
    };
    let ingestStatus = '';
    let incompleteNotifications: string[] = [];
    let normalized: NormalizeResult;
    let arraigned: ArraignResult;
    let assembled: AssembleResult;
    let sourceText = '';

    beforeAll(async () => {
      work = mkdtempSync(join(tmpdir(), 'affidavit-casefile-'));
      // The corpus loader itself (validated index, pin, labels, safe variants).
      const corpus = (await import(
        pathToFileURL(join(repoRoot(), 'packages', 'corpus', 'src', 'index.ts')).href
      )) as { getApp(id: string): CorpusAppLike & { pin: Pin } };
      const nodegoat = corpus.getApp('nodegoat');
      app = nodegoat;
      let src = existing ?? '';
      if (!existing) {
        src = join(work, 'nodegoat');
        const mod = (await import(
          pathToFileURL(join(repoRoot(), 'packages', 'corpus', 'scripts', 'fetch-pinned.mjs')).href
        )) as { fetchPinned(o: Pin & { dest: string }): Promise<void> };
        await mod.fetchPinned({ ...nodegoat.pin, dest: src });
      }

      // 1. Ingestion (L1-01).
      const workRoot = join(work, 'cases');
      mkdirSync(workRoot);
      const caseId = CaseId.parse('case-nodegoat-nosqli-where-001');
      const result = await ingestRepo(
        { runner, workRoot, allowLocalSource: true },
        {
          tenantId: TenantId.parse('tenant-dev'),
          caseId,
          repo: RepoId.parse(nodegoat.repo),
          source: src,
          commit: nodegoat.pin.commit,
        },
      );
      ingestStatus = result.status;
      if (result.status === 'ok') {
        ws = {
          tenantId: result.tenantId,
          repo: result.repo,
          commit: result.commit,
          workspacePath: result.workspacePath,
          redactions: result.redactions,
          redact: (s) => result.redactor.apply(s),
        };
      } else if (result.status === 'incomplete' && allowUningested) {
        // Ingestion failed closed (a secret scan that may not have covered every file). Only with
        // the explicit flag, and only for this public corpus tree: use the hash-verified pinned
        // checkout instead, without .git and without .env files. No redaction is applied, and the
        // first test prints that it happened.
        incompleteNotifications = result.coverage.notifications.map((n) => n.message);
        const head = await new Promise<string>((res, rej) => {
          execFile('git', ['-C', src, 'rev-parse', '--verify', 'HEAD^{commit}'], (e, out) => {
            if (e) rej(new Error(`git rev-parse failed: ${e.message}`));
            else res(out.trim());
          });
        });
        if (head !== nodegoat.pin.commit) throw new Error('checkout is not at the pinned commit');
        const copy = join(work, 'uningested');
        cpSync(src, copy, {
          recursive: true,
          filter: (p) => basename(p) !== '.git' && !isEnvName(basename(p)),
        });
        ws = {
          tenantId: TenantId.parse('tenant-dev'),
          repo: RepoId.parse(nodegoat.repo),
          commit: nodegoat.pin.commit,
          workspacePath: copy,
          redactions: [],
          redact: undefined,
        };
      } else {
        throw new Error(
          `ingestion did not succeed (AFFIDAVIT_CASEFILE_UNINGESTED_OK=1 uses the verified checkout): ${JSON.stringify(result)}`,
        );
      }

      // 2. Our own Semgrep rules on a quarantined snapshot of the redacted workspace (L1-02, L1-04).
      const snapDir = join(work, 'snap');
      cpSync(ws.workspacePath, snapDir, {
        recursive: true,
        filter: (p) => basename(p) !== '.git',
      });
      const manifest = loadToolManifest();
      const run = await runTool(runner, manifest, 'semgrep', {
        snapshot: await quarantineSnapshot(snapDir),
        outputDir: join(work, 'out'),
        scratchDir: join(work, 'scratch'),
        rulesDir: join(repoRoot(), 'packages', 'discovery', 'rules', 'semgrep'),
      });
      const reports = await readToolRunReports(run);
      // 3. Normalizer (L1-03). A partial run is passed through as partial.
      normalized = normalizeReports(
        reports.map((r) => ({ ...r, partial: run.notifications.length > 0 })),
      );

      // 4. The map (L1-05) and 5. arraignment (L1-06).
      const map = await buildMap({ root: ws.workspacePath });
      arraigned = arraign({
        candidates: normalized.candidates,
        reachability: reachabilityFor(map, normalized.candidates),
        dataAccess: map.dataAccess,
        config: arraignConfigFrom({}),
      });

      // 6. Assembly (L1-07).
      const gate = arraigned.toTrial.find(
        (t) =>
          t.candidate.file === GATE.file &&
          t.candidate.range.startLine <= GATE.endLine &&
          t.candidate.range.endLine >= GATE.startLine &&
          t.candidate.cls === 'injection',
      );
      if (!gate) throw new Error('the gate candidate did not go to trial');
      assembled = await assembleCaseFile({
        caseId,
        tenantId: ws.tenantId,
        repo: ws.repo,
        commit: ws.commit,
        workspacePath: ws.workspacePath,
        redactions: ws.redactions,
        redact: ws.redact,
        arraigned: gate,
        corpus: app,
      });
      sourceText = readFileSync(join(ws.workspacePath, GATE.file), 'utf8');
    }, 900_000);

    afterAll(() => {
      if (work) rmSync(work, { recursive: true, force: true });
    });

    it('records how the workspace was made', () => {
      // Printed so the run log shows whether ingestion succeeded or the verified checkout was used.
      console.log(
        JSON.stringify({
          ingestStatus,
          uningested: ingestStatus !== 'ok',
          incompleteNotifications,
        }),
      );
      if (ingestStatus !== 'ok') {
        // Every coverage gap must be in a font or the lockfile, never in a file that is sliced.
        for (const m of incompleteNotifications) {
          expect(m).toMatch(
            /^\/src\/(app\/assets\/vendor\/theme\/font-awesome\/fonts\/[^ ]+|package-lock\.json) /,
          );
        }
      }
    });

    it('accounts for every candidate: trial, dismissal with a reason, or review', () => {
      const ids = [
        ...arraigned.toTrial.map((t) => t.candidate.id),
        ...arraigned.dismissed.map((d) => d.candidateId),
        ...arraigned.review.map((r) => r.candidate.id),
      ].sort();
      expect(ids).toEqual(normalized.candidates.map((c) => c.id).sort());
      for (const d of arraigned.dismissed) expect(d.detail.length).toBeGreaterThan(0);
    });

    it('builds a contract-valid case file for the gate issue', () => {
      const cf = assembled.caseFile;
      expect(CaseFile.safeParse(cf).success).toBe(true);
      expect(assembled.labelId).toBe('nodegoat-nosqli-allocations-where');
      expect(assembled.safeVariantId).toBe('nodegoat-safe-nosqli-allocations-where');
      expect(cf.target).toEqual({
        repo: 'repo-nodegoat',
        commit: app.pin.commit,
        variant: 'vulnerable',
      });
      expect(cf.safeVariant).toEqual({
        repo: 'repo-nodegoat',
        commit: app.pin.commit,
        variant: 'safe',
      });
      expect(cf.candidate.ruleId).toBe('affidavit.injection.nosql-where-template');
      expect(cf.candidate.reachability).toBe('reachable');
      expect(cf.candidate.score).toBeGreaterThanOrEqual(cf.escalationFloor);
      expect(cf.route).toEqual({
        method: 'GET',
        path: '/allocations/:userId',
        handlerFile: 'app/routes/allocations.js',
        middleware: ['isLoggedIn'],
        authRequired: true,
      });
      expect(cf.bootHints).toEqual(app.bootHints);
      expect(assembled.withheld).toEqual([]);
    });

    it('slices are untrusted, show the sink, and carry none of the comment text', () => {
      const cf = assembled.caseFile;
      expect(cf.slices.length).toBeGreaterThan(0);
      for (const s of cf.slices) {
        expect(s.untrusted).toBe(true);
        expect(s.strippedComments).toBe(true);
      }
      const sink = cf.slices.find(
        (s) => s.file === GATE.file && s.range.startLine <= GATE.startLine,
      );
      expect(sink?.code).toContain(
        "$where: `this.userId == ${parsedUserId} && this.stocks > '${threshold}'`",
      );
      // The upstream comment above the sink holds a fix and exploit payloads. It is in the source and
      // must not be in any slice.
      expect(sourceText).toContain('Fix for A1 - 2 NoSQL Injection');
      const all = cf.slices.map((s) => s.code).join('\n');
      expect(all).not.toContain('Fix for A1');
      expect(all).not.toContain('while(true)');
      expect(all).not.toMatch(/\/\/|\/\*/);
    });

    it('is stable: the same run gives the recorded case file', () => {
      const json = `${JSON.stringify(assembled.caseFile, null, 2)}\n`;
      if (write) writeFileSync(NODEGOAT_CASEFILE, json);
      expect(existsSync(NODEGOAT_CASEFILE), 'run once with AFFIDAVIT_CASEFILE_WRITE=1').toBe(true);
      expect(readFileSync(NODEGOAT_CASEFILE, 'utf8')).toBe(json);
    });
  },
);
