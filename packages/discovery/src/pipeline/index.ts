/**
 * One case through the whole of discovery (L1-10b): ingestion, our Semgrep rules, the normalizer,
 * the map, arraignment and case file assembly, in that order, for one repository at one pinned
 * commit, ending in the outcome for ONE candidate. The worker's real intake, map and arraign stage
 * work call this; nothing here knows about stages, queues or events.
 *
 * Every per-run file lives in a fresh directory under `deps.workRoot` that is removed when the run
 * ends, whatever the outcome. Nothing from the repository is executed on the host.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  BootHints,
  CaseFile,
  CaseId,
  Dismissal,
  RepoId,
  TenantId,
  ToolRunnerPort,
} from '@affidavit/contracts';
import {
  arraign,
  type ArraignConfig,
  type Arraigned,
  type HeldForReview,
} from '../arraign/index.js';
import { assembleCaseFile, type CorpusAppLike } from '../casefile/index.js';
import { ingestRepo, type IngestDeps } from '../ingest/index.js';
import { buildMap, reachabilityFor } from '../map/index.js';
import { normalizeReports, readToolRunReports } from '../normalize/index.js';
import {
  loadToolManifest,
  quarantineSnapshot,
  repoRoot,
  runTool,
  type ToolManifest,
} from '../tools/index.js';

export interface DiscoverCaseInput {
  caseId: CaseId;
  tenantId: TenantId;
  repo: RepoId;
  /** Clone URL or local path (local only with `allowLocalSource`). Never carries credentials. */
  source: string;
  /** Full 40 character commit hash. */
  commit: string;
  /**
   * The candidate this case is about. When absent the highest-ranked trial candidate is chosen
   * (arraignment's order: score, then id), so a new case can be opened from a fresh scan.
   */
  candidateId?: string | undefined;
}

export interface DiscoverCaseDeps {
  /** The only way a scanner runs (gitleaks during ingestion, then Semgrep). */
  runner: ToolRunnerPort;
  /** Existing directory. Each run makes its own subdirectory here and removes it afterwards. */
  workRoot: string;
  arraignConfig: ArraignConfig;
  /** Corpus entries; one whose repo and pinned commit match supplies boot hints and safe variant. */
  corpus?: readonly CorpusAppLike[] | undefined;
  /** Boot hints when the corpus has none for the repository. */
  bootHints?: BootHints | undefined;
  manifest?: ToolManifest | undefined;
  /** Our Semgrep rules. Default `packages/discovery/rules/semgrep`. */
  rulesDir?: string | undefined;
  allowLocalSource?: boolean | undefined;
  /** Remaining ingestion settings (caps, git, resolver), passed through unchanged. */
  ingest?: Omit<IngestDeps, 'runner' | 'workRoot' | 'manifest' | 'allowLocalSource'> | undefined;
}

/**
 * What discovery says about one case. A value, never a thrown error, for every outcome the
 * pipeline is built to reach; infrastructure failures (git, Docker, a tool that crashed) throw.
 */
export type DiscoverCaseOutcome =
  /** The candidate goes to trial with this contract-valid case file. */
  | {
      kind: 'case-file';
      caseFile: CaseFile;
      /** Files whose slice was withheld (`AssembleResult.withheld`). */
      withheld: string[];
      /** True when Semgrep reported a coverage loss. The candidate exists, but others may not. */
      scanPartial: boolean;
    }
  /** Arraignment dismissed the candidate with a recorded reason (always below the floor). */
  | { kind: 'dismissed'; dismissal: Dismissal }
  /**
   * An F3 hold: a dismissal rule matched a candidate at or above the escalation floor. Never
   * dismissed. `route` is arraignment's: `person` only, or a person or a second Defense attempt.
   */
  | {
      kind: 'review';
      candidateId: string;
      wouldDismiss: HeldForReview['wouldDismiss'];
      route: HeldForReview['route'];
      detail: string;
    }
  /** Ingestion found no Node app it supports. Fixed text only, never repo content. */
  | { kind: 'unsupported'; reason: string; detail: string }
  /** Ingestion failed closed: the secret scan did not cover every file. No workspace was kept. */
  | { kind: 'incomplete'; reason: 'partial-secret-scan'; coverageLosses: number }
  /** The scan did not produce the requested candidate (or none went to trial). */
  | { kind: 'not-found'; candidateId: string | null };

/** Arraignment refused its input (for example two map answers for one candidate). */
export class DiscoveryPipelineError extends Error {
  constructor(
    readonly step: 'arraign',
    message: string,
  ) {
    super(`discovery ${step} step refused its input: ${message}`);
    this.name = 'DiscoveryPipelineError';
  }
}

