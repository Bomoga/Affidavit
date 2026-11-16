import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaseFile, ExhibitResult, Witness } from '@affidavit/contracts';
import type { ExhibitId } from '@affidavit/contracts';
import { RESULT_ARTIFACT_VERSION } from './artifact.js';
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
