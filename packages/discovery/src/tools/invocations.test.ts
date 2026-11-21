import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SEMGREP_CANARY,
  SEMGREP_FALLBACK_TMP,
  SEMGREP_NO_TMP_EXIT,
  SEMGREP_TMPDIR_WRAPPER,
  buildInvocation,
  canaryRoot,
} from './invocations.js';
import {
  ToolDisabledError,
  ToolOptionError,
  isOkExit,
  loadToolManifest,
  repoRoot,
  type ToolRunOptions,
} from './index.js';

const DIGEST_REF = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;

const manifest = loadToolManifest();
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const opts: ToolRunOptions = {
  sourceDir: '/work/case 1/src',
  outputDir: '/work/case 1/out',
  scratchDir: '/work/case 1/scratch',
  rulesDir: '/work/rules',
  osvDatabaseDir: '/work/osv-db',
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('tool invocations', () => {
  for (const name of ['semgrep', 'osv-scanner', 'gitleaks'] as const) {
    describe(name, () => {
      const inv = buildInvocation(manifest, name, opts);

      it('runs the pinned digest image with an argv array', () => {
        expect(inv.image).toMatch(DIGEST_REF);
        expect(inv.image).toBe(manifest.tools.find((t) => t.name === name)?.reference);
        expect(Array.isArray(inv.args)).toBe(true);
        for (const a of inv.args) expect(typeof a).toBe('string');
      });

      it('mounts the source read-only and the output writable', () => {
        const src = inv.mounts.find((m) => m.containerPath === '/src');
        const out = inv.mounts.find((m) => m.containerPath === '/out');
        expect(src).toEqual({ hostPath: opts.sourceDir, containerPath: '/src', readOnly: true });
        expect(out).toEqual({ hostPath: opts.outputDir, containerPath: '/out', readOnly: false });
      });

      it('writes SARIF or JSON into the mounted output path, in the manifest format', () => {
        const format = manifest.tools.find((t) => t.name === name)?.outputFormat;
        expect(inv.outputFile.endsWith(`.${format}`)).toBe(true);
        expect(inv.args).toContain(`/out/${inv.outputFile}`);
      });

      it('never mounts the Docker socket, and only scratch and output are writable', () => {
        for (const m of inv.mounts) {
          expect(m.hostPath).not.toMatch(/docker\.sock/);
          expect(m.containerPath).not.toBe('/');
        }
        const writable = inv.mounts.filter((m) => !m.readOnly).map((m) => m.containerPath);
        const scratch = name === 'osv-scanner' ? ['/tmp'] : ['/var/tmp', '/root/.semgrep'];
        for (const p of writable) expect(['/out', ...scratch]).toContain(p);
      });

      it('each writable scratch mount is a scratchSubdir of this run', () => {
        for (const m of inv.mounts.filter((x) => !x.readOnly && x.containerPath !== '/out')) {
          expect(inv.scratchSubdirs.map((s) => join(opts.scratchDir, s))).toContain(m.hostPath);
        }
      });

      it('takes nothing from repo contents: option-like file names change no argv', () => {
        const dir = mkdtempSync(join(tmpdir(), 'affidavit-argv-'));
        tmpDirs.push(dir);
        const empty = buildInvocation(manifest, name, { ...opts, sourceDir: dir });
        for (const hostile of ['--config=evil', '-oops', '--output=evil', 'a b; rm -rf x']) {
          writeFileSync(join(dir, hostile.replace(/[/;]/g, '_')), 'x');
        }
        mkdirSync(join(dir, '--exclude'));
        const populated = buildInvocation(manifest, name, { ...opts, sourceDir: dir });
        expect(populated.args).toEqual(empty.args);
        expect(populated.args.join('\0')).not.toContain('evil');
      });

      it('passes the scan target only as the constant /src', () => {
        const hostile = buildInvocation(manifest, name, { ...opts, sourceDir: '--config=/evil' });
        expect(hostile.args.join('\0')).not.toContain('evil');
        expect(hostile.mounts.find((m) => m.containerPath === '/src')?.hostPath).toBe(
          '--config=/evil',
        );
      });
    });
  }

  it('semgrep uses only our own rules and never registry configs', () => {
    const { args } = buildInvocation(manifest, 'semgrep', opts);
    expect(args.slice(0, 6)).toEqual(['sh', '-c', SEMGREP_TMPDIR_WRAPPER, 'sh', 'semgrep', 'scan']);
    expect(args).toContain('--metrics=off');
    expect(args).toContain('--disable-version-check');
    expect(args).not.toContain('auto');
    expect(args).not.toContain('--config=auto');
    const configValues = args.flatMap((a, i) => (args[i - 1] === '--config' ? [a] : []));
    // Our rules, and the liveness canary's own rule (never part of the production pack).
    expect(configValues).toEqual(['/rules', SEMGREP_CANARY.config]);
    // Targets: the snapshot, then the canary's own file.
    expect(args.slice(-2)).toEqual(['/src', SEMGREP_CANARY.uri]);
    for (const a of args) {
      expect(a).not.toMatch(/^p\//);
      expect(a).not.toMatch(/^r\//);
      expect(a).not.toMatch(/^https?:/);
      expect(a).not.toMatch(/semgrep\.dev/);
    }
  });

  it('semgrep and gitleaks mount nothing at or under /tmp, which the gVisor jail reserves', () => {
    for (const name of ['semgrep', 'gitleaks'] as const) {
      const { mounts } = buildInvocation(manifest, name, opts);
      for (const m of mounts) expect(m.containerPath).not.toMatch(/^\/tmp(\/|$)/);
    }
  });

  it('semgrep keeps a TMPDIR the runner set and falls back to its writable scratch mount', () => {
    // The script is a constant: no argument is spliced into it, they arrive as "$@".
    // It refuses (exit 97) unless the directory exists and is writable.
    expect(SEMGREP_TMPDIR_WRAPPER).toBe(
      `t="\${TMPDIR:-${SEMGREP_FALLBACK_TMP}}"; [ -d "$t" ] && [ -w "$t" ] || exit 97; exec env TMPDIR="$t" "$@"`,
    );
    expect(SEMGREP_NO_TMP_EXIT).toBe(97);
    expect(isOkExit(manifest, 'semgrep', SEMGREP_NO_TMP_EXIT)).toBe(false);
    const { mounts, scratchSubdirs } = buildInvocation(manifest, 'semgrep', opts);
    expect(mounts).toContainEqual({
      hostPath: join(opts.scratchDir, 'tmp'),
      containerPath: SEMGREP_FALLBACK_TMP,
      readOnly: false,
    });
    expect(scratchSubdirs).toEqual(['tmp', 'semgrep-home']);
    expect(buildInvocation(manifest, 'gitleaks', opts).scratchSubdirs).toEqual([]);
  });

  it('semgrep mounts the liveness canary read-only, outside /src and /rules', () => {
    const { mounts } = buildInvocation(manifest, 'semgrep', opts);
    expect(mounts).toContainEqual({
      hostPath: join(canaryRoot(), 'semgrep'),
      containerPath: SEMGREP_CANARY.mount,
      readOnly: true,
    });
    const own = buildInvocation(manifest, 'semgrep', { ...opts, semgrepCanaryDir: '/c' });
    expect(own.mounts).toContainEqual({ hostPath: '/c', containerPath: '/canary', readOnly: true });
    expect(SEMGREP_CANARY.uri.startsWith(`${SEMGREP_CANARY.mount}/`)).toBe(true);
    expect(SEMGREP_CANARY.config.startsWith(`${SEMGREP_CANARY.mount}/`)).toBe(true);
  });

  it('semgrep ignores every repo-controlled switch: git, nosemgrep, semgrepignore', () => {
    const { args } = buildInvocation(manifest, 'semgrep', opts);
    expect(args).toContain('--no-git-ignore');
    expect(args).toContain('--disable-nosem');
    expect(args).toContain('--x-ignore-semgrepignore-files');
  });

  it('semgrep has no size cap but keeps its own per-file timeouts', () => {
    const { args } = buildInvocation(manifest, 'semgrep', opts);
    expect(args).toContain('--max-target-bytes=0');
    expect(args.some((a) => a.startsWith('--timeout'))).toBe(false);
  });

  it('osv-scanner never runs call analysis, which executes repo toolchains and can mark findings uncalled', () => {
    const { args } = buildInvocation(manifest, 'osv-scanner', opts);
    expect(args).toContain('--no-call-analysis=all');
    expect(args.some((a) => a.startsWith('--call-analysis'))).toBe(false);
  });

  it('semgrep mounts our rules read-only and a writable home for its settings', () => {
    const { mounts } = buildInvocation(manifest, 'semgrep', opts);
    expect(mounts).toContainEqual({
      hostPath: '/work/rules',
      containerPath: '/rules',
      readOnly: true,
    });
    expect(mounts.some((m) => m.containerPath === '/root/.semgrep' && !m.readOnly)).toBe(true);
  });

  it('semgrep requires a rules directory', () => {
    expect(() => buildInvocation(manifest, 'semgrep', { ...opts, rulesDir: undefined })).toThrow(
      ToolOptionError,
    );
  });

  it('osv-scanner runs offline against a mounted read-only database and emits JSON', () => {
    const { args, mounts, outputFile } = buildInvocation(manifest, 'osv-scanner', opts);
    expect(args).toContain('--offline');
    expect(flagValue(args, '--format')).toBe('json');
    expect(outputFile).toBe('osv-scanner.json');
    expect(mounts).toContainEqual({
      hostPath: '/work/osv-db',
      containerPath: '/tmp/osv-scalibr',
      readOnly: true,
    });
    expect(() =>
      buildInvocation(manifest, 'osv-scanner', { ...opts, osvDatabaseDir: undefined }),
    ).toThrow(ToolOptionError);
  });

  it('osv-scanner always uses our config and scans gitignored lockfiles', () => {
    const { args, mounts } = buildInvocation(manifest, 'osv-scanner', opts);
    expect(flagValue(args, '--config')).toBe('/tool-config/osv-scanner.toml');
    expect(args).toContain('--no-ignore');
    expect(mounts.find((m) => m.containerPath === '/tool-config')?.readOnly).toBe(true);
  });

  it('gitleaks always uses our config, ignores repo allow markers, and redacts', () => {
    const { args, mounts } = buildInvocation(manifest, 'gitleaks', opts);
    expect(args[0]).toBe('dir');
    expect(flagValue(args, '--config')).toBe('/tool-config/gitleaks.toml');
    expect(args).toContain('--ignore-gitleaks-allow');
    expect(flagValue(args, '--gitleaks-ignore-path')).toBe('/tool-config');
    expect(args).toContain('--redact');
    expect(flagValue(args, '--exit-code')).toBe('0');
    expect(flagValue(args, '--max-archive-depth')).toBe('3');
    expect(mounts.find((m) => m.containerPath === '/tool-config')?.readOnly).toBe(true);
  });

  it('gitleaks accepts only a plain file name for its config', () => {
    const ok = buildInvocation(manifest, 'gitleaks', { ...opts, gitleaksConfigFile: 'x.toml' });
    expect(ok.args).toContain('/tool-config/x.toml');
    for (const bad of ['../x.toml', 'a/b.toml', '/etc/passwd', '--config', '']) {
      expect(() =>
        buildInvocation(manifest, 'gitleaks', { ...opts, gitleaksConfigFile: bad }),
      ).toThrow(ToolOptionError);
    }
  });

  it('ships our own configs: vendored gitleaks rules without the global allowlist, osv ignores nothing', () => {
    const dir = join(repoRoot(), 'docker', 'tools', 'config');
    const gl = readFileSync(join(dir, 'gitleaks.toml'), 'utf8');
    expect(gl).toMatch(/^title = "gitleaks config"/m);
    expect(gl.match(/^\[\[rules\]\]/gm)?.length).toBeGreaterThan(200);
    expect(gl).toContain('id = "generic-api-key"');
    // The upstream global allowlist skips node_modules, lockfiles, vendor dirs and more.
    expect(gl).not.toMatch(/^\[allowlist\]/m);
    expect(gl).not.toMatch(/^\[\[allowlists\]\]/m);
    expect(gl).not.toMatch(/node_modules/);
    expect(gl).not.toMatch(/useDefault/);
    expect(readdirSync(dir).sort()).toEqual(['gitleaks.toml', 'osv-scanner.toml']);
    expect(readFileSync(join(dir, 'osv-scanner.toml'), 'utf8')).not.toMatch(/^\s*\[/m);
  });

  it('refuses to build a CodeQL invocation', () => {
    expect(() => buildInvocation(manifest, 'codeql', opts)).toThrow(ToolDisabledError);
  });

  it('classifies exit codes per tool', () => {
    expect(isOkExit(manifest, 'semgrep', 0)).toBe(true);
    expect(isOkExit(manifest, 'semgrep', 2)).toBe(false);
    expect(isOkExit(manifest, 'osv-scanner', 1)).toBe(true);
    expect(isOkExit(manifest, 'osv-scanner', 127)).toBe(false);
    expect(isOkExit(manifest, 'gitleaks', 1)).toBe(false);
  });
});
