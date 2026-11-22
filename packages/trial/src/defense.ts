import {
  Dismissal,
  RefusalCategory,
  type Budget,
  type CaseFile,
  type CaseFileSource,
  type CaseId,
  type ExhibitResult,
  type JudgePort,
  type PromptId,
} from '@affidavit/contracts';
import type { RenderedPrompt, UntrustedBlock } from '@affidavit/prompts';
import { SUBMISSIONS, type WitnessSubmission } from './envelope.js';
import { ModelCallError, isModelRefusal } from './model/errors.js';
import type {
  StageContext,
  StageHandler,
  StageResult,
  ValidatedAgentResult,
} from './orchestrator.js';
import { buildWitness, variantsFor, witnessExhibitId } from './witness.js';
import type { TrialWorkspace } from './workspace.js';

/** Same signature as `renderPrompt` in @affidavit/prompts; injected so tests can wrap it. */
export type PromptRenderer = (id: PromptId, blocks: readonly UntrustedBlock[]) => RenderedPrompt;

export interface DefenseAttemptConfig {
  promptId: PromptId;
  model: string;
}

/**
 * What a provider safety refusal of the first Defense attempt does (L3-20, CR-T13).
 * - `review` (default): no further model calls; the case goes to a person and is never dismissed.
 * - `second-attempt` (opt-in): the case goes once to the second attempt (`DefenseConfig.second`),
 *   with no first-attempt feedback. P8 found the default second-attempt model refused the same
 *   input, so this is off unless a deployment chooses it.
 */
export type RefusalRoute = 'review' | 'second-attempt';
export const REFUSAL_ROUTES: readonly RefusalRoute[] = ['review', 'second-attempt'];
export const DEFAULT_REFUSAL_ROUTE: RefusalRoute = 'review';
export const REFUSAL_ROUTE_ENV_VAR = 'AFFIDAVIT_REFUSAL_ROUTE';

/**
 * Reads `AFFIDAVIT_REFUSAL_ROUTE` for the composition root. Unset or blank is `review`. The value
 * is trimmed and matched without case; anything else throws, so a typo cannot silently pick a
 * route. Nothing in this package calls it: apps/worker adopts it when it wires the route.
 */
export function refusalRouteFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RefusalRoute {
  const raw = env[REFUSAL_ROUTE_ENV_VAR]?.trim().toLowerCase() ?? '';
  if (raw === '') return DEFAULT_REFUSAL_ROUTE;
  const route = REFUSAL_ROUTES.find((r) => r === raw);
  if (route === undefined) {
    throw new Error(`${REFUSAL_ROUTE_ENV_VAR} must be one of ${REFUSAL_ROUTES.join(', ')}`);
  }
  return route;
}

export interface DefenseConfig {
  first: DefenseAttemptConfig;
  /**
   * Used above the escalation floor, and, with `refusalRoute` `second-attempt`, at any score when
   * the provider refused the first attempt. Must differ from `first` in model and prompt.
   */
  second: DefenseAttemptConfig;
  /** Agent turns per attempt. Schema failures and Judge rejections each use one. */
  maxIterations: number;
  maxTurns: number;
  turnBudget: Budget;
  /** What a refusal of the first attempt does. Defaults to `review` (`DEFAULT_REFUSAL_ROUTE`). */
  refusalRoute?: RefusalRoute;
}

export interface DefenseDeps {
  caseFiles: CaseFileSource;
  judge: JudgePort;
  render: PromptRenderer;
  config: DefenseConfig;
  /** Where an admitted witness is handed to later stages. */
  workspace: TrialWorkspace;
}

/**
 * How one Defense attempt ended. `refused` means the provider's safeguards declined a turn of
 * this attempt (a `ModelCallError` of class `refusal`): the attempt stops there, its model is not
 * asked again, and the refusal never reads as "no witness".
 */
type AttemptOutcome =
  | { kind: 'admitted' }
  | { kind: 'failed'; feedback: string[] }
  | { kind: 'refused'; model: string; error: ModelCallError };

/** One line naming a refused attempt. Fixed text, a table model id and an allowlisted category. */
function refusalNote(ordinal: 'one' | 'two', refused: { model: string; error: ModelCallError }) {
  // The port already allowlists it; checked again against the contract so only a known category
  // ever reaches a detail or message.
  const raw = refused.error.provider?.refusalCategory;
  const category =
    raw === undefined ? 'not given' : RefusalCategory.safeParse(raw).success ? raw : 'other';
  return `Defense attempt ${ordinal} on ${refused.model} was refused by the provider's safeguards (category ${category})`;
}

