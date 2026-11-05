// Prompt-package types only. Contract objects (Role, Witness, Ballot, ...) live in
// @affidavit/contracts and are referenced here by name, never redefined.
// TODO(P0-03): once contracts v1.0 lands, type `role` as the contracts `Role` subset
// and check `outputSchemaRef` against the exported schema names.

export type PromptRole = 'defense' | 'prosecution' | 'remedy' | 'juror';

export type PromptId =
  | 'defense'
  | 'defense-second-attempt'
  | 'prosecution'
  | 'remedy'
  | 'juror-security'
  | 'juror-maintainability'
  | 'juror-blast-radius';

export interface PromptDefinition {
  readonly id: PromptId;
  readonly role: PromptRole;
  /** Semver. Bump on any change to `system`, `role`, or `outputSchemaRef`. */
  readonly version: string;
  /** Static text. Never interpolated with case-file or app content. */
  readonly system: string;
  /** Name of the contracts schema the agent's submit tool validates against. */
  readonly outputSchemaRef: string;
}

export interface UntrustedBlock {
  readonly label: string;
  readonly content: string;
}
