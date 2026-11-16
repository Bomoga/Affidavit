import { join } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { repoRoot, type ToolManifest, type ToolName } from './manifest.js';

type Mount = Parameters<ToolRunnerPort['run']>[2][number];

export interface ToolRunOptions {
  /**
   * Host path of the scan snapshot: a private copy of the repo, quarantined with
   * quarantineToolControlPaths. Mounted read-only at /src.
   */
  sourceDir: string;
  /** Host path for results. Mounted writable at /out. Use a new directory per run. */
  outputDir: string;
  /**
   * Host path of a scratch dir that is new and empty for this run, never shared between runs or
   * cases. Its `tmp` (and `semgrep-home`) subdirs are mounted writable.
   */
  scratchDir: string;
  /** Host path of OUR Semgrep rules. Mounted read-only at /rules. Required for semgrep. */
  rulesDir?: string | undefined;
  /**
   * Host path of OUR tool configs (gitleaks.toml, osv-scanner.toml). Mounted read-only at
   * /tool-config. Defaults to docker/tools/config in this repo.
   */
  configDir?: string | undefined;
  /** gitleaks config file name inside configDir. Plain name only. Defaults to gitleaks.toml. */
  gitleaksConfigFile?: string | undefined;
  /** Host path of a vendored OSV database laid out as <dir>/<ecosystem>/all.zip. Mounted read-only. */
  osvDatabaseDir?: string | undefined;
}

export interface ToolInvocation {
  /** Pass to ToolRunnerPort.run as the image. Always image@sha256:... */
  image: string;
  /** execFile-style argv, passed to the image entrypoint. Never joined into a shell string. */
  args: string[];
  mounts: Mount[];
  /** File name written under the mounted /out. */
  outputFile: string;
  /** Subdirectories of scratchDir that runTool creates before running. */
  scratchSubdirs: string[];
}

export class ToolDisabledError extends Error {
  constructor(name: string, why: string) {
    super(`tool ${name} is disabled: ${why}`);
    this.name = 'ToolDisabledError';
  }
}

export class ToolOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolOptionError';
  }
}

function joinHost(base: string, sub: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${sub}`;
}

function need(value: string | undefined, label: string): string {
  if (!value) throw new ToolOptionError(`${label} is required`);
  return value;
}

function plainName(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
    throw new ToolOptionError(`${label} must be a plain file name`);
  }
  return value;
}

function baseMounts(o: ToolRunOptions, extra: Mount[]): Mount[] {
  return [
    { hostPath: o.sourceDir, containerPath: '/src', readOnly: true },
    { hostPath: o.outputDir, containerPath: '/out', readOnly: false },
    { hostPath: joinHost(o.scratchDir, 'tmp'), containerPath: '/tmp', readOnly: false },
    ...extra,
  ];
}

function configMount(o: ToolRunOptions): Mount {
  const hostPath = o.configDir ?? join(repoRoot(), 'docker', 'tools', 'config');
  return { hostPath, containerPath: '/tool-config', readOnly: true };
}

/**
 * Builds the image, argv and mounts for one tool run. The result feeds ToolRunnerPort.run directly.
 *
 * Nothing from inside the scanned repo reaches argv: the tools walk /src themselves. Every
 * repo-controlled knob that has an off switch is switched off here (ignore files, inline
 * suppressions, per-repo configs), and our own config is always passed explicitly. What has no
 * flag (git metadata, .gitleaksignore and friends) is removed from the snapshot by
 * quarantineToolControlPaths, which runTool enforces.
 *
 * Network is never needed: the jail denies egress and every tool is invoked in its offline mode.
 */
export function buildInvocation(
  manifest: ToolManifest,
  name: ToolName,
  o: ToolRunOptions,
): ToolInvocation {
  const entry = manifest.tools.find((t) => t.name === name);
  if (!entry) throw new ToolDisabledError(name, 'not in the manifest');
  if (!entry.enabled || entry.reference === null) {
    throw new ToolDisabledError(name, entry.blockedBy ? `blocked by ${entry.blockedBy}` : 'off');
  }
  const image = entry.reference;

  switch (name) {
    case 'semgrep': {
      const rules = need(o.rulesDir, 'rulesDir');
      const outputFile = 'semgrep.sarif';
      return {
        image,
        // The image has no entrypoint, so argv starts with the binary. Only our own rules are used:
        // no registry config, no auto, metrics and version check off.
        // --no-git-ignore: never run git in /src (a hostile .git/config can execute commands) and
        //   ignore .gitignore. --disable-nosem: inline "nosemgrep" cannot hide a finding.
        // --x-ignore-semgrepignore-files: .semgrepignore at any depth is not honored.
        args: [
          'semgrep',
          'scan',
          '--metrics=off',
          '--disable-version-check',
          '--no-rewrite-rule-ids',
          '--no-git-ignore',
          '--disable-nosem',
          '--x-ignore-semgrepignore-files',
          '--config',
          '/rules',
          '--sarif',
          '--output',
          `/out/${outputFile}`,
          '/src',
        ],
        mounts: baseMounts(o, [
          { hostPath: rules, containerPath: '/rules', readOnly: true },
          {
            hostPath: joinHost(o.scratchDir, 'semgrep-home'),
            containerPath: '/root/.semgrep',
            readOnly: false,
          },
        ]),
        outputFile,
        scratchSubdirs: ['tmp', 'semgrep-home'],
      };
    }
    case 'osv-scanner': {
      const db = need(o.osvDatabaseDir, 'osvDatabaseDir');
      const outputFile = 'osv-scanner.json';
      return {
        image,
        // --config: our empty config, so a repo osv-scanner.toml cannot ignore vulnerabilities.
        // --no-ignore: lockfiles hidden by a repo .gitignore are still scanned.
        // JSON output because the normalizer (L1-03) reads OSV JSON.
        args: [
          'scan',
          'source',
          '--offline',
          '--config',
          '/tool-config/osv-scanner.toml',
          '--no-ignore',
          '--format',
          'json',
          '--output-file',
          `/out/${outputFile}`,
          '-r',
          '/src',
        ],
        // osv-scanner looks for its offline database under $TMPDIR/osv-scalibr.
        mounts: baseMounts(o, [
          { hostPath: db, containerPath: '/tmp/osv-scalibr', readOnly: true },
          configMount(o),
        ]),
        outputFile,
        scratchSubdirs: ['tmp'],
      };
    }
    case 'gitleaks': {
      const outputFile = 'gitleaks.sarif';
      const configFile = plainName(o.gitleaksConfigFile ?? 'gitleaks.toml', 'gitleaksConfigFile');
      return {
        image,
        // --config: ours, mandatory, so a repo .gitleaks.toml is never loaded.
        // --gitleaks-ignore-path: points at our config dir, which holds no .gitleaksignore.
        // --ignore-gitleaks-allow: inline "gitleaks:allow" cannot hide a finding.
        // --redact keeps secret values out of the report; --exit-code 0 so findings are not failures.
        args: [
          'dir',
          '/src',
          '--no-banner',
          '--no-color',
          '--redact',
          '--exit-code',
          '0',
          '--config',
          `/tool-config/${configFile}`,
          '--gitleaks-ignore-path',
          '/tool-config',
          '--ignore-gitleaks-allow',
          '--report-format',
          'sarif',
          '--report-path',
          `/out/${outputFile}`,
        ],
        mounts: baseMounts(o, [configMount(o)]),
        outputFile,
        scratchSubdirs: ['tmp'],
      };
    }
    default:
      throw new ToolDisabledError(name, 'no invocation defined');
  }
}
