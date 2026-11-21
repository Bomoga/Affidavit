import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { inspect } from 'node:util';
import { loadToolManifest, quarantineSnapshot, runTool } from '../tools/index.js';
import { detectRepo } from './detect.js';
import { readGitleaksFindings } from './findings.js';
import { assertFullSha, checkoutPinned } from './git.js';
import { buildRedactionMap } from './map.js';
import { entriesOf, SecretRedactor } from './redactor.js';
import { planSource } from './source.js';
import {
  CleanupFailedError,
  IngestInputError,
  RedactionIncompleteError,
  RedactionLeakError,
  type Detection,
  type IngestDeps,
  type IngestIncomplete,
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

const REMOVE = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;

/**
 * Replaces known values in every own string and string-array field of an error (message, stack,
 * path, dest, and custom ones such as NonUtf8NameError.dir), and recurses into `cause` and the
 * members of an AggregateError.
 */
export function redactError(e: unknown, r: SecretRedactor, seen = new Set<unknown>()): void {
  if (typeof e !== 'object' || e === null || seen.has(e)) return;
  seen.add(e);
  const o = e as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(e)) {
    const v = o[k];
    try {
      if (typeof v === 'string') o[k] = r.apply(v);
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        o[k] = v.map((x) => r.apply(x));
      }
    } catch {
      // a read-only property: leave it
    }
  }
  redactError(o['cause'], r, seen);
  const members = o['errors'];
  if (Array.isArray(members)) for (const m of members) redactError(m, r, seen);
}

/** Every string (and key) reachable from a value, skipping the redactor itself. */
function* stringsIn(v: unknown, seen = new Set<unknown>()): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (typeof v === 'object' && v !== null && !(v instanceof SecretRedactor) && !seen.has(v)) {
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      yield k;
      yield* stringsIn(x, seen);
    }
  }
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
  let redactor: SecretRedactor | undefined;
  const work = async (): Promise<IngestResult> => {
    const priv = await mkdtemp(join(caseDir, 'private-'));
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
      maxRepoFiles: deps.maxRepoFiles,
      passProxyEnv: deps.passProxyEnv,
      gitVersionProbe: deps.gitVersionProbe,
    });

    const detected = await detectRepo(repoDir);
    // Not ok: the case directory (and the checkout in it) is removed below.
    if (!detected.supported) return { status: 'unsupported', commit, ...detected.unsupported };

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

    const { findings, malformed } = await readGitleaksFindings(run.reports);
    if (malformed > 0) {
      throw new RedactionIncompleteError(Array(malformed).fill('<unreadable gitleaks result>'));
    }
    const map = await buildRedactionMap(repoDir, findings, maxFileBytes);
    const r = map.redactor;
    redactor = r; // from here on, errors are scrubbed of known values before they leave
    const incomplete = (): IngestIncomplete => ({
      status: 'incomplete',
      reason: 'partial-secret-scan',
      commit,
      coverage: {
        notifications: run.notifications.map((n) => ({
          level: n.level,
          ...(n.id === undefined ? {} : { id: n.id }),
          message: r.apply(n.message),
        })),
      },
    });
    // Fail closed: a scan that did not cover everything is not an ok result. The coverage detail
    // goes back to the caller; no workspace is kept and the case directory is removed. The one
    // loss an ok result may carry is a font whose structure checks out (`binary-font`): the
    // workspace build keeps every such file out, which is checked below.
    const gaps = run.notifications.filter((n) => n.id !== 'binary-font');
    const fontNotes = run.notifications.length - gaps.length;
    const partial = gaps.length > 0 || fontNotes !== run.binaryFontFiles.length;
    if (partial) return incomplete();
    const built = await buildWorkspace(repoDir, wsDir, r, map.excluded, maxFileBytes);
    // Every font the scan skipped must be absent from the workspace (left out as `font-file`, or
    // inside a directory left out for another reason). Otherwise fail closed.
    for (const p of run.binaryFontFiles) {
      const inWs = join(wsDir, ...r.applyPath(p.replace(/^\/src\//, '')).split('/'));
      if (
        await lstat(inWs).then(
          () => true,
          () => false,
        )
      )
        return incomplete();
    }
    const leaks = await findLeaks(wsDir, r);
    if (leaks.length > 0) throw new RedactionLeakError(leaks.map((p) => r.applyPath(p)));

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
        partial,
        // messages hold repo paths, and a path can carry a secret
        notifications: run.notifications.map((n) => ({ ...n, message: r.apply(n.message) })),
        binaryMediaFiles: run.binaryMediaFiles.map((p) => r.applyPath(p)),
        windowedFiles: run.windowedFiles.map((p) => r.applyPath(p)),
        binaryFontFiles: run.binaryFontFiles.map((p) => r.applyPath(p)),
        windowProvenFiles: run.windowProvenFiles.map((p) => r.applyPath(p)),
        quarantined: run.quarantined.map((p) => r.applyPath(p)),
        findings: map.findings,
        redactedValues: r.size,
        shortValues: entriesOf(r).filter((e) => e.scope === 'located').length,
        lineFallbacks: entriesOf(r).filter((e) => !e.exact).length,
      },
    };
    // Last check, over everything this function returns and not only the workspace.
    // Walks the strings themselves: JSON would hide a value behind escaping.
    const globals = entriesOf(r)
      .filter((e) => e.scope === 'global')
      .map((e) => e.value.toString('utf8'));
    for (const str of stringsIn(result)) {
      if (globals.some((g) => str.includes(g)))
        throw new RedactionLeakError(['<ingestion result>']);
    }
    if (globals.some((g) => inspect(result, { depth: 20 }).includes(g))) {
      throw new RedactionLeakError(['<ingestion result>']);
    }
    // The raw checkout goes before success is reported. If it cannot be removed, nothing is
    // returned and the whole case directory is removed instead.
    await rm(priv, REMOVE);
    return result;
  };
  const cleanup = async (cause?: unknown): Promise<void> => {
    try {
      await rm(caseDir, REMOVE);
    } catch {
      throw new CleanupFailedError(caseDir, cause);
    }
  };

  let result: IngestResult;
  try {
    result = await work();
  } catch (e) {
    // Error text can quote repo paths, which can carry a secret.
    if (redactor !== undefined) redactError(e, redactor);
    await cleanup(e);
    throw e;
  }
  // Unsupported: nothing is kept, so the case directory and its checkout go too.
  if (result.status !== 'ok') await cleanup();
  return result;
}
