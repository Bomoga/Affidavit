import type { CaseStore, ExhibitId } from '@affidavit/contracts';
import type { StageHandler, StageResult } from './orchestrator.js';
import { buildVerdict, decideOutcome, finalizeVerdict } from './verdict.js';
import type { PatchOutcome, TrialWorkspace } from './workspace.js';

/**
 * Seam for L3-09 (Appeals). Ids of admitted counterexamples that survived the patch, from the
 * Judge's VerifyResult. Today a defeated patch goes straight to a `proven-unfixed` verdict (the
 * legal verify to verdict move). L3-09 will, while appeals remain, send verify to remedy with
 * the first of these, record an `appeal` event naming it, and charge the budget per round.
 */
export function survivingCounterexamples(outcome: PatchOutcome | undefined): ExhibitId[] {
  return (outcome?.result?.counterexamples ?? []).filter((c) => c.survived).map((c) => c.exhibitId);
}

export interface VerifyDeps {
  store: CaseStore;
  workspace: TrialWorkspace;
  /**
   * The jury (L3-11) is not built yet, so verify writes the verdict and moves straight to
   * `verdict`. `STAGE_TRANSITIONS` allows verify to verdict only when the jury is disabled
   * (CR-3: exhausted appeals no longer skip an enabled jury), so the CaseStore this runs against must be wired with the jury
   * disabled: `new FakeCaseStore({ juryEnabled: false })` in tests, and the same setting on the
   * Postgres store in apps/worker. With the jury enabled the transition is refused by the store.
   */
  jury: 'disabled';
}

/**
 * Final stage before the verdict. First records one `verify-result` event (actor `judge`) per
 * `verifyPatch` call Remedy made, carrying the Judge's VerifyResult as returned (CR-1), so a
 * client reading only the stream sees the Judge's check and not just the verdict's claim. Then it
 * reads what the Judge decided from the workspace, builds the structured verdict, then the
 * summary, appends it through `CaseStore.appendVerdict`, emits `verdict-written`, and moves to
 * `verdict`.
 *
 * No proven outcome without an admitted witness exhibit: if the workspace has none (or the
 * Judge's result for it is not admitted), the case escalates to a human instead.
 */
export function createVerifyHandler(deps: VerifyDeps): StageHandler {
  const { store, workspace } = deps;
  return {
    async run(ctx): Promise<StageResult> {
      const patch = await workspace.getPatchOutcome(ctx.caseId);
      for (const result of patch?.verifyResults ?? []) {
        await ctx.record('verify-result', { result }, 'judge');
      }

      const exhibits = await workspace.getExhibits(ctx.caseId);
      const admitted = await workspace.getWitness(ctx.caseId);
      if (
        !admitted ||
        !admitted.result.admissible ||
        !admitted.result.passed ||
        !exhibits.includes(admitted.result.exhibitId)
      ) {
        return {
          kind: 'escalate',
          reason: 'no-admissible-witness-above-floor',
          detail:
            'verify was reached without an admitted witness exhibit, so no proven outcome can be written',
        };
      }

      const patchAccepted =
        patch?.accepted === true && patch.patch !== undefined && exhibits.includes(patch.patch.id);
      const { promptVersions, modelIds } = ctx.runInfo();
      const verdict = finalizeVerdict(
        buildVerdict({
          caseId: ctx.caseId,
          outcome: decideOutcome({ patchAccepted }),
          exhibits,
          promptVersions,
          modelIds,
          cost: ctx.costs(),
        }),
      );
      await store.appendVerdict(verdict);
      await ctx.record('verdict-written', { verdict }, 'stenographer');
      return { kind: 'advance', next: 'verdict' };
    },
  };
}
