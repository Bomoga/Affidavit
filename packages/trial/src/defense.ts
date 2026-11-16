import {
  Dismissal,
  type Budget,
  type CaseFile,
  type CaseFileSource,
  type CaseId,
  type ExhibitResult,
  type JudgePort,
  type PromptId,
} from '@affidavit/contracts';
import type { RenderedPrompt, UntrustedBlock } from '@affidavit/prompts';
import { SUBMISSIONS } from './envelope.js';
import type { StageContext, StageHandler, StageResult } from './orchestrator.js';
import { buildWitness, variantsFor, witnessExhibitId } from './witness.js';
import type { TrialWorkspace } from './workspace.js';

/** Same signature as `renderPrompt` in @affidavit/prompts; injected so tests can wrap it. */
export type PromptRenderer = (id: PromptId, blocks: readonly UntrustedBlock[]) => RenderedPrompt;

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
  caseFiles: CaseFileSource;
  judge: JudgePort;
  render: PromptRenderer;
  config: DefenseConfig;
  /** Where an admitted witness is handed to later stages. */
  workspace: TrialWorkspace;
}

interface AttemptOutcome {
  admitted: boolean;
  feedback: string[];
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

      const first = await attempt(ctx, deps, caseFile, config.first, []);
      if (first.admitted) return { kind: 'advance', next: 'prosecution' };

      if (caseFile.candidate.score < caseFile.escalationFloor) {
        const dismissal = Dismissal.parse({
          schemaVersion: 1,
          candidateId: caseFile.candidate.id,
          reason: 'no-admissible-witness-below-floor',
          detail: `candidate scored ${caseFile.candidate.score}, below the escalation floor ${caseFile.escalationFloor}; no admissible witness`,
        });
        await ctx.record('dismissed', { dismissal }, 'defense');
        return { kind: 'advance', next: 'dismissed' };
      }

      // Above the floor (F3): never dismiss on one attempt. Try again with a different
      // model and prompt, then hand it to a human.
      const second = await attempt(ctx, deps, caseFile, config.second, first.feedback);
      if (second.admitted) return { kind: 'advance', next: 'prosecution' };

      return {
        kind: 'escalate',
        reason: 'no-admissible-witness-above-floor',
        detail: `candidate ${caseFile.candidate.id} scored ${caseFile.candidate.score}, at or above the floor ${caseFile.escalationFloor}; two Defense attempts produced no admissible witness`,
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
    // All case-file and Judge text goes in as labeled blocks. The renderer puts them in the
    // user message inside the untrusted wrapper. Nothing here builds system text.
    const blocks: UntrustedBlock[] = [
      { label: 'candidate', content: JSON.stringify(caseFile.candidate) },
      ...caseFile.slices.map((s) => ({
        label: 'case-file-slice',
        content: `file: ${s.file}\n${s.code}`,
      })),
    ];
    const notes = [...priorFeedback, ...feedback];
    if (notes.length > 0) blocks.push({ label: 'judge-feedback', content: notes.join('\n') });

    const rendered = render(which.promptId, blocks);
    const res = await ctx.runAgentValidated(
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

    if (res.outcome === 'no-submission') {
      feedback.push('no witness was submitted');
      return { admitted: false, feedback };
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
      return { admitted: true, feedback };
    }

    feedback.push(
      `judge: ${result.rejectedBy ?? (caseFile.safeVariant && result.safeVariantFail !== true ? 'differential' : 'witness did not pass')}`,
    );
  }
  return { admitted: false, feedback };
}
