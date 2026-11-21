/**
 * discoverCase end to end on a tiny local Express repository, offline: real ingestion (git
 * checkout verified by hash, redaction), the real normalizer, map, arraignment and assembly. The
 * two scanner images are replaced behind ToolRunnerPort by stand-ins that write SARIF the way the
 * real tools do (the docker tests run the real images).
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CaseFile,
  CaseId,
  RepoId,
  TenantId,
  samples,
  type BootHints,
  type ToolRunnerPort,
} from '@affidavit/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ARRAIGN_CONFIG } from '../arraign/index.js';
import {
  cleanup,
  EXPRESS_PKG,
  fakeGitleaks,
  makeRepo,
  tmpDir,
  type Files,
} from '../ingest/testkit.js';
import {
  DiscoveryPipelineError,
  caseFileDiff,
  discoverCase,
  type DiscoverCaseDeps,
} from './index.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

const APP = [
  "const express = require('express');",
  "const mysql = require('mysql');",
  'const db = mysql.createConnection({});',
  'const app = express();',
  'function find(req, res) {',
  "  db.query('select * from t where id = ' + req.query.id, (e, r) => res.json(r));",
  '}',
  "app.get('/items', find);",
  'app.listen(3000);',
  '',
].join('\n');
const SINK_LINE = 6;
const RULE = 'affidavit.injection.sql-concat';

const BOOT: BootHints = CaseFile.parse(samples.CaseFile).bootHints;

/** Semgrep stand-in: one finding of our SQL rule at the sink line, as SARIF under /out. */
function fakeSemgrep(findings: { file: string; line: number }[]): ToolRunnerPort {
  return {
    run(_image, _args, mounts) {
      const out = mounts.find((m) => m.containerPath === '/out')?.hostPath;
      if (out === undefined) throw new Error('missing /out');
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, 'semgrep.sarif'),
        JSON.stringify({
          version: '2.1.0',
          runs: [
            {
              tool: {
                driver: {
                  name: 'semgrep',
                  rules: [{ id: RULE, properties: { tags: ['CWE-89'] } }],
                },
              },
              results: findings.map((f) => ({
                ruleId: RULE,
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: `/src/${f.file}` },
                      region: { startLine: f.line, endLine: f.line },
                    },
                  },
                ],
              })),
            },
          ],
        }),
      );
      return Promise.resolve({ exitCode: 0, outputPath: out });
    },
  };
}

/** Dispatches each run to the stand-in for the tool whose report it asks for. */
function runner(findings: { file: string; line: number }[]): ToolRunnerPort {
  const gitleaks = fakeGitleaks();
  const semgrep = fakeSemgrep(findings);
  return {
    run(image, args, mounts) {
      return args.some((a) => a.startsWith('/out/semgrep'))
        ? semgrep.run(image, args, mounts)
        : gitleaks.run(image, args, mounts);
    },
  };
}

function setup(files: Files, findings = [{ file: 'app.js', line: SINK_LINE }]) {
  const { dir, shas } = makeRepo([files]);
  const workRoot = tmpDir();
  const deps: DiscoverCaseDeps = {
    runner: runner(findings),
    workRoot,
    arraignConfig: DEFAULT_ARRAIGN_CONFIG,
    bootHints: BOOT,
    allowLocalSource: true,
  };
  const input = {
    caseId: CaseId.parse('case-pipeline-001'),
    tenantId: TenantId.parse('tenant-pipeline'),
    repo: RepoId.parse('repo-pipeline'),
    source: dir,
    commit: shas[0] as string,
  };
  return { deps, input, workRoot };
}

describe('caseFileDiff', () => {
  const cf = CaseFile.parse(samples.CaseFile);
  it('ignores key order and names only the fields that differ', () => {
    const reverse = (o: object) => Object.fromEntries(Object.entries(o).reverse());
    const reordered = { ...reverse(cf), candidate: reverse(cf.candidate) } as CaseFile;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(cf)[0]);
    expect(caseFileDiff(cf, reordered)).toEqual([]);
    const other = { ...cf, escalationFloor: 0.1, candidate: { ...cf.candidate, score: 0.01 } };
    expect(caseFileDiff(cf, other)).toEqual(['candidate', 'escalationFloor']);
  });
});

