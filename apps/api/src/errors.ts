import type { FastifyReply } from 'fastify';

/**
 * Every error body is `{ "error": <code> }` with a fixed code from this list. Nothing from the
 * request (ids, headers, body text, schema issues) is ever echoed back.
 */
export type ErrorCode =
  | 'bad-request'
  | 'invalid-id'
  | 'invalid-resume-position'
  | 'unauthenticated'
  | 'csrf-failed'
  | 'origin-not-allowed'
  | 'host-not-allowed'
  | 'not-found'
  | 'verdict-not-written'
  | 'tenant-not-provisioned'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'rate-limited'
  | 'too-many-streams'
  | 'bad-signature'
  | 'oauth-failed'
  | 'intake-not-implemented'
  | 'not-implemented'
  | 'webhooks-disabled'
  | 'internal';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/** The one body for a missing case and for another tenant's case. */
export const NOT_FOUND_BODY = { error: 'not-found' } as const;

export function sendError(reply: FastifyReply, status: number, code: ErrorCode): FastifyReply {
  return reply.code(status).type('application/json; charset=utf-8').send({ error: code });
}
