/**
 * Builds the real components from configuration. Wiring only: every class here is another lane's
 * (or Lane 1's discovery), constructed with the settings its own CLAUDE.md asks for.
 */
import { join } from 'node:path';
import type { EvidenceStore, JudgePort, ModelPort, ToolRunnerPort } from '@affidavit/contracts';
import { corpus } from '@affidavit/corpus';
import { arraignConfigFrom, discoverCase, loadToolManifest, repoRoot } from '@affidavit/discovery';
import { FsEvidenceStore } from '@affidavit/evidence';
import { BootedTargets, DEFAULT_POLICY, JailExecutor, Judge } from '@affidavit/judge';
import { GvisorToolRunner } from '@affidavit/sandbox';
import { LocalDockerToolRunner } from '@affidavit/testing';
import { createModelPortFromEnv } from '@affidavit/trial';
import type { Env, IntakeSettings, JudgeSettings } from '../config.js';
import type { Discover } from './intake.js';

/** Scanners through ToolRunnerPort: Lane 2's gVisor runner, or plain local Docker. */
export function buildToolRunner(s: IntakeSettings): ToolRunnerPort {
  if (s.toolRunner === 'docker') return new LocalDockerToolRunner(s.workRoot);
  const images = loadToolManifest()
    .tools.map((t) => t.image)
    .filter((i): i is string => i !== null);
  return new GvisorToolRunner({
    outputDir: s.workRoot,
    // Workspaces, our Semgrep rules and our tool configs: nothing else can be mounted.
    allowedRoots: [
      s.workRoot,
      join(repoRoot(), 'packages', 'discovery', 'rules'),
      join(repoRoot(), 'docker', 'tools', 'config'),
    ],
    imageAllowlist: images,
    timeoutMs: s.toolTimeoutMs,
  });
}

export function buildDiscover(s: IntakeSettings, env: Env, runner?: ToolRunnerPort): Discover {
  const deps = {
    runner: runner ?? buildToolRunner(s),
    workRoot: s.workRoot,
    // AFFIDAVIT_ESCALATION_FLOOR and AFFIDAVIT_DISMISS_BELOW, validated now.
    arraignConfig: arraignConfigFrom(env),
    corpus: corpus.apps,
    allowLocalSource: s.allowLocalSource,
  };
  return (input) => discoverCase(deps, input);
}

/**
 * Lane 2's Judge on the gVisor witness jail. The executor's targets are `BootedTargets`, which
 * refuses to run a witness for a variant it has not booted (never a run with no target, which
 * would fail and look like evidence). Nothing boots a case's targets yet, and a discovery case
 * file names no `imageDigest`, so today every witness fails closed with an infrastructure error;
 * see docs/lanes/lane1/real-wiring.md, "What still blocks a real verdict". `verifyPatch` needs a
 * PatchWorkbench and a RescanPort, which are not wired either, so it fails closed the same way.
 */
export function buildJudge(s: JudgeSettings): { judge: JudgePort; evidence: EvidenceStore } {
  const targets = new BootedTargets();
  const executor = new JailExecutor({ workRoot: s.workRoot, runnerImage: s.runnerImage, targets });
  return {
    judge: new Judge(executor, DEFAULT_POLICY),
    // Held for bundle sealing; no stage seals a bundle yet. The jail is never given this path.
    evidence: new FsEvidenceStore(s.evidenceDir),
  };
}

/** `createModelPortFromEnv` from @affidavit/trial: mode, model table and timeout fail at startup. */
export function buildModel(env: Env, killSwitch: () => boolean | Promise<boolean>): ModelPort {
  return createModelPortFromEnv(env, { killSwitch });
}
