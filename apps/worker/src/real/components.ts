/**
 * Builds the real components from configuration. Wiring only: every class here is another lane's
 * (or Lane 1's discovery), constructed with the settings its own CLAUDE.md asks for.
 */
import { join } from 'node:path';
import type { ModelPort, RescanPort, ToolRunnerPort } from '@affidavit/contracts';
import { corpus } from '@affidavit/corpus';
import {
  DiscoveryRescan,
  arraignConfigFrom,
  discoverCase,
  loadToolManifest,
  repoRoot,
} from '@affidavit/discovery';
import { FsEvidenceStore } from '@affidavit/evidence';
import {
  createRealJudge,
  directorySources,
  type RealJudge,
  type RealJudgeConfig,
  type RealJudgeHostProbe,
  type SourceDirectory,
} from '@affidavit/judge';
import { SignerClient } from '@affidavit/signer';
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
 * Lane 1's `RescanPort` for the real Judge's `verifyPatch` (L1-17): the same scanner runner, rules
 * and work root as intake, so the patched tree is scanned exactly as the vulnerable one was.
 */
export function buildRescan(s: IntakeSettings, runner?: ToolRunnerPort): RescanPort {
  return new DiscoveryRescan({ runner: runner ?? buildToolRunner(s), workRoot: s.workRoot });
}

/**
 * Maps the worker's Judge settings onto Lane 2's `RealJudgeConfig` (field names in
 * docs/lanes/lane2/real-judge-host.md). Builds only plain objects: the evidence store and the
 * signer client open nothing until used. NodeGoat's trees and bundle are keyed by the corpus pin.
 * Without `rescan`, verifyPatch fails closed and createRealJudge reports it as a note.
 */
export function realJudgeConfig(s: JudgeSettings, rescan?: RescanPort): RealJudgeConfig {
  const nodegoat = corpus.apps.find((a) => a.id === 'nodegoat');
  const trees: SourceDirectory[] = [];
  if (nodegoat && s.nodegoatDir !== null) {
    trees.push({
      repo: nodegoat.repo,
      commit: nodegoat.pin.commit,
      variant: 'vulnerable',
      dir: s.nodegoatDir,
    });
  }
  if (nodegoat && s.nodegoatSafeDir !== null) {
    trees.push({
      repo: nodegoat.repo,
      commit: nodegoat.pin.commit,
      variant: 'safe',
      dir: s.nodegoatSafeDir,
    });
  }
  const bundles =
    nodegoat && s.nodegoatBundle !== null && s.dependencyBundleRoot !== null
      ? [
          {
            app: 'nodegoat',
            repo: nodegoat.repo,
            path: s.nodegoatBundle,
            storeRoot: s.dependencyBundleRoot,
          },
        ]
      : [];
  return {
    workRoot: s.workRoot,
    runnerImage: s.runnerImage,
    applyImage: s.applyImage,
    evidenceRoot: s.evidenceDir,
    // The jail is never given this path; it is held for bundle sealing.
    evidence: new FsEvidenceStore(s.evidenceDir),
    signerSocket: s.signerSocket,
    signer: new SignerClient(s.signerSocket),
    sources: directorySources(trees),
    dependencyBundles: bundles,
    sweepOrphans: s.sweepOrphans,
    ...(s.leaseDir === null ? {} : { leaseDir: s.leaseDir }),
    ...(rescan === undefined ? {} : { rescan }),
  };
}

/** Lane 2's real Judge (CR-11). Its own startup check runs first and lists what is missing. */
export function buildJudge(
  s: JudgeSettings,
  probe?: RealJudgeHostProbe,
  rescan?: RescanPort,
): Promise<RealJudge> {
  return createRealJudge(realJudgeConfig(s, rescan), probe === undefined ? {} : { probe });
}
/**
 * `createModelPortFromEnv` from @affidavit/trial: mode, model table and timeout fail at startup.
 * The port reads ANTHROPIC_API_KEY from `env` on every call, not from `process.env`: the entry
 * points move the key out of `process.env` (`sealSecrets`) so no child process inherits it.
 */
export function buildModel(env: Env, killSwitch: () => boolean | Promise<boolean>): ModelPort {
  return createModelPortFromEnv(env, { killSwitch, env: () => env });
}
