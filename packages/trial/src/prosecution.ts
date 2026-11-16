import type { Budget, CaseFileSource, ExhibitId, JudgePort, PromptId } from '@affidavit/contracts';
import type { UntrustedBlock } from '@affidavit/prompts';
import { digestOf } from './canonical.js';
import {
  DEFAULT_PARAM_LIMITS,
  buildCounterexample,
  resolveCounterexample,
  type ParamLimits,
} from './counterexample.js';
import { loadCaseFile, type PromptRenderer } from './defense.js';
import { SUBMISSIONS } from './envelope.js';
import type { StageHandler, StageResult } from './orchestrator.js';
import type { TrialWorkspace } from './workspace.js';

export interface ProsecutionConfig {
  promptId: PromptId;
  model: string;
  /** Agent turns, so at most this many counterexamples. Rejected ones use a turn too. */
  maxCounterexamples: number;
  maxTurns: number;
  turnBudget: Budget;
  limits?: ParamLimits;
}

export interface ProsecutionDeps {
  caseFiles: CaseFileSource;
  judge: JudgePort;
  render: PromptRenderer;
  workspace: TrialWorkspace;
  config: ProsecutionConfig;
}

/**
 * Prosecution attacks with exhibits only. Its one tool picks parameters from the Defense witness
 * family; the counterexample Exhibit is built in code (see counterexample.ts) and run through
 * `JudgePort.runCounterexample`. Admissible ones are left in the workspace for Remedy, whose
 * `verifyPatch` decides whether any of them survives the fix. Prose with no exhibit, and
 * parameters outside the family, are recorded as inadmissible (`schema`) and never run. A
 * rejected submission is not retried: the agent gets a later turn, with the reason, to submit a
 * different counterexample.
 *
 * The stage always moves to remedy. Whether a counterexample defeats a patch is known only after
 * the patch exists (verify), and `STAGE_TRANSITIONS` has no stage that loops back to Prosecution.
 */
export function createProsecutionHandler(deps: ProsecutionDeps): StageHandler {
  const { config, judge, render, workspace } = deps;
  const limits = config.limits ?? DEFAULT_PARAM_LIMITS;

  return {
    async run(ctx): Promise<StageResult> {
      const caseFile = await loadCaseFile(deps.caseFiles, ctx.caseId);
      const admitted = await workspace.getWitness(ctx.caseId);
      if (!admitted) throw new Error(`no admitted witness for case ${ctx.caseId}`);
      const family = admitted.witness;

      const tried = new Set<ExhibitId>();
      const notes: string[] = [];

      for (let i = 0; i < config.maxCounterexamples; i++) {
        const blocks: UntrustedBlock[] = [
          { label: 'candidate', content: JSON.stringify(caseFile.candidate) },
          {
            label: 'witness',
            content: JSON.stringify({ template: family.template, params: family.params }),
          },
          {
            label: 'judge-results',
            content: JSON.stringify({
              witnessExhibitId: admitted.result.exhibitId,
              admissible: admitted.result.admissible,
              safeVariantFail: admitted.result.safeVariantFail ?? null,
              familyResults: admitted.result.familyResults ?? [],
            }),
          },
          ...caseFile.slices.map((s) => ({
            label: 'case-file-slice',
            content: `file: ${s.file}\n${s.code}`,
          })),
        ];
        if (notes.length > 0) {
          blocks.push({ label: 'prior-counterexamples', content: notes.join('\n') });
        }

        const rendered = render(config.promptId, blocks);
        const res = await ctx.runAgentValidated(
          {
            promptId: rendered.promptId,
            promptVersion: rendered.version,
            model: config.model,
            system: rendered.system,
            user: rendered.user,
            tools: ['submit_counterexample'],
            outputSchemaRef: rendered.outputSchemaRef,
            maxTurns: config.maxTurns,
            budget: config.turnBudget,
          },
          SUBMISSIONS.prosecution,
        );

        if (res.outcome === 'no-submission') break;
        if (res.outcome === 'inadmissible') {
          // Already recorded as exhibit-inadmissible (schema): prose with no exhibit lands here.
          notes.push(`inadmissible (schema): ${res.errors.join('; ')}`);
          continue;
        }

        const resolved = resolveCounterexample(family.params, res.value, limits);
        if (!resolved.ok) {
          const exhibitId =
            `exhibit-counterexample-rejected-${digestOf({ caseId: ctx.caseId, stage: ctx.stage, attempt: ctx.attempt, submission: res.result.submission }).slice(0, 24)}` as ExhibitId;
          await ctx.record('exhibit-inadmissible', { exhibitId, rejectedBy: 'schema' }, 'judge');
          notes.push(`inadmissible (schema): ${resolved.errors.join('; ')}`);
          continue;
        }

        // Code, id, hash, author and kind are built here, never taken from the agent.
        const built = buildCounterexample(caseFile, family, resolved.params);
        if (tried.has(built.exhibit.id)) {
          notes.push(`already submitted: ${built.exhibit.id}; choose different parameters`);
          continue;
        }
        tried.add(built.exhibit.id);
        await ctx.record(
          'exhibit-submitted',
          { exhibitId: built.exhibit.id, kind: 'counterexample' },
          'prosecution',
        );
        // Pass or fail comes only from the Judge.
        const result = await judge.runCounterexample(caseFile, built.witness, built.exhibit);
        await ctx.record('exhibit-result', { result }, 'judge');
        if (!result.admissible) {
          if (result.rejectedBy) {
            await ctx.record(
              'exhibit-inadmissible',
              { exhibitId: result.exhibitId, rejectedBy: result.rejectedBy },
              'judge',
            );
          }
          notes.push(
            `judge: ${built.exhibit.id} inadmissible (${result.rejectedBy ?? 'not admitted'})`,
          );
          continue;
        }

        await workspace.addCounterexample(ctx.caseId, { exhibit: built.exhibit, result });
        await workspace.addExhibit(ctx.caseId, result.exhibitId);
        await ctx.record(
          'objection',
          {
            exhibitId: result.exhibitId,
            claim: `The fix must also stop this counterexample family: ${resolved.params
              .map((p) => `${p.name} has ${p.values.length} values`)
              .join(', ')}; ${resolved.newValues} not used by the Defense witness.`,
          },
          'prosecution',
        );
        notes.push(`judge: ${result.exhibitId} admissible`);
      }

      return { kind: 'advance', next: 'remedy' };
    },
  };
}