/**
 * Thrown when a refusal sends a candidate below the escalation floor to review. No contract
 * escalation reason fits a below-floor candidate yet, and a refusal must never dismiss. It is a
 * `ModelCallError` of class `refusal`, so the orchestrator halts the case at `defense` with a
 * `halted` event (reason `model-refusal`, the last refusal's allowlisted category) instead of
 * failing the stage, and the worker flags the halted case for review (with the Lane 1 change in
 * `docs/lanes/lane1/contract-requests.md`, a refusal halt is not retried). It carries the last
 * refusal's sanitized provider failure; every refusal is named in the message.
 */
export class DefenseRefusedError extends ModelCallError {
  constructor(message: string, last: ModelCallError) {
    super(message, last.provider === undefined ? {} : { provider: last.provider });
    this.name = 'DefenseRefusedError';
    this.settlementError = last.settlementError;
  }
}

export async function loadCaseFile(source: CaseFileSource, caseId: CaseId): Promise<CaseFile> {
  const cf = await source.get(caseId);
  if (!cf) throw new Error(`no case file for case ${caseId}`);
  return cf;
}

export function createDefenseHandler(deps: DefenseDeps): StageHandler {
  const { config } = deps;
  if (config.first.model === config.second.model) {
    throw new Error('second Defense attempt must use a different model');
  }
  if (config.first.promptId === config.second.promptId) {
    throw new Error('second Defense attempt must use a different prompt');
  }

  return {
    async run(ctx): Promise<StageResult> {
      const caseFile = await loadCaseFile(deps.caseFiles, ctx.caseId);

      const { candidate, escalationFloor } = caseFile;
      const aboveFloor = candidate.score >= escalationFloor;
      const route = config.refusalRoute ?? DEFAULT_REFUSAL_ROUTE;

      // A refusal goes to a person. No contract event carries a note, so what happened is told in
      // the escalation detail or the thrown message (model id and allowlisted category only).
      const toReview = (notes: string[], last: ModelCallError): StageResult => {
        const why = `${notes.join('; ')}; `;
        if (!aboveFloor) {
          throw new DefenseRefusedError(
            `${why}candidate ${candidate.id} scored ${candidate.score}, below the floor ${escalationFloor}; not dismissed; the case is halted for human review`,
            last,
          );
        }
        return {
          kind: 'escalate',
          reason: 'no-admissible-witness-above-floor',
          detail: `${why}candidate ${candidate.id} scored ${candidate.score}, at or above the floor ${escalationFloor}; no admissible witness, held for human review`,
        };
      };

      const first = await attempt(ctx, deps, caseFile, config.first, []);
      if (first.kind === 'admitted') return { kind: 'advance', next: 'prosecution' };

      if (first.kind === 'refused' && route === 'review') {
        return toReview([refusalNote('one', first)], first.error);
      }

      if (first.kind === 'failed' && !aboveFloor) {
        const dismissal = Dismissal.parse({
          schemaVersion: 1,
          candidateId: candidate.id,
          reason: 'no-admissible-witness-below-floor',
          detail: `candidate scored ${candidate.score}, below the escalation floor ${escalationFloor}; no admissible witness`,
        });
        await ctx.record('dismissed', { dismissal }, 'defense');
        return { kind: 'advance', next: 'dismissed' };
      }

      // Above the floor (F3): never dismiss on one attempt. Try again with a different model and
      // prompt, then hand it to a human. With route `second-attempt`, a refusal of the first
      // attempt goes to the same second attempt at any score, since a refusal says nothing about
      // the finding. The refused model is not asked again, and there is no feedback to pass on.
      const prior = first.kind === 'failed' ? first.feedback : [];
      const second = await attempt(ctx, deps, caseFile, config.second, prior);
      if (second.kind === 'admitted') return { kind: 'advance', next: 'prosecution' };

      const notes: string[] = [];
      if (first.kind === 'refused') notes.push(refusalNote('one', first));
      // A refused second attempt never starts a third.
      if (second.kind === 'refused') {
        notes.push(refusalNote('two', second));
        return toReview(notes, second.error);
      }
      const why = notes.length > 0 ? `${notes.join('; ')}; ` : '';

      if (!aboveFloor) {
        // Below the floor the second attempt ran only because the first was refused, and it
        // failed on its own merits: dismissed, as one failed honest attempt is today.
        const dismissal = Dismissal.parse({
          schemaVersion: 1,
          candidateId: candidate.id,
          reason: 'no-admissible-witness-below-floor',
          detail: `${why}candidate scored ${candidate.score}, below the escalation floor ${escalationFloor}; the second Defense attempt produced no admissible witness`,
        });
        await ctx.record('dismissed', { dismissal }, 'defense');
        return { kind: 'advance', next: 'dismissed' };
      }

      return {
        kind: 'escalate',
        reason: 'no-admissible-witness-above-floor',
        detail: `${why}candidate ${candidate.id} scored ${candidate.score}, at or above the floor ${escalationFloor}; two Defense attempts produced no admissible witness`,
      };
    },
  };
}

