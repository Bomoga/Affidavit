import type { CaseId, Redaction, RepoId, TenantId, ToolRunnerPort } from '@affidavit/contracts';
import type { ToolManifest, ToolNotification } from '../tools/index.js';
import type { SecretRedactor } from './redactor.js';
import type { HostResolver } from './source.js';

export type Framework = 'express' | 'koa' | 'fastify' | 'next-api';

export interface FrameworkEvidence {
  framework: Framework;
  /** Repo-relative path of the package.json that declares it. */
  packageJson: string;
  /** `dependency` for express, koa and fastify; `route-files` for Next API routes. */
  via: 'dependency' | 'route-files';
  /** Repo-relative paths that back the claim (route files for Next). Capped at 10. */
  evidence: string[];
}

export interface Detection {
  language: 'javascript' | 'typescript';
  frameworks: FrameworkEvidence[];
  /** Repo-relative directories that hold a package.json, sorted. */
  packageRoots: string[];
}

export type UnsupportedReason =
  | 'no-package-json'
  | 'no-js-ts-sources'
  | 'no-supported-framework'
  /** The tree was too big to walk fully (entry or depth cap), so absence of a framework proves nothing. */
  | 'tree-too-large-to-scan';

/** The repo is not a Node app we can run. A value, never a thrown error. Nothing is kept on disk. */
export interface IngestUnsupported {
  status: 'unsupported';
  reason: UnsupportedReason;
  /** Fixed text per reason. Never repo content. */
  detail: string;
  commit: string;
  /** Source file counts by language family, for the "why" in a UI. Counts only. */
  observed: Record<string, number>;
}

export type ExclusionReason =
  /** `.env`, `.env.*` (any case) or a directory named `.env`. Scanned, never copied out. */
  | 'env-file'
  /** gitleaks found a secret in a file whose content cannot be rewritten safely (archive, binary). */
  | 'secret-in-non-text-file'
  /** A known secret is stored in an encoding the redactor does not rewrite (UTF-16). */
  | 'secret-in-other-encoding'
  /** A finding in this file could not be located, so the file is not trusted. */
  | 'unresolvable-finding'
  | 'too-large'
  /** Two files would be written to the same name; the second is left out. */
  | 'name-collision'
  | 'not-regular-file';

export interface ExcludedFile {
  /** Repo-relative path. Already passed through the redactor. */
  path: string;
  reason: ExclusionReason;
}

export interface IngestScan {
  /**
   * True when gitleaks may have missed something (see ToolRunResult.partial). Findings are then
   * incomplete and the redaction map may be too. Never silently dropped: callers decide whether
   * to escalate.
   */
  partial: boolean;
  notifications: ToolNotification[];
  binaryMediaFiles: string[];
  windowedFiles: string[];
  /** Tool-control paths that quarantine moved aside for the scan (not removed from the workspace). */
  quarantined: readonly string[];
  /** Distinct gitleaks findings after merging the snapshot, quarantine and windows reports. */
  findings: number;
  /** Distinct secret values in the redaction map. */
  redactedValues: number;
  /**
   * Values under 8 bytes. They are replaced only on the lines gitleaks reported, not everywhere,
   * so another copy elsewhere in the repo can survive. A known limit.
   */
  shortValues: number;
  /**
   * Values where the exact secret could not be read back from the region, so the whole line is
   * the map entry. The same secret on a different line is then not matched unless gitleaks
   * reported it there too.
   */
  lineFallbacks: number;
}

export interface IngestOk {
  status: 'ok';
  tenantId: TenantId;
  caseId: CaseId;
  repo: RepoId;
  /** The pinned commit. Verified: the checked-out HEAD equals it. */
  commit: string;
  /** Workspace that may leave this step: no .env files, every known secret replaced. */
  workspacePath: string;
  detection: Detection;
  /** Contract redactions (never the value). Safe to put in a CaseFile. */
  redactions: Redaction[];
  /**
   * The map itself, with values. Memory only: it serialises to a count and prints as a stub. Use
   * `apply` on any other text that came from the repo before it is stored or shown.
   */
  redactor: SecretRedactor;
  excluded: ExcludedFile[];
  scan: IngestScan;
}

export type IngestResult = IngestOk | IngestUnsupported;

export interface IngestRequest {
  tenantId: TenantId;
  caseId: CaseId;
  repo: RepoId;
  /** `https://` clone URL (no credentials in it), or a local path / file URL if allowLocalSource. */
  source: string;
  /** Full 40 character lowercase hash. Branch names, tags and short hashes are refused. */
  commit: string;
}

