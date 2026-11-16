import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetchPinned } from '../scripts/fetch-pinned.mjs';
import { getApp, patchPath } from './index.js';
import type { PatchRef } from './index.js';

/**
 * Needs the network and git. Skipped in plain `pnpm test`; run with `pnpm test:network`
 * (sets AFFIDAVIT_CORPUS_NETWORK=1).
 */
const enabled = process.env['AFFIDAVIT_CORPUS_NETWORK'] === '1';
const nodegoat = getApp('nodegoat');
const root = enabled ? mkdtempSync(join(tmpdir(), 'corpus-net-')) : '';

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const lines = (dir: string, file: string): string[] =>
  readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').split('\n');

const fetchNodegoat = (dest: string, patches: PatchRef[] = []): Promise<void> =>
  fetchPinned({
    repoUrl: nodegoat.pin.repoUrl,
    commit: nodegoat.pin.commit,
    tree: nodegoat.pin.tree,
    archiveSha256: nodegoat.pin.archiveSha256,
    dest,
    patches: patches.map((p) => ({ path: patchPath(nodegoat, p.id), sha256: p.sha256 })),
  });

describe.skipIf(!enabled)('NodeGoat at the pinned commit (network)', { timeout: 180_000 }, () => {
  const base = join(root, 'base');

  const text = (dir: string, file: string, r: { startLine: number; endLine: number }): string =>
    lines(dir, file)
      .slice(r.startLine - 1, r.endLine)
      .join('\n');

  it('fetches, verifies, and every label points at the code it claims', async () => {
    await fetchNodegoat(base);
    expect(readFileSync(join(base, 'LICENSE'), 'utf8')).toMatch(/Apache License/);
    for (const l of nodegoat.labels) {
      expect(l.range.endLine).toBeLessThanOrEqual(lines(base, l.file).length);
    }
    const label = (id: string) => nodegoat.labels.find((l) => l.id === id)!;

    const gate = label('nodegoat-nosqli-allocations-where');
    const gateText = text(base, gate.file, gate.range);
    expect(gateText).toContain('$where');
    expect(gateText).toContain('${threshold}');
    expect(text(base, gate.source.file, gate.source.range)).toContain('threshold');

    const ev = label('nodegoat-ssjs-contributions-eval');
    expect(text(base, ev.file, ev.range)).toContain('eval(req.body.preTax)');

    const logInj = label('nodegoat-loginj-login-username');
    expect(text(base, logInj.file, logInj.range)).toMatch(/console\.log\(.*userName/);

    const idor = label('nodegoat-idor-allocations-userid');
    const idorText = text(base, idor.file, idor.range);
    expect(idorText).toContain('userId');
    expect(idorText).toContain('req.params');
    expect(idorText).not.toContain('req.session');

    const benefits = label('nodegoat-idor-benefits-userid');
    const benefitsText = text(base, benefits.file, benefits.range);
    expect(benefitsText).toContain('req.body');
    expect(benefitsText).toContain('userId');
    expect(benefitsText).toContain('updateBenefits');
  });

  it('refuses a wrong tree hash on the real repository', async () => {
    const dest = join(root, 'wrong-tree');
    await expect(
      fetchPinned({
        repoUrl: nodegoat.pin.repoUrl,
        commit: nodegoat.pin.commit,
        tree: '1'.repeat(40),
        archiveSha256: nodegoat.pin.archiveSha256,
        dest,
      }),
    ).rejects.toThrow(/tree mismatch/);
    expect(existsSync(dest)).toBe(false);
  });

  it('applies the safe patch and removes the quoted interpolation', async () => {
    const safe = join(root, 'safe');
    await fetchNodegoat(safe, nodegoat.safeVariants[0]!.patches);
    const src = readFileSync(join(safe, 'app/data/allocations-dao.js'), 'utf8');
    expect(src).not.toContain("'${threshold}'");
    expect(src).toContain('parseInt(threshold, 10)');
  });

  it('applies the negative control on top of the safe variant at its labeled range', async () => {
    const nc = join(root, 'nc');
    const n = nodegoat.negativeControls[0]!;
    await fetchNodegoat(nc, n.patches);
    const t = text(nc, n.file, n.range);
    expect(t).toContain('countHighStockAllocations');
    expect(t).toContain('${HIGH_STOCK_PERCENT}');
  });
});
