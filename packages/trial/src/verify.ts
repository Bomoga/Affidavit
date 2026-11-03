import type { CaseStore, TrialWorkspace } from './interim/types.js';
import type { StageHandler, StageResult } from './orchestrator.js';
import { buildVerdict, decideOutcome, finalizeVerdict } from './verdict.js';

export interface VerifyDeps {
  store: CaseStore;
  workspace: TrialWorkspace;
  /** Which prompt versions and models actually ran, keyed by prompt id. */
  runInfo: {
    promptVersions: Record<string, string>;
    modelIds: Record<string, string>;
  };
}

/**
 * Final stage before the verdict. Reads what the Judge decided from the workspace, builds
 * the structured verdict, then the summary, saves it, and moves to `verdict`. The jury step
 * is skipped here; the gate case does not need it.
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
        cost: await store.getCosts(ctx.caseId),
      });
      const verdict = finalizeVerdict(structured);
      await workspace.saveVerdict(ctx.caseId, verdict);
      await ctx.record('verdict-written', { outcome: verdict.outcome }, 'judge');
      return { kind: 'advance', next: 'verdict' };
    },
  };
}
