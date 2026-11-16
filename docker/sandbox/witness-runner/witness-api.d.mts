/** What a witness is given besides its parameters. */
export interface WitnessContext {
  /** The target on the case network, or null when the run has no target. */
  target: { url: string } | null;
}

/**
 * Declares the witness family. `fn` runs once per combination of the ParamSpace, each as its own
 * Vitest test; use `expect` from 'vitest' to assert. Call it exactly once.
 */
export function witness<P extends Record<string, unknown>>(
  fn: (params: P, ctx: WitnessContext) => void | Promise<void>,
): void;
