import {
  Witness,
  type CaseFile,
  type ExhibitId,
  type ParamSpace,
  type TargetVariant,
  type WitnessId,
} from '@affidavit/contracts';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { WitnessSubmission } from './envelope.js';

/** `Witness.sha256`: hash of the canonical JSON of `{ params, template }`. */
export function witnessSha256(template: string, params: ParamSpace): string {
  return sha256Hex(canonicalJson({ params, template }));
}

/**
 * The exhibit id the Judge mints for a witness, recomputed with the recipe in
 * docs/lanes/lane2/rules-of-evidence.md ("Exhibit ids"). Used to name the exhibit when it is
 * submitted; the Judge's own `ExhibitResult.exhibitId` is what gets cited.
 */
export function witnessExhibitId(
  caseId: CaseFile['id'],
  template: string,
  params: ParamSpace,
): ExhibitId {
  const digest = sha256Hex(canonicalJson({ caseId, kind: 'witness', params, template }));
  return `exhibit-witness-${digest.slice(0, 24)}` as ExhibitId;
}

/**
 * Builds the contract Witness around a validated submission. Every field the system owns (id,
 * case, class, author, hash, schema version) is set here, never taken from the agent.
 */
export function buildWitness(caseFile: CaseFile, submission: WitnessSubmission): Witness {
  const sha256 = witnessSha256(submission.template, submission.params);
  const id = `witness-${sha256Hex(canonicalJson({ caseId: caseFile.id, sha256 })).slice(0, 24)}`;
  return Witness.parse({
    schemaVersion: 1,
    id: id as WitnessId,
    caseId: caseFile.id,
    cls: caseFile.candidate.cls,
    template: submission.template,
    params: submission.params,
    author: 'defense',
    sha256,
  });
}

/** Differential proof (F2): run the safe variant whenever the case file has one. */
export function variantsFor(caseFile: CaseFile): readonly TargetVariant[] {
  return caseFile.safeVariant ? ['vulnerable', 'safe'] : ['vulnerable'];
}