export interface IngestDeps {
  /** The only way a scanner runs. Same jail as every tool run. */
  runner: ToolRunnerPort;
  /**
   * Existing directory that holds per-case directories. `<workRoot>/<caseId>` must not exist; it
   * is created here, and only paths created here are ever removed.
   */
  workRoot: string;
  manifest?: ToolManifest | undefined;
  tools?:
    | {
        /** Host path of our gitleaks config directory. Defaults to docker/tools/config. */
        configDir?: string | undefined;
        gitleaksConfigFile?: string | undefined;
        maxWindowBytes?: number | undefined;
        maxReportBytes?: number | undefined;
      }
    | undefined;
  /** Ports a source URL may use. Default [443]. */
  allowedPorts?: readonly number[] | undefined;
  /** Resolves host names for the SSRF check. Defaults to the system resolver. */
  resolveHost?: HostResolver | undefined;
  /** Pass HTTPS_PROXY and friends to git. Off by default: a proxy bypasses the address pin. */
  passProxyEnv?: boolean | undefined;
  /** Cap on fetched objects and on the checked-out tree, in bytes. Default 1 GiB. */
  maxRepoBytes?: number | undefined;
  /** Cap on the number of files in the commit tree. Default 200,000. */
  maxRepoFiles?: number | undefined;
  /** Returns the text of `git version`. Tests stub it. */
  gitVersionProbe?: (() => Promise<string>) | undefined;
  /** Tests and the CLI's local mode only. Off by default: the API accepts https URLs only. */
  allowLocalSource?: boolean | undefined;
  /** Path of the git executable. Defaults to `git` on PATH. */
  gitExecutable?: string | undefined;
  /** Per git command. Default 5 minutes. */
  gitTimeoutMs?: number | undefined;
  /** Files above this are left out of the workspace (reason too-large). Default 64 MiB. */
  maxFileBytes?: number | undefined;
}

export class IngestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestInputError';
  }
}

/** git could not produce the pinned commit (network, missing commit, refused protocol). */
export class CloneFailedError extends Error {
  readonly step: string;
  readonly timedOut: boolean;
  constructor(step: string, why: string, timedOut = false) {
    super(`git ${step} failed: ${why}`);
    this.name = 'CloneFailedError';
    this.step = step;
    this.timedOut = timedOut;
  }
}

/** The case directory could not be removed after a failure. It may hold a raw checkout. */
export class CleanupFailedError extends Error {
  constructor(
    readonly dir: string,
    cause?: unknown,
  ) {
    super(`could not remove ${dir}; remove it by hand, it may hold an unredacted checkout`, {
      cause,
    });
    this.name = 'CleanupFailedError';
  }
}

/** https clones need git 2.37 or newer: older git ignores the address pin. */
export class GitTooOldError extends Error {
  constructor(
    readonly found: string,
    readonly required: string,
  ) {
    super(`git ${required} or newer is required for https clones, found: ${found}`);
    this.name = 'GitTooOldError';
  }
}

/** A fetch or checkout grew past the byte cap and was killed. */
export class RepoTooLargeError extends Error {
  constructor(
    readonly phase: 'fetch' | 'refs' | 'tree' | 'checkout',
    readonly limit: number,
    readonly what: 'bytes' | 'files' = 'bytes',
  ) {
    super(`repository exceeds ${limit} ${what} during ${phase}`);
    this.name = 'RepoTooLargeError';
  }
}

/** The checked-out HEAD is not the commit that was pinned. Nothing is ingested. */
export class CommitMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`pinned commit ${expected} but HEAD is ${actual}`);
    this.name = 'CommitMismatchError';
  }
}

/** A gitleaks finding could not be mapped to a value or a file. Fails closed. Never carries values. */
export class RedactionIncompleteError extends Error {
  constructor(readonly unresolved: readonly string[]) {
    super(
      `redaction map is incomplete, ${unresolved.length} gitleaks finding(s) cannot be located in the checkout:${unresolved.slice(0, 5).join(', ')}`,
    );
    this.name = 'RedactionIncompleteError';
  }
}

/** The final check found a known secret in the workspace. The workspace is deleted. */
export class RedactionLeakError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(`a known secret survived redaction in: ${paths.slice(0, 5).join(', ')}`);
    this.name = 'RedactionLeakError';
  }
}
