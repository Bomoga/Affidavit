import {
  ExhibitId,
  type AdmissibilityRule,
  type Budget,
  type PromptId,
  type CaseFileSource,
  type CaseId,
  type JudgePort,
  type PatchExhibit,
  type VerifyResult,
} from '@affidavit/contracts';
import { canonicalJson, sha256Hex } from './canonical.js';
import { loadCaseFile, type PromptRenderer } from './defense.js';
import { SUBMISSIONS } from './envelope.js';
import type { StageHandler, StageResult } from './orchestrator.js';
import type { TrialWorkspace } from './workspace.js';

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
}

/**
 * Builds the contract PatchExhibit around a submitted diff. Files touched and lines changed are
 * computed here from the diff, never taken from the agent. Returns undefined when the diff names
 * no file or changes no line, which the contract does not allow.
 */
export function buildPatchExhibit(caseId: CaseId, diff: string): PatchExhibit | undefined {
  const files = new Set<string>();
  let linesChanged = 0;
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ (?:b\/)?(\S+)/.exec(line);
    if (header) {
      if (header[1] !== '/dev/null') files.add(header[1]!);
    } else if (/^--- /.test(line)) {
      continue;
    } else if (line.startsWith('+') || line.startsWith('-')) {
      linesChanged += 1;
    }
  }
  if (files.size === 0 || linesChanged === 0) return undefined;

  const sha256 = sha256Hex(canonicalJson({ caseId, kind: 'patch', diff }));
  return {
    schemaVersion: 1,
    id: ExhibitId.parse(`exhibit-patch-${sha256.slice(0, 24)}`),
    caseId,
    author: 'remedy',
    kind: 'patch',
    code: diff,
    sha256,
    diff,
    filesTouched: [...files],
    linesChanged,
  };
}

export function isAccepted(r: VerifyResult): boolean {
  return (
    r.rejectedBy === undefined &&
    r.familyFlipped &&
    r.suitePassed &&
    r.rescanClean &&
    r.counterexamples.every((c) => !c.survived)
  );
}

function describeVerify(r: VerifyResult): string {
  const flags = [
    r.familyFlipped ? null : 'witness family not flipped',
    r.suitePassed ? null : 'test suite failed',
    r.rescanClean ? null : 'rescan not clean',
    r.counterexamples.some((c) => c.survived) ? 'a counterexample survived' : null,
  ].filter((f): f is string => f !== null);
  return `judge: ${r.rejectedBy ?? 'not accepted'}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

/**
 * Remedy writes a patch and submits it to the Judge's verifyPatch. Acceptance comes only from the
 * Judge's result. The stage always moves on to verify, carrying the outcome in the workspace, so
 * a fix that cannot be proven becomes a verdict, not a crash.
 */
export function createRemedyHandler(deps: RemedyDeps): StageHandler {
  const { config, judge, render, workspace } = deps;

  return {
    async run(ctx): Promise<StageResult> {
      const caseFile = await loadCaseFile(deps.caseFiles, ctx.caseId);
      const admitted = await workspace.getWitness(ctx.caseId);
      if (!admitted) throw new Error(`no admitted witness for case ${ctx.caseId}`);
      const witness = admitted.witness;

      const feedback: string[] = [];
      let last: { patch?: PatchExhibit; result?: VerifyResult; reason: string } = {
        reason: 'no patch was submitted',
      };

      for (let i = 0; i < config.maxIterations; i++) {
        const blocks = [
          { label: 'candidate', content: JSON.stringify(caseFile.candidate) },
          {
            label: 'witness',
            content: JSON.stringify({ template: witness.template, params: witness.params }),
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
          },
          SUBMISSIONS.remedy,
        );

        if (res.outcome === 'no-submission') {
          last = { reason: 'no patch was submitted' };
          break;
        }
        if (res.outcome === 'inadmissible') {
          const reason = `schema: ${res.errors.join('; ')}`;
          feedback.push(reason);
          last = { reason };
          continue;
        }

        const patch = buildPatchExhibit(ctx.caseId, res.value.diff);
        if (!patch) {
          const reason = 'schema: the diff names no file or changes no line';
          feedback.push(reason);
          last = { reason };
          continue;
        }

        await ctx.record('exhibit-submitted', { exhibitId: patch.id, kind: 'patch' }, 'remedy');
        // The Judge decides. Counterexamples join once Prosecution exists (L3-08).
        const result = await judge.verifyPatch(caseFile, patch, witness, []);

        if (isAccepted(result)) {
          await workspace.addExhibit(ctx.caseId, result.patchExhibitId);
          await workspace.savePatchOutcome(ctx.caseId, { accepted: true, patch, result });
          if (result.patchExhibitId) await workspace.addExhibit(ctx.caseId, result.patchExhibitId);
          return { kind: 'advance', next: 'verify' };
        }

        const rule: AdmissibilityRule | undefined = result.rejectedBy;
        if (rule) {
          await ctx.record(
            'exhibit-inadmissible',
            { exhibitId: result.patchExhibitId, rejectedBy: rule },
            'judge',
          );
        }
        feedback.push(describeVerify(result));
        last = { patch, result, reason: describeVerify(result) };
      }

      await workspace.savePatchOutcome(ctx.caseId, { accepted: false, ...last });
      return { kind: 'advance', next: 'verify' };
    },
  };
}
