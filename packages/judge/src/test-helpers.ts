import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaseFile, ExhibitResult, Witness } from '@affidavit/contracts';
import type { Candidate, ExhibitId, PatchExhibit, RescanPort } from '@affidavit/contracts';
import { RESULT_ARTIFACT_VERSION } from './artifact.js';
import { sha256Hex } from './canonical.js';
import { parseUnifiedDiff, renderDiff } from './patch/diff.js';
import {
  numstatMismatch,
  type PatchPlan,
  type PatchWorkbench,
  type PrepareOutcome,
  type PreparedPatch,
} from './patch/workbench.js';
import type {
  Attempt,
  EvidenceVariant,
  ExecutionRequest,
  RawAttempt,
  WitnessExecutor,
} from './executor.js';
import type { ObservedAttempt } from './rules.js';

// Test-only helpers. Not exported from index.ts.

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');

export function fixture(relPath: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, relPath), 'utf8')) as unknown;
}

export const exhibitResultFixture = (name: string): ExhibitResult =>
  ExhibitResult.parse(fixture(`exhibit-results/${name}`));

export const gateCaseFile = (): CaseFile =>
  CaseFile.parse(fixture('casefiles/nodegoat-sqli-001.json'));

export const gateWitness = (): Witness =>
  Witness.parse({
    schemaVersion: 1,
    id: 'witness-sqli-001',
    caseId: 'case-nodegoat-sqli-001',
    cls: 'injection',
    template: '/* hand-written gate witness stand-in */',
    params: [{ name: 'threshold', values: [1, 2, 3] }],
    author: 'defense',
    sha256: '1'.repeat(64),
  });

export const FIXTURE_EXHIBIT_ID = 'exhibit-witness-001' as ExhibitId;

export const artifactJson = (results: readonly boolean[]): string =>
  JSON.stringify({
    schemaVersion: RESULT_ARTIFACT_VERSION,
    results: results.map((passed, paramIndex) => ({ paramIndex, passed })),
  });

/** A clean, completed run whose family reported `results`. */
export function raw(results: readonly boolean[], over: Partial<RawAttempt> = {}): RawAttempt {
  return {
    exitCode: results.every((r) => r) ? 0 : 1,
    timedOut: false,
    oomKilled: false,
    durationMs: 812,
    stdout: 'ok',
    stderr: '',
    egressAttempts: 0,
    traceTampered: false,
    artifact: artifactJson(results),
    ...over,
  };
}

export function observed(
  variant: EvidenceVariant,
  attempt: Attempt,
  results: readonly boolean[],
  over: Partial<RawAttempt> = {},
): ObservedAttempt {
  return { ...raw(results, over), variant, attempt };
}

/** Three identical attempts on one variant. */
export const thrice = (
  variant: EvidenceVariant,
  results: readonly boolean[],
  over: Partial<RawAttempt> = {},
): ObservedAttempt[] => ([1, 2, 3] as const).map((n) => observed(variant, n, results, over));

/** Executor that answers from a function of the request and records every request. */
export class ScriptedExecutor implements WitnessExecutor {
  readonly requests: ExecutionRequest[] = [];
  constructor(
    private readonly answer: (req: ExecutionRequest) => RawAttempt | Promise<RawAttempt>,
  ) {}
  async execute(req: ExecutionRequest): Promise<RawAttempt> {
    this.requests.push(req);
    return this.answer(req);
  }
}

/** The behaviour of a real witness for a real bug: whole family passes on vulnerable, fails on safe. */
export const differentialTarget =
  (size: number) =>
  (req: ExecutionRequest): RawAttempt =>
    raw(new Array<boolean>(size).fill(req.variant === 'vulnerable'));

/** The gate fix for NodeGoat's allocations search, as Remedy would submit it. */
/**
 * Adds the `diff --git a/P b/P` header git writes before each `---`/`+++` pair that lacks one, so
 * short fixtures stay readable. P comes from the `+++ b/` name, else the `--- a/` name.
 */
export function gitDiff(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    const prev = out.at(-1) ?? '';
    if (
      l.startsWith('--- ') &&
      next.startsWith('+++ ') &&
      !/^(diff --git|index |new file|deleted file)/.test(prev)
    ) {
      const name = next.slice(4) !== '/dev/null' ? next.slice(4) : l.slice(4);
      const path = name.replace(/^[ab]\//, '');
      out.push(`diff --git a/${path} b/${path}`);
    }
    out.push(l);
  }
  return out.join('\n');
}

