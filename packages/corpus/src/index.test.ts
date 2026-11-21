import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CommitSha, Sha256, BootHints, TargetRef } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { corpus, getApp, patchPath, validateCorpus } from './index.js';

const nodegoat = getApp('nodegoat');

describe('@affidavit/corpus index', () => {
  it('lists NodeGoat with a pinned commit, tree and archive checksum', () => {
    expect(corpus.apps.map((a) => a.id)).toContain('nodegoat');
    expect(CommitSha.safeParse(nodegoat.pin.commit).success).toBe(true);
    expect(CommitSha.safeParse(nodegoat.pin.tree).success).toBe(true);
    expect(Sha256.safeParse(nodegoat.pin.archiveSha256).success).toBe(true);
    expect(nodegoat.pin.repoUrl.startsWith('https://')).toBe(true);
  });

  it('gives every app, safe variant and negative control a license note', () => {
    for (const app of corpus.apps) {
      expect(app.license.spdx.length).toBeGreaterThan(0);
      expect(app.license.file.length).toBeGreaterThan(0);
      expect(app.license.note.length).toBeGreaterThan(20);
      for (const v of app.safeVariants) expect(v.license).toEqual(app.license);
      for (const n of app.negativeControls) expect(n.license).toEqual(app.license);
    }
    expect(nodegoat.license.spdx).toBe('Apache-2.0');
  });

  it('parses every boot hint with the contracts schema', () => {
    for (const app of corpus.apps) {
      const all = [
        app.bootHints,
        ...app.safeVariants.map((v) => v.bootHints),
        ...app.negativeControls.map((n) => n.bootHints),
      ];
      for (const hints of all) expect(BootHints.safeParse(hints).success).toBe(true);
    }
  });

  it('labels the gate issue truthfully as injection with a real range', () => {
    const gate = nodegoat.labels.find((l) => l.id === 'nodegoat-nosqli-allocations-where');
    expect(gate?.cls).toBe('injection');
    expect(gate?.file).toBe('app/data/allocations-dao.js');
    expect(gate?.route).toMatchObject({ method: 'GET', path: '/allocations/:userId' });
  });

  it('has labels for both vulnerability classes with ordered line ranges', () => {
    expect(new Set(nodegoat.labels.map((l) => l.cls))).toEqual(new Set(['injection', 'idor']));
    for (const l of nodegoat.labels) {
      expect(l.range.startLine).toBeGreaterThanOrEqual(1);
      expect(l.range.endLine).toBeGreaterThanOrEqual(l.range.startLine);
      expect(l.file).not.toMatch(/^\/|\.\./);
    }
  });

  it('ties every safe variant to a label and a patch with a matching checksum', () => {
    expect(nodegoat.safeVariants.length).toBeGreaterThanOrEqual(1);
    for (const v of nodegoat.safeVariants) {
      expect(nodegoat.labels.some((l) => l.id === v.fixes)).toBe(true);
      expect(TargetRef.safeParse(v.target).success).toBe(true);
      expect(v.target.variant).toBe('safe');
      expect(v.target.commit).toBe(nodegoat.pin.commit);
      expect(v.patches.length).toBeGreaterThan(0);
      for (const p of v.patches) {
        const bytes = readFileSync(patchPath(nodegoat, p.id));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(p.sha256);
      }
    }
  });

  it('has a negative control that explains why it is not exploitable', () => {
    expect(nodegoat.negativeControls.length).toBeGreaterThanOrEqual(1);
    for (const n of nodegoat.negativeControls) {
      expect(n.whyNotExploitable.length).toBeGreaterThan(40);
      expect(n.expectedRuleIds.length).toBeGreaterThan(0);
      for (const p of n.patches) {
        const bytes = readFileSync(patchPath(nodegoat, p.id));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(p.sha256);
      }
    }
  });

  it('keeps label ids unique and rejects a corrupted index', () => {
    const ids = nodegoat.labels.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => validateCorpus(corpus)).not.toThrow();
    const broken = structuredClone(corpus);
    broken.apps[0]!.safeVariants[0]!.fixes = 'no-such-label';
    expect(() => validateCorpus(broken)).toThrow(/no-such-label/);
    const badSum = structuredClone(corpus);
    badSum.apps[0]!.pin.archiveSha256 = 'xyz';
    expect(() => validateCorpus(badSum)).toThrow();
  });

  it('labels log injection and records out-of-scope upstream issues', () => {
    const l = nodegoat.labels.find((x) => x.id === 'nodegoat-loginj-login-username');
    expect(l).toMatchObject({ cls: 'injection', cwe: 'CWE-117', file: 'app/routes/session.js' });
    expect(nodegoat.outOfScope.length).toBeGreaterThan(0);
  });

  it('tags the negative control so it cannot be mistaken for the safe variant', () => {
    for (const n of nodegoat.negativeControls) {
      expect(n.role).toBe('negative-control');
      expect(n.base.variant).toBe('vulnerable');
      expect('target' in n).toBe(false);
    }
  });

  it('runtime-validates labels, license notes on controls and patch containment', () => {
    const badLabel = structuredClone(corpus);
    badLabel.apps[0]!.labels[0]!.cwe = 'nope';
    expect(() => validateCorpus(badLabel)).toThrow(/cwe/i);
    const badRoute = structuredClone(corpus);
    // @ts-expect-error deliberately malformed
    badRoute.apps[0]!.labels[0]!.route = { method: 'GET' };
    expect(() => validateCorpus(badRoute)).toThrow();
    const badRule = structuredClone(corpus);
    badRule.apps[0]!.negativeControls[0]!.expectedRuleIds = [];
    expect(() => validateCorpus(badRule)).toThrow(/expectedRuleIds/);
    const badLicense = structuredClone(corpus);
    badLicense.apps[0]!.negativeControls[0]!.license.note = '';
    expect(() => validateCorpus(badLicense)).toThrow(/license|note/i);
    const escaping = structuredClone(nodegoat);
    escaping.safeVariants[0]!.patches[0]!.path = '../../../outside.patch';
    expect(() => patchPath(escaping, escaping.safeVariants[0]!.patches[0]!.id)).toThrow(/escapes/);
  });

  it('writes no em dashes in user-facing copy', () => {
    const text = JSON.stringify(corpus);
    expect(text.includes('—')).toBe(false);
  });
});
