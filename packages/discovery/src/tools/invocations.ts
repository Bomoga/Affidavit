import type { ToolRunnerPort } from '@affidavit/contracts';
import type { ToolManifest, ToolName } from './manifest.js';

type Mount = Parameters<ToolRunnerPort['run']>[2][number];

export interface ToolRunOptions {
  /** Host path of the source snapshot. Mounted read-only at /src. */
  sourceDir: string;
  /** Host path for results. Mounted writable at /out. */
  outputDir: string;
  /** Host path of a throwaway scratch dir. Its `tmp` (and `semgrep-home`) subdirs are mounted writable. */
  scratchDir: string;
  /** Host path of our own rules (Semgrep rules, or a gitleaks config). Mounted read-only at /rules. */
  rulesDir?: string | undefined;
  /** File name inside rulesDir for gitleaks, optional. A plain name, never a path. */
  gitleaksConfigFile?: string | undefined;
  /** Host path of a vendored OSV database laid out as <dir>/<ecosystem>/all.zip. Mounted read-only. */
  osvDatabaseDir?: string | undefined;
  /** Reserved. CodeQL stays disabled whatever this says until it has a recorded digest. */
  enableFlag?: boolean | undefined;
}

export interface ToolInvocation {
  /** Pass to ToolRunnerPort.run as the image. Always image@sha256:... */
  image: string;
  /** execFile-style argv, passed to the image entrypoint. Never joined into a shell string. */
  args: string[];
  mounts: Mount[];
  /** File name written under the mounted /out. */
  outputFile: string;
  /** Subdirectories of scratchDir the caller must create before running. */
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

function baseMounts(o: ToolRunOptions, extra: Mount[]): Mount[] {
  return [
    { hostPath: o.sourceDir, containerPath: '/src', readOnly: true },
    { hostPath: o.outputDir, containerPath: '/out', readOnly: false },
    { hostPath: joinHost(o.scratchDir, 'tmp'), containerPath: '/tmp', readOnly: false },
    ...extra,
  ];
}

/**
 * Builds the image, argv and mounts for one tool run. The result feeds ToolRunnerPort.run directly.
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
        args: [
          'semgrep',
          'scan',
          '--metrics=off',
          '--disable-version-check',
          '--no-rewrite-rule-ids',
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
      const outputFile = 'osv-scanner.sarif';
      return {
        image,
        args: [
          'scan',
          'source',
          '--offline',
          '--format',
          'sarif',
          '--output-file',
          `/out/${outputFile}`,
          '-r',
          '/src',
        ],
        // osv-scanner looks for its offline database under $TMPDIR/osv-scalibr.
        mounts: baseMounts(o, [
          { hostPath: db, containerPath: '/tmp/osv-scalibr', readOnly: true },
        ]),
        outputFile,
        scratchSubdirs: ['tmp'],
      };
    }
    case 'gitleaks': {
      const outputFile = 'gitleaks.sarif';
      const config: string[] = [];
      const extra: Mount[] = [];
      if (o.gitleaksConfigFile !== undefined) {
        const f = o.gitleaksConfigFile;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f) || f.includes('..')) {
          throw new ToolOptionError('gitleaksConfigFile must be a plain file name');
        }
        config.push('--config', `/rules/${f}`);
        extra.push({
          hostPath: need(o.rulesDir, 'rulesDir'),
          containerPath: '/rules',
          readOnly: true,
        });
      }
      return {
        image,
        // --redact keeps secret values out of the report; --exit-code 0 so findings are not failures.
        args: [
          'dir',
          '/src',
          '--no-banner',
          '--no-color',
          '--redact',
          '--exit-code',
          '0',
          ...config,
          '--report-format',
          'sarif',
          '--report-path',
          `/out/${outputFile}`,
        ],
        mounts: baseMounts(o, extra),
        outputFile,
        scratchSubdirs: ['tmp'],
      };
    }
    default:
      throw new ToolDisabledError(name, 'no invocation defined');
  }
}