export const GATE_PATCH_DIFF = `diff --git a/app/data/allocations-dao.js b/app/data/allocations-dao.js
--- a/app/data/allocations-dao.js
+++ b/app/data/allocations-dao.js
@@ -70,5 +70,6 @@ const AllocationsDAO = function(db) {
         const searchCriteria = () => {
-            if (threshold) {
-                return { $where: \`this.userId == \${parsedUserId} && this.stocks > '\${threshold}'\` };
+            const parsedThreshold = parseInt(threshold, 10);
+            if (parsedThreshold >= 0 && parsedThreshold <= 99) {
+                return { $and: [{ userId: parsedUserId }, { stocks: { $gt: parsedThreshold } }] };
             }
             return { userId: parsedUserId };
`;

/**
 * A Remedy patch exhibit for `diff`, with `diff --git` headers added where a fixture leaves them
 * out (`gitDiff`; pass `{ raw: true }` to keep the text exactly as given).
 */
export function patchExhibit(
  text: string = GATE_PATCH_DIFF,
  over: Partial<PatchExhibit> = {},
  opts: { raw?: boolean } = {},
): PatchExhibit {
  const diff = opts.raw === true ? text : gitDiff(text);
  const parsed = parseUnifiedDiff(diff);
  return {
    schemaVersion: 1,
    id: 'exhibit-patch-001' as ExhibitId,
    caseId: 'case-nodegoat-sqli-001' as PatchExhibit['caseId'],
    author: 'remedy',
    kind: 'patch',
    code: diff,
    sha256: sha256Hex(diff),
    diff,
    filesTouched: parsed.ok ? parsed.diff.files.map((f) => f.path) : ['x'],
    linesChanged: parsed.ok ? parsed.diff.linesChanged : 1,
    ...over,
  };
}

/** Workbench that "builds" the patched target instantly and records what it was asked. */
export class ScriptedWorkbench implements PatchWorkbench {
  readonly prepared: PatchExhibit[] = [];
  readonly plans: PatchPlan[] = [];
  released = 0;
  suiteRuns = 0;
  addedTestRuns = 0;
  constructor(
    private readonly script: {
      prepare?: PrepareOutcome;
      suitePassed?: boolean;
      addedTestsPassed?: boolean | null;
      /**
       * What `git apply --numstat` would print for `renderDiff(plan.code)`, as the real workbench
       * checks it. When set, a disagreement with the Judge's reading is an `apply` failure.
       */
      numstat?: (codeDiff: string) => string;
    } = {},
  ) {}
  prepare(_cf: CaseFile, patch: PatchExhibit, plan: PatchPlan): Promise<PrepareOutcome> {
    this.prepared.push(patch);
    this.plans.push(plan);
    if (this.script.numstat !== undefined) {
      const why = numstatMismatch(this.script.numstat(renderDiff(plan.code)), plan.code);
      if (why !== null) return Promise.resolve({ ok: false, stage: 'apply', detail: why });
    }
    return Promise.resolve(this.script.prepare ?? { ok: true, prepared: PATCHED });
  }
  runSuite(): Promise<{ passed: boolean }> {
    this.suiteRuns++;
    return Promise.resolve({ passed: this.script.suitePassed ?? true });
  }
  runAddedTests(): Promise<{ passed: boolean } | null> {
    this.addedTestRuns++;
    const p = this.script.addedTestsPassed;
    return Promise.resolve(p === undefined || p === null ? null : { passed: p });
  }
  release(): Promise<void> {
    this.released++;
    return Promise.resolve();
  }
}

export const PATCHED: PreparedPatch = {
  target: {
    repo: 'repo-nodegoat' as PreparedPatch['target']['repo'],
    commit: 'cccccccccccccccccccccccccccccccccccccccc',
    variant: 'patched',
  },
  workspacePath: '/nonexistent/patched-workspace',
};

/** Re-scan port double that records the workspace it was given. */
export class RecordingRescan implements RescanPort {
  readonly paths: string[] = [];
  constructor(private readonly clean = true) {}
  rescan(
    _cf: CaseFile,
    path: string,
  ): Promise<{ clean: boolean; candidates: readonly Candidate[] }> {
    this.paths.push(path);
    return Promise.resolve({ clean: this.clean, candidates: [] });
  }
}
