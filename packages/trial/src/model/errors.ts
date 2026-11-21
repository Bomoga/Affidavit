import type { StageCost } from '@affidavit/contracts';

/**
 * Typed errors of the Anthropic model port. None of them ever carries the API key: every message
 * is built from fixed text plus values that went through `redact` first.
 */

/**
 * The model port cannot run a live call because it has no API key (or the provider rejected the
 * credential). The orchestrator treats it like the kill switch: the case halts at its stage, no
 * budget is charged for the call, nothing escalates, and an operator can resume it once a key is
 * configured.
 */
export class ModelUnconfiguredError extends Error {
  readonly code = 'model-unconfigured' as const;
  constructor(readonly detail: string) {
    super(`model port is not configured: ${detail}`);
    this.name = 'ModelUnconfiguredError';
  }
}

/**
 * A model call was refused by configuration before any spend: an unknown model id, a model that
 * does not match the table for its prompt, a prompt that is not the packaged one, or a tool list
 * that is not the role's allowlist. It is a deployment bug, so it fails the job loudly.
 */
export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

/**
 * A live call failed for a reason that says nothing about the case (provider error, crashed
 * agent process). It is never turned into "no submission", because a Defense with no submission
 * can end in a dismissal, and an outage must not dismiss a candidate (F3). The job fails and the
 * stage is retried by the queue, which charges the budget again first.
 */
export class ModelCallError extends Error {
  /**
   * What the failed call spent, when the runtime reported it (a result arrived, or the provider
   * refused the request before producing any tokens). Undefined when the spend is unknown (a
   * timeout, an abort, a broken stream): then the orchestrator's up-front charge stands.
   */
  readonly cost: StageCost | undefined;
  /** The sanitized provider failure, when there was one. Already in `message`. */
  readonly provider: ProviderFailure | undefined;

  constructor(message: string, extra: { cost?: StageCost; provider?: ProviderFailure } = {}) {
    super(message);
    this.name = 'ModelCallError';
    this.cost = extra.cost;
    this.provider = extra.provider;
  }
}

/**
 * A provider failure as the port reports it. Every field is sanitized: `errorClass` comes from
 * the runtime's closed snake_case set, `status` is an integer, and `message` was redacted whole
 * (credentials), checked for request content, and only then clipped. Never the request body.
 */
export interface ProviderFailure {
  errorClass: string;
  status?: number;
  message?: string;
}

/**
 * Replay found a recording marked `redacted: true`: its submission was altered after the agent
 * sent it, so it is not what was submitted and must never reach the Judge. A call error, so it
 * cannot read as "no submission".
 */
export class JudgeIneligibleRecordingError extends ModelCallError {
  constructor(
    readonly promptId: string,
    readonly inputSha256: string,
  ) {
    super(
      `recording for prompt ${promptId} input ${inputSha256} is redacted and not eligible for the Judge`,
    );
    this.name = 'JudgeIneligibleRecordingError';
  }
}

/** Replay mode found no recording for a request. Fails closed: replay never calls a model. */
export class NoModelRecordingError extends Error {
  constructor(
    readonly promptId: string,
    readonly inputSha256: string,
  ) {
    super(`no recorded model output for prompt ${promptId} input ${inputSha256}`);
    this.name = 'NoModelRecordingError';
  }
}