/** JSON with object keys sorted, so a case file read back from a database compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/**
 * The top-level fields where two case files differ (key order ignored), sorted; empty when they
 * are the same. Names only, never values, so the result is safe to put in an error or a log.
 */
export function caseFileDiff(a: CaseFile, b: CaseFile): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  return [...keys].filter((k) => canonical(ra[k]) !== canonical(rb[k])).sort();
}

function corpusFor(
  corpus: readonly CorpusAppLike[] | undefined,
  repo: string,
  commit: string,
): CorpusAppLike | undefined {
  return corpus?.find((a) => a.repo === repo && a.pin.commit === commit);
}

export async function discoverCase(
  deps: DiscoverCaseDeps,
  input: DiscoverCaseInput,
): Promise<DiscoverCaseOutcome> {
  const runDir = mkdtempSync(join(deps.workRoot, 'discover-'));
  try {
    const manifest = deps.manifest ?? loadToolManifest();
    // ingestRepo creates <workRoot>/<caseId> itself and refuses one that exists, so every run
    // (a retry included) gets a workRoot of its own.
    const cases = join(runDir, 'cases');
    mkdirSync(cases);
    const ingested = await ingestRepo(
      {
        ...deps.ingest,
        runner: deps.runner,
        workRoot: cases,
        manifest,
        allowLocalSource: deps.allowLocalSource,
      },
      {
        tenantId: input.tenantId,
        caseId: input.caseId,
        repo: input.repo,
        source: input.source,
        commit: input.commit,
      },
    );
    if (ingested.status === 'unsupported') {
      return { kind: 'unsupported', reason: ingested.reason, detail: ingested.detail };
    }
    if (ingested.status === 'incomplete') {
      return {
        kind: 'incomplete',
        reason: ingested.reason,
        coverageLosses: ingested.coverage.notifications.length,
      };
    }

    // Our own Semgrep rules on a quarantined snapshot of the redacted workspace.
    const snapDir = join(runDir, 'snap');
    cpSync(ingested.workspacePath, snapDir, {
      recursive: true,
      filter: (p) => basename(p) !== '.git',
    });
    const run = await runTool(deps.runner, manifest, 'semgrep', {
      snapshot: await quarantineSnapshot(snapDir),
      outputDir: join(runDir, 'out'),
      scratchDir: join(runDir, 'scratch'),
      rulesDir: deps.rulesDir ?? join(repoRoot(), 'packages', 'discovery', 'rules', 'semgrep'),
    });
    const scanPartial = run.notifications.length > 0;
    const reports = await readToolRunReports(run);
    const normalized = normalizeReports(reports.map((r) => ({ ...r, partial: scanPartial })));

    const map = await buildMap({ root: ingested.workspacePath });
    let arraigned;
    try {
      arraigned = arraign({
        candidates: normalized.candidates,
        reachability: reachabilityFor(map, normalized.candidates),
        dataAccess: map.dataAccess,
        config: deps.arraignConfig,
      });
    } catch (err) {
      // A bug in the inputs, not in the repository: the caller fails the job visibly.
      throw new DiscoveryPipelineError(
        'arraign',
        err instanceof Error ? err.message : 'unknown error',
      );
    }

    const want = input.candidateId ?? null;
    const dismissal =
      want === null ? undefined : arraigned.dismissed.find((d) => d.candidateId === want);
    if (dismissal) return { kind: 'dismissed', dismissal };
    const hold = want === null ? undefined : arraigned.review.find((r) => r.candidate.id === want);
    if (hold) {
      return {
        kind: 'review',
        candidateId: hold.candidate.id,
        wouldDismiss: hold.wouldDismiss,
        route: hold.route,
        detail: hold.detail,
      };
    }
    const chosen: Arraigned | undefined =
      want === null ? arraigned.toTrial[0] : arraigned.toTrial.find((t) => t.candidate.id === want);
    if (!chosen) return { kind: 'not-found', candidateId: want };

    const assembled = await assembleCaseFile({
      caseId: input.caseId,
      tenantId: ingested.tenantId,
      repo: ingested.repo,
      commit: ingested.commit,
      workspacePath: ingested.workspacePath,
      redactions: ingested.redactions,
      redact: (s) => ingested.redactor.apply(s),
      arraigned: chosen,
      corpus: corpusFor(deps.corpus, ingested.repo, ingested.commit),
      bootHints: deps.bootHints,
    });
    return {
      kind: 'case-file',
      caseFile: assembled.caseFile,
      withheld: assembled.withheld,
      scanPartial,
    };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
