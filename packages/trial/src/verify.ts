import type { CaseStore, PromptId } from '@affidavit/contracts';
import type { StageHandler, StageResult } from './orchestrator.js';
import { buildVerdict, decideOutcome, finalizeVerdict } from './verdict.js';
import type { TrialWorkspace } from './workspace.js';

export interface VerifyDeps {
  store: CaseStore;
  workspace: TrialWorkspace;
  /** Which prompt versions and models actually ran, keyed by prompt id. */
  runInfo: {
    promptVersions: Partial<Record<PromptId, string>>;
    modelIds: Partial<Record<PromptId, string>>;
  };
}

/**
 * Final stage before the verdict. Reads what the Judge decided from the workspace, builds the
 * structured verdict, then the summary, appends it to the store, and moves to `verdict`. The jury
 * step is skipped here (the case store must be running with the jury disabled); the gate case
 * does not need it.
 */
export function createVerifyHandler(deps: VerifyDeps): StageHandler {
  const { store, workspace, runInfo } = deps;
  return {
    async run(ctx): Promise<StageResult> {
      const patch = await workspace.getPatchOutcome(ctx.caseId);
      const structured = buildVerdict({
        caseId: ctx.caseId,
        outcome: decideOutcome({ patchAccepted: patch?.accepted === true }),
        exhibits: await workspace.getExhibits(ctx.caseId),
        promptVersions: runInfo.promptVersions,
        modelIds: runInfo.modelIds,
        cost: ctx.costs(),
      });
      const verdict = finalizeVerdict(structured);
      await store.appendVerdict(verdict);
      await ctx.record('verdict-written', { verdict }, 'judge');
      return { kind: 'advance', next: 'verdict' };
    },
  };
}
