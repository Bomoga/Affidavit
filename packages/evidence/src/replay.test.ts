import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBundle } from './bundle.js';
import { REPLAY_EXIT, renderReport, replay, replayBundle } from './replay.js';
import { readTar, writeTar } from './tar.js';
import {
  SAFE_DIGEST,
  ScriptedJudge,
  VULN_DIGEST,
  bundleInput,
  caseFile,
  counterResult,
  verifyResult,
  witnessResult,
} from './test-helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'affidavit-replay-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function tamperWitness(bytes: Uint8Array): Promise<Uint8Array> {
  const files = await readTar(bytes);
  const w = new Uint8Array(files.get('exhibits/exhibit-witness-001.json')!);
  w[5] = (w[5] ?? 0) ^ 1;
  files.set('exhibits/exhibit-witness-001.json', w);
  return writeTar([...files].map(([name, b]) => ({ name, bytes: b })));
}

describe('replay', () => {
  it('reruns every exhibit and matches the recorded outcomes', async () => {
    const { bytes, sha256 } = await buildBundle(bundleInput());
    const judge = new ScriptedJudge();
    const report = await replay(bytes, { judge, expectedSha256: sha256 });
    expect(report.ok).toBe(true);
    expect('exhibits' in report && report.exhibits.map((e) => [e.exhibitId, e.status])).toEqual([
      ['exhibit-witness-001', 'match'],
      ['exhibit-counter-001', 'match'],
      ['exhibit-patch-001', 'match'],
    ]);
    expect(judge.calls.map((c) => c.method)).toEqual([
      'runWitness',
      'runCounterexample',
      'verifyPatch',
    ]);
  });

  it('hands the Judge the case file pinned to the manifest digests and the stored submissions', async () => {
    // The case file inside the bundle has the digests too; the manifest is what replay trusts.
    const { bytes } = await buildBundle(bundleInput());
    const judge = new ScriptedJudge();
    await replay(bytes, { judge });
    for (const call of judge.calls) {
      expect(call.caseFile.target.imageDigest).toBe(VULN_DIGEST);
      expect(call.caseFile.safeVariant?.imageDigest).toBe(SAFE_DIGEST);
    }
    const [w, variants] = judge.calls[0]!.args as [{ id: string }, string[]];
    expect(w.id).toBe('witness-sqli-001');
    expect(variants).toEqual(['vulnerable', 'safe']);
    const [, counterexamples] = [judge.calls[2]!.args[0], judge.calls[2]!.args[2]] as [
      unknown,
      { id: string }[],
    ];
    expect(counterexamples.map((c) => c.id)).toEqual(['submitted-counter-id']);
  });

  it('names the field when a replayed outcome differs', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const judge = new ScriptedJudge({
      runWitness: () => ({
        ...witnessResult(),
        admissible: false,
        passed: false,
        rejectedBy: 'differential',
      }),
      verifyPatch: () => ({ ...verifyResult(), familyFlipped: false }),
    });
    const report = await replay(bytes, { judge });
    expect(report.ok).toBe(false);
    if (!('exhibits' in report)) throw new Error('expected exhibits');
    const w = report.exhibits[0]!;
    expect(w.status).toBe('mismatch');
    expect(w.status === 'mismatch' && w.differences.map((d) => d.field)).toEqual([
      'admissible',
      'rejectedBy',
      'passed',
    ]);
    const p = report.exhibits[2]!;
    expect(p.status === 'mismatch' && p.differences).toEqual([
      { field: 'familyFlipped', recorded: true, replayed: false },
    ]);
    expect(renderReport(report).join('\n')).toContain(
      'exhibit-witness-001 (witness): DIFFERENT admissible',
    );
  });

  it('ignores timings, which differ between machines', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const slower = (r = counterResult()) => ({
      ...r,
      durationMs: r.durationMs + 5000,
      runs: r.runs.map((run) => ({
        ...run,
        durationMs: run.durationMs * 3,
        stdoutSha256: 'e'.repeat(64),
      })),
    });
    const report = await replay(bytes, {
      judge: new ScriptedJudge({ runCounterexample: () => slower() }),
    });
    expect(report.ok).toBe(true);
  });

  it('fails when the Judge throws, without hiding the other exhibits', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const judge = new ScriptedJudge({
      runCounterexample: () => {
        throw new Error('sandbox host unreachable');
      },
    });
    const report = await replay(bytes, { judge });
    expect(report.ok).toBe(false);
    expect('exhibits' in report && report.exhibits.map((e) => e.status)).toEqual([
      'match',
      'error',
      'match',
    ]);
  });

  it('fails on a tampered bundle, names the exhibit, and never calls the Judge', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const judge = new ScriptedJudge();
    const report = await replay(await tamperWitness(bytes), { judge });
    expect(report.ok).toBe(false);
    expect(report.integrity).toEqual({
      ok: false,
      exhibitId: 'exhibit-witness-001',
      reason: 'bytes do not match the manifest digest',
    });
    expect(judge.calls).toEqual([]);
  });

  it('replays a bundle whose case file has no safe variant on the vulnerable target only', async () => {
    const cf = caseFile();
    const { safeVariant: _omit, ...noSafe } = cf;
    void _omit;
    const { bytes } = await buildBundle(bundleInput({ caseFile: noSafe }));
    const judge = new ScriptedJudge();
    await replay(bytes, { judge });
    expect(judge.calls[0]!.args[1]).toEqual(['vulnerable']);
    expect(judge.calls[0]!.caseFile.safeVariant).toBeUndefined();
  });
});

describe('replayBundle (affidavit replay)', () => {
  const write = (name: string, bytes: Uint8Array) => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  };

  it('returns MATCH after a full rerun with a Judge', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const lines: string[] = [];
    const code = await replayBundle(write('ok.tar', bytes), {
      judge: new ScriptedJudge(),
      out: (l) => lines.push(l),
    });
    expect(code).toBe(REPLAY_EXIT.MATCH);
    expect(lines.at(-1)).toBe('replay: same outcomes');
  });

  it('checks integrity only and never reports success without a Judge', async () => {
    const { bytes, sha256 } = await buildBundle(bundleInput());
    const lines: string[] = [];
    const code = await replayBundle(write('nojudge.tar', bytes), { out: (l) => lines.push(l) });
    expect(code).toBe(REPLAY_EXIT.NOT_RERUN);
    expect(lines).toEqual([
      `bundle sha256:${sha256}`,
      'integrity: ok',
      'not rerun: 3 exhibit(s) need a sandbox host Judge to replay',
    ]);
  });

  it('returns FAILED and names the exhibit for a tampered file', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const lines: string[] = [];
    const code = await replayBundle(write('bad.tar', await tamperWitness(bytes)), {
      out: (l) => lines.push(l),
    });
    expect(code).toBe(REPLAY_EXIT.FAILED);
    expect(lines[1]).toContain('integrity: FAILED (exhibit exhibit-witness-001)');
  });
});
