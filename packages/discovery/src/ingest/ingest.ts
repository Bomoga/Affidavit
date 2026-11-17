import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { loadToolManifest, quarantineSnapshot, runTool } from '../tools/index.js';
import { detectRepo } from './detect.js';
import { readGitleaksFindings } from './findings.js';
import { assertFullSha, checkoutPinned, validateSource } from './git.js';
import { buildRedactionMap } from './map.js';
import {
  IngestInputError,
  RedactionIncompleteError,
  RedactionLeakError,
  type IngestDeps,
  type IngestRequest,
  type IngestResult,
} from './types.js';
import { buildWorkspace, findLeaks } from './workspace.js';

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
  validateSource(req.source, deps.allowLocalSource === true);
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const manifest = deps.manifest ?? loadToolManifest();

  const workRoot = resolve(deps.workRoot);
  const caseDir = join(workRoot, caseName);
  if (!(caseDir + sep).startsWith(workRoot + sep)) throw new IngestInputError('bad caseId');
  await mkdir(caseDir, { recursive: false }); // fails if it exists: never reuse or clear old state
  const wsDir = join(caseDir, 'workspace');
  let ok = false;
  try {
    const priv = await mkdtemp(join(caseDir, 'private-'));
    try {
      const repoDir = join(priv, 'repo');
      const home = join(priv, 'home');
      await mkdir(repoDir);
      await mkdir(home);
      await checkoutPinned({
        dir: repoDir,
        home,
        source: req.source,
        commit,
        allowLocal: deps.allowLocalSource === true,
        gitExecutable: deps.gitExecutable,
        timeoutMs: deps.gitTimeoutMs,
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
      const built = await buildWorkspace(repoDir, wsDir, map.redactor, map.excluded, maxFileBytes);
      const leaks = await findLeaks(wsDir, map.redactor);
      if (leaks.length > 0)
        throw new RedactionLeakError(leaks.map((p) => map.redactor.applyPath(p)));

      ok = true;
      const redactor = map.redactor;
      return {
        status: 'ok',
        tenantId: req.tenantId,
        caseId: req.caseId,
        repo: req.repo,
        commit,
        workspacePath: wsDir,
        detection: detected.detection,
        redactions: built.redactions,
        redactor,
        excluded: built.excluded,
        scan: {
          partial: run.partial,
          // messages hold repo paths, and a path can carry a secret
          notifications: run.notifications.map((n) => ({
            ...n,
            message: redactor.apply(n.message),
          })),
          binaryMediaFiles: run.binaryMediaFiles.map((p) => redactor.applyPath(p)),
          windowedFiles: run.windowedFiles.map((p) => redactor.applyPath(p)),
          quarantined: run.quarantined.map((p) => redactor.applyPath(p)),
          findings: map.findings,
          redactedValues: redactor.size,
        },
      };
    } finally {
      await rm(priv, { recursive: true, force: true });
    }
  } finally {
    if (!ok) await rm(caseDir, { recursive: true, force: true });
  }
}
