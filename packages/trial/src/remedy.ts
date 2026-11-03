import {
  isAccepted,
  type Budget,
  type CaseFile,
  type JudgePort,
  type PatchSubmission,
  type PromptRenderer,
  type TrialWorkspace,
  type VerifyResult,
} from './interim/types.js';
import type { StageHandler, StageResult } from './orchestrator.js';

export interface RemedyConfig {
  promptId: string;
  model: string;
  /** Agent turns. Schema failures and Judge rejections each use one. */
  maxIterations: number;
  maxTurns: number;
  turnBudget: Budget;
}

export interface RemedyDeps {
  loadCaseFile: (caseId: string) => Promise<CaseFile>;
  judge: JudgePort;
  render: PromptRenderer;
  workspace: TrialWorkspace;
  config: RemedyConfig;
}

function describe(result: VerifyResult): string {
  const rule = result.rejectedBy ?? 'not-accepted';
  const flags = [
    result.familyFlipped ? null : 'family not flipped',
    result.suitePassed ? null : 'suite failed',
    result.rescanClean ? null : 'rescan not clean',
    result.counterexamples.some((c) => c.survived) ? 'counterexample survived' : null,
  ].filter((f): f is string => f !== null);
  return `judge: ${rule}${flags.length ? ` [${flags.join(', ')}]` : ''}${result.detail ? ` (${result.detail})` : ''}`;
}

/**
 * Remedy writes a patch and submits it to the Judge's verifyPatch. Acceptance comes only
 * from the Judge result. The stage always moves on to verify, carrying the outcome in the
 * workspace, so a fix that cannot be proven becomes a not-proven verdict, not a crash.
 */
export function createRemedyHandler(deps: RemedyDeps): StageHandler {
  const { config, judge, render, workspace } = deps;

  return {
    async run(ctx): Promise<StageResult> {
      const caseFile = await deps.loadCaseFile(ctx.caseId);
      const witness = await workspace.getWitness(ctx.caseId);
      if (!witness) throw new Error(`no admitted witness for case ${ctx.caseId}`);

      const feedback: string[] = [];
      let last: { patch?: PatchSubmission; result?: VerifyResult; reason: string } = {
        reason: 'no patch was submitted',
      };

      for (let i = 0; i < config.maxIterations; i++) {
        const blocks = [
          { label: 'candidate', content: JSON.stringify(caseFile.candidate) },
          { label: 'witness', content: JSON.stringify(witness) },
          ...caseFile.slices.map((s) => ({
            label: 'case-file-slice',
            content: `file: ${s.file}\n${s.code}`,
          })),
        ];
        if (feedback.length > 0)
          blocks.push({ label: 'judge-feedback', content: feedback.join('\n') });

        const rendered = render(config.promptId, blocks);
        const res = await ctx.runAgentValidated({
          actor: 'remedy',
          promptId: rendered.promptId,
          promptVersion: rendered.version,
          model: config.model,
          system: rendered.system,
          user: rendered.user,
          tools: ['submit_patch'],
          outputSchemaRef: rendered.outputSchemaRef,
          maxTurns: config.maxTurns,
          budget: config.turnBudget,
        });

        if (res.outcome === 'no-submission') {
          last = { reason: 'no patch was submitted' };
          break;
        }
        if (res.outcome === 'inadmissible') {
          feedback.push(`schema: ${res.errors.join('; ')}`);
          last = { reason: `schema: ${res.errors.join('; ')}` };
          continue;
        }

        const patch = res.value as PatchSubmission;
        await ctx.record(
          'patch-submitted',
          { filesTouched: patch.filesTouched, linesChanged: patch.linesChanged },
          'remedy',
        );
        const result = await judge.verifyPatch(caseFile, patch, witness, []);

        if (isAccepted(result)) {
          await ctx.record('patch-verified', { accepted: true }, 'judge');
          await workspace.savePatchOutcome(ctx.caseId, { accepted: true, patch, result });
          if (result.patchExhibitId) await workspace.addExhibit(ctx.caseId, result.patchExhibitId);
          return { kind: 'advance', next: 'verify' };
        }

        const rule = result.rejectedBy ?? 'not-accepted';
        await ctx.record('patch-rejected', { rule, detail: result.detail ?? null }, 'judge');
        feedback.push(describe(result));
        last = { patch, result, reason: describe(result) };
      }

      await ctx.record('patch-verified', { accepted: false, reason: last.reason }, 'judge');
      await workspace.savePatchOutcome(ctx.caseId, { accepted: false, ...last });
      return { kind: 'advance', next: 'verify' };
    },
  };
}