/** Admitted means the Judge said so, and, when a safe variant exists, the proof was differential. */
function admits(caseFile: CaseFile, r: ExhibitResult): boolean {
  if (!r.admissible || !r.passed) return false;
  if (caseFile.safeVariant && r.safeVariantFail !== true) return false;
  return true;
}

/**
 * The untrusted blocks of one Defense turn's user message. All case-file and Judge text goes in
 * as labeled blocks; the renderer puts them in the user message inside the untrusted wrapper.
 * Nothing here builds system text. Exported so the model probe replays the exact input (L3-18).
 */
export function defenseBlocks(caseFile: CaseFile, notes: readonly string[]): UntrustedBlock[] {
  const blocks: UntrustedBlock[] = [
    { label: 'candidate', content: JSON.stringify(caseFile.candidate) },
    ...caseFile.slices.map((s) => ({
      label: 'case-file-slice',
      content: `file: ${s.file}\n${s.code}`,
    })),
  ];
  if (notes.length > 0) blocks.push({ label: 'judge-feedback', content: notes.join('\n') });
  return blocks;
}

async function attempt(
  ctx: StageContext,
  deps: DefenseDeps,
  caseFile: CaseFile,
  which: DefenseAttemptConfig,
  priorFeedback: readonly string[],
): Promise<AttemptOutcome> {
  const { config, judge, render } = deps;
  const feedback: string[] = [];

  for (let i = 0; i < config.maxIterations; i++) {
    const rendered = render(
      which.promptId,
      defenseBlocks(caseFile, [...priorFeedback, ...feedback]),
    );
    let res: ValidatedAgentResult<WitnessSubmission>;
    try {
      res = await ctx.runAgentValidated(
        {
          promptId: rendered.promptId,
          promptVersion: rendered.version,
          model: which.model,
          system: rendered.system,
          user: rendered.user,
          tools: ['submit_witness'],
          outputSchemaRef: rendered.outputSchemaRef,
          maxTurns: config.maxTurns,
          budget: config.turnBudget,
        },
        SUBMISSIONS.defense,
      );
    } catch (err) {
      // Only a provider refusal ends the attempt here. The orchestrator already settled its
      // charge as the port reported it. Kill switch, budget, unconfigured, config and every
      // other call error go up unchanged.
      if (isModelRefusal(err)) return { kind: 'refused', model: which.model, error: err };
      throw err;
    }

    if (res.outcome === 'no-submission') {
      feedback.push('no witness was submitted');
      return { kind: 'failed', feedback };
    }
    if (res.outcome === 'inadmissible') {
      feedback.push(`schema: ${res.errors.join('; ')}`);
      continue;
    }

    // The contract Witness is built here, never taken from the agent.
    const witness = buildWitness(caseFile, res.value);
    await ctx.record(
      'exhibit-submitted',
      {
        exhibitId: witnessExhibitId(caseFile.id, witness.template, witness.params),
        kind: 'witness',
      },
      'defense',
    );
    // Pass or fail comes only from the Judge. Anything the agent claims about it is ignored.
    const result = await judge.runWitness(caseFile, witness, variantsFor(caseFile));
    const expectedId = witnessExhibitId(caseFile.id, witness.template, witness.params);
    if (result.exhibitId !== expectedId) {
      throw new Error(
        `Judge exhibit id ${result.exhibitId} does not match the witness id ${expectedId}`,
      );
    }
    await ctx.record('exhibit-result', { result }, 'judge');
    if (!result.admissible && result.rejectedBy) {
      await ctx.record(
        'exhibit-inadmissible',
        { exhibitId: result.exhibitId, rejectedBy: result.rejectedBy },
        'judge',
      );
    }

    if (admits(caseFile, result)) {
      await deps.workspace.saveWitness(ctx.caseId, { witness, result });
      await deps.workspace.addExhibit(ctx.caseId, result.exhibitId);
      return { kind: 'admitted' };
    }

    feedback.push(
      `judge: ${result.rejectedBy ?? (caseFile.safeVariant && result.safeVariantFail !== true ? 'differential' : 'witness did not pass')}`,
    );
  }
  return { kind: 'failed', feedback };
}
