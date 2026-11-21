/**
 * REAL Lane 1 stage work (AFFIDAVIT_INTAKE_IMPL=real): intake, map and arraign run the discovery
 * pipeline (`discoverCase` in @affidavit/discovery) on the case's pinned repository and commit.
 * Wiring only; the decisions are discovery's.
 *
 * A case is opened with its case file (CaseStore.open), and the stored case file is immutable. So
 * these stages do not write a new one: they re-derive it from the source and refuse to go on unless
 * real discovery reproduces it. `open-case --discover` opens cases from the same pipeline.
 *
 * - intake: ingestion must succeed and the candidate must still go to trial. `unsupported` and `incomplete` have no contract slot (CR-4)
 *   and no legal transition (escalated is reachable from defense onward only), so the job fails
 *   with IntakeRefusedError. The reason is the failed attempt's recorded error; recovery retries
 *   it up to AFFIDAVIT_MAX_STAGE_ATTEMPTS and then writes a review flag (attempts-exhausted), so a
 *   person sees it. Never dismissed, never retried forever.
 * - map: the re-derived candidate's reachability and route must equal the stored ones.
 * - arraign: the whole re-derived case file must equal the stored one; only then defense.
 * - A dismissal, an F3 hold or a candidate not found fails the job at any of the three stages
 *   with DiscoveryOutcomeError, which names the outcome; a difference fails it with
 *   CaseFileMismatchError, which names the fields. A case opened for trial is never dismissed here.
 *
 * Within one process the pipeline runs once per case and the three stages share the result; after
 * a restart a stage runs it again.
 */
import type { CaseFile, CaseStage } from '@affidavit/contracts';
import type { StageCore, StageEnv } from '@affidavit/db';
import {
  caseFileDiff,
  type DiscoverCaseInput,
  type DiscoverCaseOutcome,
} from '@affidavit/discovery';
import { moveTo, repairIntakeEntry } from '../moves.js';

export type Discover = (input: DiscoverCaseInput) => Promise<DiscoverCaseOutcome>;

/** Ingestion refused the repository. Fixed text from discovery only, never repo content. */
export class IntakeRefusedError extends Error {
  constructor(
    readonly outcome: 'unsupported' | 'incomplete',
    detail: string,
  ) {
    super(
      `intake refused the repository (${outcome}): ${detail}; no contract slot or transition exists for it (CR-4), so a person must look`,
    );
    this.name = 'IntakeRefusedError';
  }
}

/** Real discovery did not reproduce the stored case file. Names fields, never values. */
export class CaseFileMismatchError extends Error {
  constructor(stage: CaseStage, what: string) {
    super(`${stage}: real discovery does not reproduce the stored case file (${what})`);
    this.name = 'CaseFileMismatchError';
  }
}

type OtherOutcome = Extract<DiscoverCaseOutcome, { kind: 'dismissed' | 'review' | 'not-found' }>;

/**
 * Real discovery no longer sends this case's candidate to trial: it was dismissed, held for
 * review (F3), or not produced at all. Names the outcome and discovery's own reason codes, never
 * repository content. The case is never dismissed here; recovery flags it for a person.
 */
export class DiscoveryOutcomeError extends Error {
  readonly outcome: OtherOutcome['kind'];
  constructor(stage: CaseStage, o: OtherOutcome) {
    const what =
      o.kind === 'dismissed'
        ? `would be dismissed (${o.dismissal.reason})`
        : o.kind === 'review'
          ? `is held for review (F3: would dismiss as ${o.wouldDismiss}, route ${o.route})`
          : 'was not found by the scan';
    super(
      `${stage}: real discovery no longer sends this case's candidate to trial: it ${what}; the case is never dismissed here, so a person must look`,
    );
    this.name = 'DiscoveryOutcomeError';
    this.outcome = o.kind;
  }
}

/** The case's repository has no entry in AFFIDAVIT_REPO_SOURCES. */
export class NoSourceError extends Error {
  constructor(repo: string) {
    super(`AFFIDAVIT_REPO_SOURCES has no source for repository ${repo}`);
    this.name = 'NoSourceError';
  }
}

