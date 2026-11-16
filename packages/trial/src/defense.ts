import {
  Dismissal,
  ExhibitId,
  WitnessId,
  type Budget,
  type CaseFile,
  type CaseId,
  type ExhibitResult,
  type JudgePort,
  type TargetVariant,
  type Witness,
} from '@affidavit/contracts';
import { renderPrompt, type PromptId } from '@affidavit/prompts';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { WitnessSubmission } from './envelope.js';
import { SUBMISSIONS } from './envelope.js';
import type { StageContext, StageHandler, StageResult } from './orchestrator.js';
import type { TrialWorkspace } from './workspace.js';

export interface DefenseAttemptConfig {
  promptId: PromptId;
  model: string;
}

export interface DefenseConfig {
  first: DefenseAttemptConfig;
  /** Used only above the escalation floor. Must differ from `first` in model and prompt. */
  second: DefenseAttemptConfig;
  /** Agent turns per attempt. Schema failures and Judge rejections each use one. */
  maxIterations: number;
  maxTurns: number;
  turnBudget: Budget;
}

export interface DefenseDeps {
  loadCaseFile: (caseId: CaseId) => Promise<CaseFile>;
  judge: JudgePort;
  config: DefenseConfig;
  /** Where an admitted witness and its exhibit id are handed to later stages. */
  workspace?: TrialWorkspace;
}

interface AttemptOutcome {
  admitted: boolean;
  feedback: string[];
}

/** Builds the full contract Witness around what the agent submitted. Code, not the agent, sets ids and authorship. */
function buildWitness(caseId: CaseId, caseFile: CaseFile, sub: WitnessSubmission): Witness {
  const sha256 = sha256Hex(canonicalJson({ template: sub.template, params: sub.params }));
  return {
    schemaVersion: 1,
    id: WitnessId.parse(`witness-${sha256.slice(0, 24)}`),
    caseId,
    cls: caseFile.candidate.cls,
    template: sub.template,
    params: sub.params,
    author: 'defense',
    sha256,
  };
}

/**
 * The id the Judge will mint for this witness (docs/lanes/lane2/rules-of-evidence.md,
 * "Exhibit ids"), so the submitted event and the result event point at the same exhibit.
 */
function submittedExhibitId(witness: Witness): ExhibitId {
  const hash = sha256Hex(
    canonicalJson({
      caseId: witness.caseId,
      kind: 'witness',
      params: witness.params,
      template: witness.template,
    }),
  );
  return ExhibitId.parse(`exhibit-witness-${hash.slice(0, 24)}`);
}

function describeRejection(r: ExhibitResult): string {
  if (r.rejectedBy) return r.rejectedBy;
  const flags = [
    r.vulnPass ? null : 'did not pass on the vulnerable code',
    r.safeVariantFail === false ? 'also passed on the safe variant' : null,
  ].filter((f): f is string => f !== null);
  return flags.length > 0 ? flags.join(', ') : 'witness did not pass';
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
      const caseFile = await deps.loadCaseFile(ctx.caseId);

      const first = await attempt(ctx, deps, caseFile, config.first, []);
      if (first.admitted) return { kind: 'advance', next: 'prosecution' };

      if (caseFile.candidate.score < caseFile.escalationFloor) {
        await ctx.record(
          'dismissed',
          {
            dismissal: Dismissal.parse({
              schemaVersion: 1,
              candidateId: caseFile.candidate.id,
              reason: 'no-admissible-witness-below-floor',
              detail: `score ${caseFile.candidate.score} is below the floor ${caseFile.escalationFloor}; one Defense attempt produced no admissible witness`,
            }),
          },
          'defense',
        );
        return { kind: 'advance', next: 'dismissed' };
      }

      // Above the floor (F3): never dismiss on one attempt. Try again with a different
      // model and prompt, then hand it to a human.
      const second = await attempt(ctx, deps, caseFile, config.second, first.feedback);
      if (second.admitted) return { kind: 'advance', next: 'prosecution' };

      return {
        kind: 'escalate',
        reason: 'no-admissible-witness-above-floor',
        detail: `candidate ${caseFile.candidate.id} scored ${caseFile.candidate.score} at or above the floor ${caseFile.escalationFloor}; two Defense attempts produced no admissible witness`,
      };
    },
  };
}

async function attempt(
  ctx: StageContext,
  deps: DefenseDeps,
  caseFile: CaseFile,
  which: DefenseAttemptConfig,
  priorFeedback: readonly string[],
): Promise<AttemptOutcome> {
  const { config, judge } = deps;
  const feedback: string[] = [];

  for (let i = 0; i < config.maxIterations; i++) {
    // All case-file and Judge text goes in as labeled blocks. The renderer puts them in the
    // user message inside the untrusted wrapper. Nothing here builds system text.
    const blocks = [
      { label: 'candidate', content: JSON.stringify(caseFile.candidate) },
      ...caseFile.slices.map((s) => ({
        label: 'case-file-slice',
        content: `file: ${s.file}\n${s.code}`,
      })),
    ];
    const notes = [...priorFeedback, ...feedback];
    if (notes.length > 0) blocks.push({ label: 'judge-feedback', content: notes.join('\n') });

    const rendered = renderPrompt(which.promptId, blocks);
    const res = await ctx.runAgentValidated(
      {
        actor: 'defense',
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

    if (res.outcome === 'no-submission') {
      feedback.push('no witness was submitted');
      return { admitted: false, feedback };
    }
    if (res.outcome === 'inadmissible') {
      feedback.push(`schema: ${res.errors.join('; ')}`);
      continue;
    }

    const witness = buildWitness(ctx.caseId, caseFile, res.value);
    await ctx.record(
      'exhibit-submitted',
      { exhibitId: submittedExhibitId(witness), kind: 'witness' },
      'defense',
    );
    // Pass or fail comes only from the Judge. Anything the agent claims about it is ignored.
    const variants: TargetVariant[] = caseFile.safeVariant
      ? ['vulnerable', 'safe']
      : ['vulnerable'];
    const result = await judge.runWitness(caseFile, witness, variants);
    await ctx.record('exhibit-result', { result }, 'judge');
    if (result.admissible && result.passed) {
      await deps.workspace?.saveWitness(ctx.caseId, witness);
      await deps.workspace?.addExhibit(ctx.caseId, result.exhibitId);
      return { admitted: true, feedback };
    }

    feedback.push(`judge: ${describeRejection(result)}`);
  }
  return { admitted: false, feedback };
}
