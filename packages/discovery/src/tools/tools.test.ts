import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BundleManifest } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import {
  enabledToolNames,
  loadToolManifest,
  parseToolManifest,
  repoRoot,
  toolImageRefs,
  toolVersions,
} from './index.js';

const DIGEST_REF = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;

const manifest = loadToolManifest();

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
