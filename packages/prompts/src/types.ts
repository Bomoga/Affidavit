// Prompt-package types only. Contract objects (Role, PromptId, Witness, Ballot, ...) live in
// @affidavit/contracts and are imported from there, never redefined.
import type { PromptId, Role } from '@affidavit/contracts';

export type { PromptId };

/** The contract roles that run a prompt. Judge and stenographer are code, not agents. */
export type PromptRole = Extract<Role, 'defense' | 'prosecution' | 'remedy' | 'juror'>;

export interface PromptDefinition {
  readonly id: PromptId;
  readonly role: PromptRole;
  /** Semver. Bump on any change to `system`, `role`, or `outputSchemaRef`. */
  readonly version: string;
  /** Static text. Never interpolated with case-file or app content. */
  readonly system: string;
  /** Key in the contracts `schemaRegistry` that the agent's submit tool validates against. */
  readonly outputSchemaRef: string;
}

export interface UntrustedBlock {
  readonly label: string;
  readonly content: string;
}
