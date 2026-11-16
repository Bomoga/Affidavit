import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyPatches, fetchPinned } from '../scripts/fetch-pinned.mjs';
import { getApp, patchPath } from './index.js';

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

describe.skipIf(!enabled)('NodeGoat at the pinned commit (network)', { timeout: 180_000 }, () => {
  const base = join(root, 'base');

  it('fetches, verifies the checksum, and every label range matches real code', async () => {
    await fetchPinned({
      repoUrl: nodegoat.pin.repoUrl,
      commit: nodegoat.pin.commit,
      archiveSha256: nodegoat.pin.archiveSha256,
      dest: base,
    });
    expect(existsSync(join(base, 'LICENSE'))).toBe(true);
    expect(readFileSync(join(base, 'LICENSE'), 'utf8')).toMatch(/Apache License/);
    for (const l of nodegoat.labels) {
      const src = lines(base, l.file);
      expect(l.range.endLine).toBeLessThanOrEqual(src.length);
    }
    const gate = nodegoat.labels.find((l) => l.id === 'nodegoat-nosqli-allocations-where')!;
    const gateText = lines(base, gate.file)
      .slice(gate.range.startLine - 1, gate.range.endLine)
      .join('\n');
    expect(gateText).toContain('$where');
    expect(gateText).toContain('${threshold}');
    const ev = nodegoat.labels.find((l) => l.id === 'nodegoat-ssjs-contributions-eval')!;
    expect(
      lines(base, ev.file)
        .slice(ev.range.startLine - 1, ev.range.endLine)
        .join('\n'),
    ).toContain('eval(req.body.preTax)');
  });

  it('applies the safe patch and removes the quoted interpolation', async () => {
    const safe = join(root, 'safe');
    await fetchPinned({
      repoUrl: nodegoat.pin.repoUrl,
      commit: nodegoat.pin.commit,
      archiveSha256: nodegoat.pin.archiveSha256,
      dest: safe,
    });
    const v = nodegoat.safeVariants[0]!;
    await applyPatches({
      dir: safe,
      patches: v.patches.map((p) => ({ path: patchPath(nodegoat, p.id), sha256: p.sha256 })),
    });
    const text = readFileSync(join(safe, 'app/data/allocations-dao.js'), 'utf8');
    expect(text).not.toContain("'${threshold}'");
    expect(text).toContain('parseInt(threshold, 10)');
  });

  it('applies the negative control on top of the safe variant at its labeled range', async () => {
    const nc = join(root, 'nc');
    await fetchPinned({
      repoUrl: nodegoat.pin.repoUrl,
      commit: nodegoat.pin.commit,
      archiveSha256: nodegoat.pin.archiveSha256,
      dest: nc,
    });
    const n = nodegoat.negativeControls[0]!;
    await applyPatches({
      dir: nc,
      patches: n.patches.map((p) => ({ path: patchPath(nodegoat, p.id), sha256: p.sha256 })),
    });
    const text = lines(nc, n.file)
      .slice(n.range.startLine - 1, n.range.endLine)
      .join('\n');
    expect(text).toContain('countHighStockAllocations');
    expect(text).toContain('${HIGH_STOCK_PERCENT}');
  });
});
