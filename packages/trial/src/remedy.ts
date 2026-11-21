import type {
  Budget,
  CaseFileSource,
  Exhibit,
  ExhibitId,
  JudgePort,
  PromptId,
  VerifyResult,
} from '@affidavit/contracts';
import type { UntrustedBlock } from '@affidavit/prompts';
import { digestOf } from './canonical.js';
import { loadCaseFile, type PromptRenderer } from './defense.js';
import { SUBMISSIONS } from './envelope.js';
import type { StageHandler, StageResult } from './orchestrator.js';
import { buildPatchExhibit, describeVerify, isAccepted, rejectionRule } from './patch.js';
import type { PatchOutcome, TrialWorkspace } from './workspace.js';

export interface RemedyConfig {
  promptId: PromptId;
  model: string;
  /** Agent turns. Schema failures and Judge rejections each use one. */
  maxIterations: number;
  maxTurns: number;
  turnBudget: Budget;
}

export interface RemedyDeps {
  caseFiles: CaseFileSource;
  judge: JudgePort;
  render: PromptRenderer;
  workspace: TrialWorkspace;
  config: RemedyConfig;
  /**
   * Override for the counterexamples the patch must defeat. By default they are the admissible
   * ones Prosecution (L3-08) left in the workspace.
   */
  counterexamples?: (caseId: string) => Promise<readonly Exhibit[]>;
}

/**
 * Remedy writes a patch and submits it to the Judge's verifyPatch. Acceptance comes only from the
 * Judge result. The stage always moves on to verify, carrying the outcome in the workspace, so a
 * fix that cannot be proven becomes a proven-unfixed or not-proven verdict, not a crash.
 */
export function createRemedyHandler(deps: RemedyDeps): StageHandler {
  const { config, judge, render, workspace } = deps;

  return {
    async run(ctx): Promise<StageResult> {
      const caseFile = await loadCaseFile(deps.caseFiles, ctx.caseId);
      const admitted = await workspace.getWitness(ctx.caseId);
      if (!admitted) throw new Error(`no admitted witness for case ${ctx.caseId}`);
      const counterexamples =
        (await deps.counterexamples?.(ctx.caseId)) ??
        (await workspace.getCounterexamples(ctx.caseId)).map((c) => c.exhibit);

      const expectedIds = counterexamples.map((c) => c.id);
      const feedback: string[] = [];
      let last: Omit<PatchOutcome, 'verifyResults'> = {
        accepted: false,
        reason: 'no patch was submitted',
      };
      // One entry per verifyPatch call, so verify can record each as a `verify-result` event.
      const verifyResults: VerifyResult[] = [];

      for (let i = 0; i < config.maxIterations; i++) {
        const blocks: UntrustedBlock[] = [
          { label: 'candidate', content: JSON.stringify(caseFile.candidate) },
          {
            label: 'witness',
            content: JSON.stringify({
              template: admitted.witness.template,
              params: admitted.witness.params,
            }),
          },
          ...caseFile.slices.map((s) => ({
            label: 'case-file-slice',
            content: `file: ${s.file}\n${s.code}`,
          })),
        ];
        if (feedback.length > 0)
          blocks.push({ label: 'judge-feedback', content: feedback.join('\n') });

        const rendered = render(config.promptId, blocks);
        const res = await ctx.runAgentValidated(
          {
            promptId: rendered.promptId,
            promptVersion: rendered.version,
            model: config.model,
            system: rendered.system,
            user: rendered.user,
            tools: ['submit_patch'],
            outputSchemaRef: rendered.outputSchemaRef,
            maxTurns: config.maxTurns,
            budget: config.turnBudget,
          },
          SUBMISSIONS.remedy,
        );

        if (res.outcome === 'no-submission') {
          last = { accepted: false, reason: 'no patch was submitted' };
          break;
        }
        if (res.outcome === 'inadmissible') {
          feedback.push(`schema: ${res.errors.join('; ')}`);
          last = { accepted: false, reason: 'patch failed schema' };
          continue;
        }

        // Files touched and lines changed come from the diff, computed in code.
        let patch;
        try {
          patch = buildPatchExhibit(caseFile, res.value.diff);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          await ctx.record(
            'exhibit-inadmissible',
            { exhibitId: rejectedPatchId(res.result.submission), rejectedBy: 'schema' },
            'judge',
          );
          feedback.push(`schema: the diff could not be read as a patch (${why})`);
          last = { accepted: false, reason: 'patch diff could not be read' };
          continue;
        }

        await ctx.record('exhibit-submitted', { exhibitId: patch.id, kind: 'patch' }, 'remedy');
        const result = await judge.verifyPatch(caseFile, patch, admitted.witness, counterexamples);
        verifyResults.push(result);

        if (isAccepted(result, expectedIds)) {
          await workspace.addExhibit(ctx.caseId, patch.id);
          await workspace.savePatchOutcome(ctx.caseId, {
            accepted: true,
            patch,
            result,
            reason: 'accepted by the Judge',
            verifyResults,
          });
          return { kind: 'advance', next: 'verify' };
        }

        const rule = rejectionRule(result);
        if (rule) {
          await ctx.record(
            'exhibit-inadmissible',
            { exhibitId: patch.id, rejectedBy: rule },
            'judge',
          );
        }
        feedback.push(describeVerify(result, expectedIds));
        last = { accepted: false, patch, result, reason: describeVerify(result, expectedIds) };
      }

      await workspace.savePatchOutcome(ctx.caseId, { ...last, verifyResults });
      return { kind: 'advance', next: 'verify' };
    },
  };
}

function rejectedPatchId(submission: unknown): ExhibitId {
  return `exhibit-patch-rejected-${digestOf(submission).slice(0, 24)}` as ExhibitId;
}