describe('discoverCase', () => {
  it('produces a contract-valid case file for the reachable candidate and leaves no files behind', async () => {
    const { deps, input, workRoot } = setup({ 'package.json': EXPRESS_PKG, 'app.js': APP });
    const out = await discoverCase(deps, input);
    expect(out.kind).toBe('case-file');
    if (out.kind !== 'case-file') return;
    const cf = CaseFile.parse(out.caseFile);
    expect(cf.id).toBe(input.caseId);
    expect(cf.tenantId).toBe(input.tenantId);
    expect(cf.target).toEqual({ repo: input.repo, commit: input.commit, variant: 'vulnerable' });
    expect(cf.candidate).toMatchObject({ ruleId: RULE, file: 'app.js', reachability: 'reachable' });
    expect(cf.candidate.score).toBeGreaterThanOrEqual(cf.escalationFloor);
    expect(cf.route).toMatchObject({ method: 'GET', path: '/items' });
    expect(cf.bootHints).toEqual(BOOT);
    for (const s of cf.slices) expect(s.untrusted).toBe(true);
    expect(out.scanPartial).toBe(false);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it('is deterministic: naming the candidate reproduces the same case file', async () => {
    const { deps, input } = setup({ 'package.json': EXPRESS_PKG, 'app.js': APP });
    const first = await discoverCase(deps, input);
    if (first.kind !== 'case-file') throw new Error(`expected a case file, got ${first.kind}`);
    const again = await discoverCase(deps, { ...input, candidateId: first.caseFile.candidate.id });
    expect(again).toEqual(first);
  });

  it('returns not-found for a candidate the scan does not produce', async () => {
    const { deps, input } = setup({ 'package.json': EXPRESS_PKG, 'app.js': APP });
    const out = await discoverCase(deps, { ...input, candidateId: 'cand-not-there' });
    expect(out).toEqual({ kind: 'not-found', candidateId: 'cand-not-there', holds: [] });
  });

  it('returns not-found when nothing goes to trial and no candidate is named', async () => {
    const { deps, input } = setup({ 'package.json': EXPRESS_PKG, 'app.js': APP }, []);
    expect(await discoverCase(deps, input)).toEqual({
      kind: 'not-found',
      candidateId: null,
      holds: [],
    });
  });

  it('returns unsupported for a repository with no Node app, with fixed text only', async () => {
    const { deps, input, workRoot } = setup({ 'main.py': 'print(1)\n' });
    const out = await discoverCase(deps, input);
    expect(out).toMatchObject({ kind: 'unsupported', reason: 'no-package-json' });
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it('returns incomplete when the secret scan did not cover a file, and keeps nothing', async () => {
    const { deps, input, workRoot } = setup({
      'package.json': EXPRESS_PKG,
      'app.js': APP,
      'docs/x.dat': Buffer.from('%PDF-1.4\nnothing here\n'),
    });
    const out = await discoverCase(deps, input);
    expect(out.kind).toBe('incomplete');
    if (out.kind === 'incomplete') expect(out.coverageLosses).toBeGreaterThan(0);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  describe('F3 holds (a dismissal rule matched at or above the floor)', () => {
    // A second sink in a function no route reaches: the map says unreachable. With a floor of 0
    // every dismissal rule that matches is held instead of applied.
    const HELD_APP = [
      ...APP.split('\n').slice(0, -1),
      'function unused(req) {',
      "  db.query('select * from u where id = ' + req.query.id, () => {});",
      '}',
      '',
    ].join('\n');
    const HELD_LINE = 11;
    const files = { 'package.json': EXPRESS_PKG, 'app.js': HELD_APP };
    const findings = [
      { file: 'app.js', line: SINK_LINE },
      { file: 'app.js', line: HELD_LINE },
    ];
    const holdAll = { escalationFloor: 0, dismissBelow: 0 };

    it('lists every hold next to the trial case file when no candidate is named', async () => {
      const { deps, input, workRoot } = setup(files, findings);
      const out = await discoverCase({ ...deps, arraignConfig: holdAll }, input);
      expect(out.kind).toBe('case-file');
      if (out.kind !== 'case-file') return;
      expect(out.caseFile.candidate.range.startLine).toBe(SINK_LINE);
      expect(out.holds).toHaveLength(1);
      expect(out.holds[0]).toMatchObject({ wouldDismiss: 'unreachable', route: 'person-or-trial' });
      expect(out.holds[0]?.caseFile).toBeUndefined();
      expect(readdirSync(workRoot)).toEqual([]);
    });

    it('assembles a case file of its own for each hold when asked', async () => {
      const { deps, input } = setup(files, findings);
      const out = await discoverCase(
        { ...deps, arraignConfig: holdAll },
        { ...input, holdCaseId: (c) => CaseId.parse(`held-${c}`) },
      );
      if (out.kind !== 'case-file') throw new Error(`expected a case file, got ${out.kind}`);
      const [hold] = out.holds;
      expect(hold).toBeDefined();
      const cf = CaseFile.parse(hold?.caseFile);
      expect(cf.id).toBe(`held-${hold?.candidateId}`);
      expect(cf.candidate.id).toBe(hold?.candidateId);
      expect(cf.candidate.range.startLine).toBe(HELD_LINE);
    });

    it('returns review, with the holds, when the held candidate is named', async () => {
      const { deps, input } = setup(files, findings);
      const first = await discoverCase({ ...deps, arraignConfig: holdAll }, input);
      if (first.kind !== 'case-file') throw new Error(`expected a case file, got ${first.kind}`);
      const held = first.holds[0]?.candidateId ?? '';
      const out = await discoverCase(
        { ...deps, arraignConfig: holdAll },
        { ...input, candidateId: held },
      );
      expect(out).toMatchObject({ kind: 'review', candidateId: held, route: 'person-or-trial' });
      if (out.kind === 'review') expect(out.holds.map((h) => h.candidateId)).toEqual([held]);
    });
  });

  it('turns an arraignment input error into a typed DiscoveryPipelineError', async () => {
    const { deps, input } = setup({ 'package.json': EXPRESS_PKG, 'app.js': APP });
    const bad = { ...deps, arraignConfig: { escalationFloor: 0.2, dismissBelow: 0.5 } };
    await expect(discoverCase(bad, input)).rejects.toBeInstanceOf(DiscoveryPipelineError);
  });
});
