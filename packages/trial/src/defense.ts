import type {
  Budget,
  CaseFile,
  JudgePort,
  PromptRenderer,
  TrialWorkspace,
  WitnessSubmission,
} from './interim/types.js';
import type { StageContext, StageHandler, StageResult } from './orchestrator.js';

export interface DefenseAttemptConfig {
  promptId: string;
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
  loadCaseFile: (caseId: string) => Promise<CaseFile>;
  judge: JudgePort;
  render: PromptRenderer;
  config: DefenseConfig;
  /** Where an admitted witness is handed to later stages. */
  workspace?: TrialWorkspace;
}

interface AttemptOutcome {
  admitted: boolean;
  feedback: string[];
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
          { reason: 'no-admissible-witness-below-floor', candidateId: caseFile.candidate.id },
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
  const { config, judge, render } = deps;
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

    const rendered = render(which.promptId, blocks);
    const res = await ctx.runAgentValidated({
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
    });

    if (res.outcome === 'no-submission') {
      feedback.push('no witness was submitted');
      return { admitted: false, feedback };
    }
    if (res.outcome === 'inadmissible') {
      feedback.push(`schema: ${res.errors.join('; ')}`);
      continue;
    }

    const witness = res.value as WitnessSubmission;
    await ctx.record(
      'exhibit-submitted',
      { kind: 'witness', template: witness.template },
      'defense',
    );
    // Pass or fail comes only from the Judge. Anything the agent claims about it is ignored.
    const verdict = await judge.runWitness(caseFile, witness);
    await ctx.record(
      'exhibit-result',
      {
        exhibitId: verdict.exhibitId,
        admissible: verdict.admissible,
        passed: verdict.passed,
        rejectedBy: verdict.rejectedBy ?? null,
      },
      'judge',
    );
    if (verdict.admissible && verdict.passed) {
      await deps.workspace?.saveWitness(ctx.caseId, witness);
      await deps.workspace?.addExhibit(ctx.caseId, verdict.exhibitId);
      return { admitted: true, feedback };
    }

    feedback.push(
      `judge: ${verdict.rejectedBy ?? 'witness did not pass'}${verdict.detail ? ` (${verdict.detail})` : ''}`,
    );
  }
  return { admitted: false, feedback };
}
