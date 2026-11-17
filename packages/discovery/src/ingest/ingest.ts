import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { inspect } from 'node:util';
import { loadToolManifest, quarantineSnapshot, runTool } from '../tools/index.js';
import { detectRepo } from './detect.js';
import { readGitleaksFindings } from './findings.js';
import { assertFullSha, checkoutPinned } from './git.js';
import { buildRedactionMap } from './map.js';
import type { SecretRedactor } from './redactor.js';
import { planSource } from './source.js';
import {
  IngestInputError,
  RedactionIncompleteError,
  RedactionLeakError,
  type Detection,
  type IngestDeps,
  type IngestOk,
  type IngestRequest,
  type IngestResult,
} from './types.js';
import { buildWorkspace, findLeaks } from './workspace.js';

function redactDetection(d: Detection, r: SecretRedactor): Detection {
  return {
    ...d,
    packageRoots: d.packageRoots.map((p) => r.applyPath(p)),
    frameworks: d.frameworks.map((f) => ({
      ...f,
      packageJson: r.applyPath(f.packageJson),
      evidence: f.evidence.map((p) => r.applyPath(p)),
    })),
  };
}

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * L1-01 Ingestion.
 *
 * 1. Fetch the pinned commit into a private checkout and verify HEAD by hash.
 * 2. Detect language and framework. A repo that is not an Express, Koa, Fastify or Next API
 *    project returns `unsupported`, and nothing is kept.
 * 3. Scan a private copy with gitleaks through the ToolRunnerPort (the quarantine, windows and
 *    coverage handling are runTool's), `.env` files included.
 * 4. Build the redaction map from every finding, then write the outgoing workspace from the
 *    checkout with `.env` files left out and every known secret replaced. A final pass fails the
 *    whole ingestion if any known value is still in it.
 *
 * Only `<workRoot>/<caseId>/workspace` survives, and only on success. Every other directory is
 * private to this call, created here and removed here.
 */
export async function ingestRepo(deps: IngestDeps, req: IngestRequest): Promise<IngestResult> {
  assertFullSha(req.commit);
  const commit = req.commit;
  const caseName = String(req.caseId);
  if (!SAFE_ID.test(caseName)) throw new IngestInputError('caseId is not a safe directory name');
  const plan = await planSource(req.source, {
    allowLocal: deps.allowLocalSource === true,
    allowedPorts: deps.allowedPorts,
    resolve: deps.resolveHost,
  });
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const manifest = deps.manifest ?? loadToolManifest();

  const workRoot = resolve(deps.workRoot);
  const caseDir = join(workRoot, caseName);
  if (!(caseDir + sep).startsWith(workRoot + sep)) throw new IngestInputError('bad caseId');
  await mkdir(caseDir, { recursive: false }); // fails if it exists: never reuse or clear old state
  const wsDir = join(caseDir, 'workspace');
  let ok = false;
  try {
    let redactor: SecretRedactor | undefined;
    const priv = await mkdtemp(join(caseDir, 'private-'));
    try {
      const repoDir = join(priv, 'repo');
      const home = join(priv, 'home');
      await mkdir(repoDir);
      await mkdir(home);
      await checkoutPinned({
        dir: repoDir,
        home,
        plan,
        commit,
        gitExecutable: deps.gitExecutable,
        timeoutMs: deps.gitTimeoutMs,
        maxRepoBytes: deps.maxRepoBytes,
        passProxyEnv: deps.passProxyEnv,
      });

      const detected = await detectRepo(repoDir);
      if (!detected.supported) {
        return { status: 'unsupported', commit, ...detected.unsupported };
      }

      // A private scan copy (without .git): quarantine moves files out of it.
      const scanDir = join(priv, 'scan');
      await cp(repoDir, scanDir, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => src !== join(repoDir, '.git'),
      });
      const snapshot = await quarantineSnapshot(scanDir);
      const run = await runTool(deps.runner, manifest, 'gitleaks', {
        snapshot,
        outputDir: join(priv, 'out'),
        scratchDir: join(priv, 'scratch'),
        configDir: deps.tools?.configDir,
        gitleaksConfigFile: deps.tools?.gitleaksConfigFile,
        maxWindowBytes: deps.tools?.maxWindowBytes,
        maxReportBytes: deps.tools?.maxReportBytes,
      });

      const { findings, malformed } = await readGitleaksFindings(run.reports, run.windowedFiles);
      if (malformed > 0) {
        throw new RedactionIncompleteError(Array(malformed).fill('<unreadable gitleaks result>'));
      }
      const map = await buildRedactionMap(repoDir, findings, maxFileBytes);
      redactor = map.redactor;
      const built = await buildWorkspace(repoDir, wsDir, map.redactor, map.excluded, maxFileBytes);
      const leaks = await findLeaks(wsDir, map.redactor);
      if (leaks.length > 0)
        throw new RedactionLeakError(leaks.map((p) => map.redactor.applyPath(p)));

      redactor = map.redactor;
      const r = redactor;
      const result: IngestOk = {
        status: 'ok',
        tenantId: req.tenantId,
        caseId: req.caseId,
        repo: req.repo,
        commit,
        workspacePath: wsDir,
        detection: redactDetection(detected.detection, r),
        redactions: built.redactions,
        redactor: r,
        excluded: built.excluded,
        scan: {
          partial: run.partial,
          // messages hold repo paths, and a path can carry a secret
          notifications: run.notifications.map((n) => ({
            ...n,
            message: r.apply(n.message),
          })),
          binaryMediaFiles: run.binaryMediaFiles.map((p) => r.applyPath(p)),
          windowedFiles: run.windowedFiles.map((p) => r.applyPath(p)),
          quarantined: run.quarantined.map((p) => r.applyPath(p)),
          findings: map.findings,
          redactedValues: r.size,
          shortValues: r.all().filter((e) => e.scope === 'located').length,
          lineFallbacks: r.all().filter((e) => !e.exact).length,
        },
      };
      // Last check, over everything this function returns and not only the workspace.
      const serialised = JSON.stringify(result) + inspect(result, { depth: 20 });
      if (
        r.all().some((e) => e.scope === 'global' && serialised.includes(e.value.toString('utf8')))
      ) {
        throw new RedactionLeakError(['<ingestion result>']);
      }
      ok = true;
      return result;
    } catch (e) {
      // Error text can quote repo paths, which can carry a secret.
      if (redactor !== undefined && e instanceof Error) {
        e.message = redactor.apply(e.message);
        if (e.stack !== undefined) e.stack = redactor.apply(e.stack);
      }
      throw e;
    } finally {
      await rm(priv, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  } finally {
    if (!ok) await rm(caseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
