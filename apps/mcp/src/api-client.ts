import { ApiRoutes, type CaseId, type Verdict } from '@affidavit/contracts';

type Parsed<S extends { parse: (v: unknown) => unknown }> = ReturnType<S['parse']>;

export type CreateCaseRequest = Parsed<typeof ApiRoutes.createCase.request>;
export type CreateCaseResponse = Parsed<typeof ApiRoutes.createCase.response>;
export type GetCaseResponse = Parsed<typeof ApiRoutes.getCase.response>;
export type GetBundleResponse = Parsed<typeof ApiRoutes.getBundle.response>;

/** The only surface the MCP server needs from the Affidavit API. Every result is schema-parsed. */
export interface AffidavitApi {
  createCase(request: CreateCaseRequest): Promise<CreateCaseResponse>;
  getCase(caseId: CaseId): Promise<GetCaseResponse>;
  getVerdict(caseId: CaseId): Promise<Verdict>;
  getBundle(sha256: string): Promise<GetBundleResponse>;
}

/** The API answered with a non-2xx status or the request failed. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The API answered 2xx but the body did not match the contract schema. */
export class ApiSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiSchemaError';
  }
}

/** Ids go into URL paths. Anything outside this set (dots, slashes, percent) is refused. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpApiConfig {
  baseUrl: string;
  /** Optional bearer token, supplied by the caller from its environment. Never hard-coded. */
  token?: string;
  /** Per-request timeout in milliseconds. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Reads AFFIDAVIT_API_URL (required), AFFIDAVIT_API_TOKEN (optional) and AFFIDAVIT_API_TIMEOUT_MS
 * (optional). The URL must be https, except for localhost and 127.0.0.1, and carry no credentials.
 */
export function configFromEnv(env: Record<string, string | undefined>): HttpApiConfig {
  const raw = env['AFFIDAVIT_API_URL'];
  if (!raw) throw new Error('AFFIDAVIT_API_URL is not set');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AFFIDAVIT_API_URL is not a valid URL');
  }
  if (url.username || url.password) {
    throw new Error('AFFIDAVIT_API_URL must not contain embedded credentials');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('AFFIDAVIT_API_URL must use https (http is allowed only for localhost)');
  }
  const config: HttpApiConfig = { baseUrl: raw };
  const token = env['AFFIDAVIT_API_TOKEN'];
  if (token) config.token = token;
  const timeout = env['AFFIDAVIT_API_TIMEOUT_MS'];
  if (timeout !== undefined && timeout !== '') {
    const ms = Number(timeout);
    if (!Number.isInteger(ms) || ms <= 0) {
      throw new Error('AFFIDAVIT_API_TIMEOUT_MS must be a positive integer');
    }
    config.timeoutMs = ms;
  }
  return config;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
}

/** Thin fetch wrapper. Every response body is parsed with its contract schema. */
export function createHttpApi(config: HttpApiConfig): AffidavitApi {
  const doFetch = config.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function safeId(id: string): string {
    if (!SAFE_ID.test(id)) throw new ApiError('refusing to build a request path from an unsafe id');
    return id;
  }

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: { parse: (v: unknown) => T },
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.token) headers['authorization'] = `Bearer ${config.token}`;
    const init: RequestInit = {
      method,
      headers,
      // Never follow a redirect: it could forward the bearer token to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new ApiError(`${method} ${path} timed out after ${timeoutMs} ms`);
      }
      throw new ApiError(`request to ${method} ${path} failed: ${errorText(err)}`);
    }
    if (!res.ok) throw new ApiError(`${method} ${path} returned HTTP ${res.status}`, res.status);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiSchemaError(`${method} ${path} returned a body that is not JSON`);
    }
    try {
      return schema.parse(json);
    } catch (err) {
      throw new ApiSchemaError(
        `${method} ${path} returned a body that does not match the contract: ${errorText(err)}`,
      );
    }
  }

  return {
    createCase: async (request) => {
      const created = await call(
        'POST',
        '/cases',
        ApiRoutes.createCase.response,
        ApiRoutes.createCase.request.parse(request),
      );
      if (!SAFE_ID.test(created.caseId)) {
        throw new ApiSchemaError('POST /cases returned a caseId with unsafe characters');
      }
      return created;
    },
    getCase: async (caseId) =>
      await call('GET', `/cases/${safeId(caseId)}`, ApiRoutes.getCase.response),
    getVerdict: async (caseId) =>
      await call('GET', `/cases/${safeId(caseId)}/verdict`, ApiRoutes.getVerdict.response),
    getBundle: async (sha256) =>
      await call('GET', `/bundles/${safeId(sha256)}`, ApiRoutes.getBundle.response),
  };
}
