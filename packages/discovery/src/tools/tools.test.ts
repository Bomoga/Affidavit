import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BundleManifest } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import {
  ToolDisabledError,
  ToolOptionError,
  buildInvocation,
  enabledToolNames,
  isOkExit,
  loadToolManifest,
  parseToolManifest,
  repoRoot,
  toolImageRefs,
  toolVersions,
  type ToolRunOptions,
} from './index.js';

const DIGEST_REF = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;

const manifest = loadToolManifest();

const opts: ToolRunOptions = {
  sourceDir: '/work/case 1/src',
  outputDir: '/work/case 1/out',
  scratchDir: '/work/case 1/scratch',
  rulesDir: '/work/rules',
  osvDatabaseDir: '/work/osv-db',
};

function allDockerfiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) found.push(...allDockerfiles(p));
    else if (entry === 'Dockerfile' || entry.startsWith('Dockerfile.')) found.push(p);
  }
  return found;
}

describe('tool manifest', () => {
  it('records the four tools', () => {
    expect(manifest.tools.map((t) => t.name).sort()).toEqual([
      'codeql',
      'gitleaks',
      'osv-scanner',
      'semgrep',
    ]);
  });

  it('references every enabled tool by digest, never by tag alone', () => {
    const names = enabledToolNames(manifest);
    expect(names.sort()).toEqual(['gitleaks', 'osv-scanner', 'semgrep']);
    for (const t of manifest.tools.filter((x) => x.enabled)) {
      expect(t.reference).toMatch(DIGEST_REF);
      expect(t.reference).toBe(`${t.image}@${t.digest}`);
      expect(t.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('records a version, how it was resolved, and when, for every enabled tool', () => {
    for (const t of manifest.tools.filter((x) => x.enabled)) {
      expect(t.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(t.resolvedVia.length).toBeGreaterThan(10);
      expect(t.resolvedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.okExitCodes).toContain(0);
    }
  });

  it('keeps CodeQL disabled by default, with no image reference', () => {
    const codeql = manifest.tools.find((t) => t.name === 'codeql');
    expect(codeql?.enabled).toBe(false);
    expect(codeql?.reference).toBeNull();
    expect(codeql?.enableFlag).toBe('AFFIDAVIT_ENABLE_CODEQL');
    expect(codeql?.blockedBy).toBe('P0-10');
    expect(enabledToolNames(manifest)).not.toContain('codeql');
  });

  it('pins every Dockerfile base image by digest', () => {
    const files = allDockerfiles(join(repoRoot(), 'docker', 'tools'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const froms = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /^\s*FROM\s/i.test(l));
      expect(froms.length).toBeGreaterThan(0);
      for (const line of froms) expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
    }
  });

  it('uses the same OSV-Scanner digest as the CI dogfooding job', () => {
    const ci = readFileSync(join(repoRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const osv = manifest.tools.find((t) => t.name === 'osv-scanner');
    expect(ci).toContain(osv?.reference ?? 'missing');
  });

  it('rejects a tag-only or tag-plus-digest reference', () => {
    const raw = JSON.parse(
      readFileSync(join(repoRoot(), 'docker', 'tools', 'tools.json'), 'utf8'),
    ) as {
      tools: { name: string; reference: string }[];
    };
    const mutate = (reference: string) => {
      const copy = structuredClone(raw);
      const semgrep = copy.tools.find((t) => t.name === 'semgrep');
      if (semgrep) semgrep.reference = reference;
      return () => parseToolManifest(copy);
    };
    expect(mutate('docker.io/semgrep/semgrep:latest')).toThrow();
    expect(mutate('docker.io/semgrep/semgrep:1.184.0@sha256:' + 'a'.repeat(64))).toThrow();
    expect(mutate('docker.io/semgrep/semgrep@sha256:abc')).toThrow();
  });

  it('rejects an enabled CodeQL entry that has no digest', () => {
    const raw = JSON.parse(
      readFileSync(join(repoRoot(), 'docker', 'tools', 'tools.json'), 'utf8'),
    ) as {
      tools: { name: string; enabled: boolean }[];
    };
    const copy = structuredClone(raw);
    const codeql = copy.tools.find((t) => t.name === 'codeql');
    if (codeql) codeql.enabled = true;
    expect(() => parseToolManifest(copy)).toThrow();
  });
});

describe('BundleManifest.toolVersions', () => {
  it('maps enabled tools to their recorded version and fits the contract', () => {
    const versions = toolVersions(manifest);
    expect(Object.keys(versions).sort()).toEqual(['gitleaks', 'osv-scanner', 'semgrep']);
    expect(versions['codeql']).toBeUndefined();
    const parsed = BundleManifest.shape.toolVersions.safeParse(versions);
    expect(parsed.success).toBe(true);
  });

  it('exposes the digest-pinned reference for each enabled tool', () => {
    const refs = toolImageRefs(manifest);
    for (const ref of Object.values(refs)) expect(ref).toMatch(DIGEST_REF);
  });
});

describe('tool invocations', () => {
  for (const name of ['semgrep', 'osv-scanner', 'gitleaks'] as const) {
    describe(name, () => {
      const inv = buildInvocation(manifest, name, {
        ...opts,
        gitleaksConfigFile: name === 'gitleaks' ? 'rules.toml' : undefined,
      });

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

      it('writes SARIF or JSON into the mounted output path', () => {
        expect(inv.outputFile).toMatch(/\.(sarif|json)$/);
        expect(inv.args).toContain(`/out/${inv.outputFile}`);
      });

      it('never mounts the Docker socket or a host path as a container root', () => {
        for (const m of inv.mounts) {
          expect(m.hostPath).not.toMatch(/docker\.sock/);
          expect(m.containerPath).not.toBe('/');
        }
        const writable = inv.mounts.filter((m) => !m.readOnly).map((m) => m.containerPath);
        for (const p of writable) expect(['/out', '/tmp', '/root/.semgrep']).toContain(p);
      });

      it('keeps hostile path characters inside a single mount, out of argv', () => {
        const hostile = buildInvocation(manifest, name, {
          ...opts,
          sourceDir: '/work/a b; rm -rf /',
          gitleaksConfigFile: name === 'gitleaks' ? 'rules.toml' : undefined,
        });
        expect(hostile.args.join('\0')).not.toContain('rm -rf');
        expect(hostile.mounts.find((m) => m.containerPath === '/src')?.hostPath).toBe(
          '/work/a b; rm -rf /',
        );
      });
    });
  }

  it('semgrep uses only our own rules and never registry configs', () => {
    const { args } = buildInvocation(manifest, 'semgrep', opts);
    expect(args[0]).toBe('semgrep');
    expect(args).toContain('--metrics=off');
    expect(args).toContain('--disable-version-check');
    expect(args).not.toContain('auto');
    expect(args).not.toContain('--config=auto');
    const configValues = args.flatMap((a, i) => (args[i - 1] === '--config' ? [a] : []));
    expect(configValues).toEqual(['/rules']);
    for (const a of args) {
      expect(a).not.toMatch(/^p\//);
      expect(a).not.toMatch(/^r\//);
      expect(a).not.toMatch(/^https?:/);
      expect(a).not.toMatch(/semgrep\.dev/);
    }
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

  it('osv-scanner runs offline against a mounted read-only database', () => {
    const { args, mounts } = buildInvocation(manifest, 'osv-scanner', opts);
    expect(args).toContain('--offline');
    expect(args).toContain('--format');
    expect(args).toContain('sarif');
    expect(mounts).toContainEqual({
      hostPath: '/work/osv-db',
      containerPath: '/tmp/osv-scalibr',
      readOnly: true,
    });
    expect(() =>
      buildInvocation(manifest, 'osv-scanner', { ...opts, osvDatabaseDir: undefined }),
    ).toThrow(ToolOptionError);
  });

  it('gitleaks redacts secrets in its report and treats findings as a normal exit', () => {
    const { args } = buildInvocation(manifest, 'gitleaks', opts);
    expect(args[0]).toBe('dir');
    expect(args).toContain('--redact');
    expect(args).toContain('--exit-code');
    expect(args[args.indexOf('--exit-code') + 1]).toBe('0');
  });

  it('gitleaks accepts only a plain file name for its config', () => {
    const ok = buildInvocation(manifest, 'gitleaks', { ...opts, gitleaksConfigFile: 'x.toml' });
    expect(ok.args).toContain('/rules/x.toml');
    for (const bad of ['../x.toml', 'a/b.toml', '/etc/passwd', '--config', '']) {
      expect(() =>
        buildInvocation(manifest, 'gitleaks', { ...opts, gitleaksConfigFile: bad }),
      ).toThrow(ToolOptionError);
    }
  });

  it('refuses to build a CodeQL invocation, even when the flag is set', () => {
    expect(() => buildInvocation(manifest, 'codeql', opts)).toThrow(ToolDisabledError);
    expect(() => buildInvocation(manifest, 'codeql', { ...opts, enableFlag: true })).toThrow(
      ToolDisabledError,
    );
  });

  it('classifies exit codes per tool', () => {
    expect(isOkExit(manifest, 'semgrep', 0)).toBe(true);
    expect(isOkExit(manifest, 'semgrep', 2)).toBe(false);
    expect(isOkExit(manifest, 'osv-scanner', 1)).toBe(true);
    expect(isOkExit(manifest, 'osv-scanner', 127)).toBe(false);
    expect(isOkExit(manifest, 'gitleaks', 1)).toBe(false);
  });
});