function describeRefusal(
  o: Extract<DiscoverCaseOutcome, { kind: 'unsupported' | 'incomplete' }>,
): string {
  return o.kind === 'unsupported'
    ? `${o.reason}: ${o.detail}`
    : `${o.reason}, ${o.coverageLosses} coverage loss(es) in the secret scan`;
}

const MAX_CACHED = 64;

export function realIntakeCores(opts: {
  discover: Discover;
  sources: Readonly<Record<string, string>>;
  /**
   * True when defense runs the real trial orchestrator, which emits defense's `stage-entered`
   * itself at the start of its run, inside the defense visit (where a retry's repeat is dropped).
   * Arraign then records only its exit, or the case would show two entries.
   */
  trialEntersDefense?: boolean;
}): Partial<Record<CaseStage, StageCore>> {
  const cache = new Map<string, Promise<DiscoverCaseOutcome>>();

  async function rederive(
    env: StageEnv,
  ): Promise<{ stored: CaseFile; outcome: DiscoverCaseOutcome }> {
    const { job } = env;
    const stored = await env.caseFiles.get(job.caseId);
    if (!stored) throw new Error(`no case file for ${job.caseId}`);
    const repo = stored.target.repo;
    const source = Object.prototype.hasOwnProperty.call(opts.sources, repo)
      ? opts.sources[repo]
      : undefined;
    if (source === undefined) throw new NoSourceError(repo);
    const key = `${job.tenantId}|${job.caseId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = opts.discover({
        caseId: stored.id,
        tenantId: stored.tenantId,
        repo,
        source,
        commit: stored.target.commit,
        candidateId: stored.candidate.id,
      });
      cache.set(key, pending);
      // A failure is not kept: the retry runs the pipeline again.
      pending.catch(() => cache.delete(key));
      while (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    return { stored, outcome: await pending };
  }

  const reproduced = (stage: CaseStage, stored: CaseFile, o: DiscoverCaseOutcome) => {
    if (o.kind === 'case-file') return caseFileDiff(stored, o.caseFile);
    if (o.kind === 'dismissed' || o.kind === 'review' || o.kind === 'not-found') {
      throw new DiscoveryOutcomeError(stage, o);
    }
    throw new IntakeRefusedError(o.kind, describeRefusal(o));
  };

  return {
    intake: async (env) => {
      await repairIntakeEntry(env);
      const { outcome } = await rederive(env);
      if (outcome.kind === 'unsupported' || outcome.kind === 'incomplete') {
        throw new IntakeRefusedError(outcome.kind, describeRefusal(outcome));
      }
      // Fail here, naming the outcome, rather than at map with a mismatch.
      if (outcome.kind !== 'case-file') throw new DiscoveryOutcomeError('intake', outcome);
      await env.checkpoint('after-discovery');
      await moveTo(env, 'map');
    },
    map: async (env) => {
      const { stored, outcome } = await rederive(env);
      const diff = reproduced('map', stored, outcome);
      // The map's part of the case file: the route and the candidate's reachability.
      const mapFields: string[] = diff.filter((f) => f === 'route');
      if (
        outcome.kind === 'case-file' &&
        outcome.caseFile.candidate.reachability !== stored.candidate.reachability
      ) {
        mapFields.push('candidate.reachability');
      }
      if (mapFields.length > 0) {
        throw new CaseFileMismatchError('map', `differs in ${mapFields.join(', ')}`);
      }
      await env.checkpoint('after-discovery');
      await moveTo(env, 'arraign');
    },
    arraign: async (env) => {
      const { stored, outcome } = await rederive(env);
      const diff = reproduced('arraign', stored, outcome);
      if (diff.length > 0)
        throw new CaseFileMismatchError('arraign', `differs in ${diff.join(', ')}`);
      await env.checkpoint('after-discovery');
      cache.delete(`${env.job.tenantId}|${env.job.caseId}`);
      await moveTo(env, 'defense', { enterNext: opts.trialEntersDefense !== true });
    },
  };
}
