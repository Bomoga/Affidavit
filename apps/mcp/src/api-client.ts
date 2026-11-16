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

/** Printable ASCII only: a token with whitespace, control or non-ASCII characters is refused. */
const TOKEN_RE = /^[\x21-\x7E]+$/;

/**
 * Validates an API base URL and returns origin plus path without a trailing slash. It must be
 * https (http only for localhost and 127.0.0.1) and carry no credentials, query or fragment.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AFFIDAVIT_API_URL is not a valid URL');
  }
  if (url.username || url.password) {
    throw new Error('AFFIDAVIT_API_URL must not contain embedded credentials');
  }
  if (url.search || url.hash) {
    throw new Error('AFFIDAVIT_API_URL must not contain a query or fragment');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('AFFIDAVIT_API_URL must use https (http is allowed only for localhost)');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function checkToken(token: string): void {
  if (!TOKEN_RE.test(token)) {
    throw new Error('AFFIDAVIT_API_TOKEN must be printable ASCII with no whitespace');
  }
}

/**
 * Reads AFFIDAVIT_API_URL (required), AFFIDAVIT_API_TOKEN (optional) and AFFIDAVIT_API_TIMEOUT_MS
 * (optional). See normalizeBaseUrl for the URL rules.
 */
export function configFromEnv(env: Record<string, string | undefined>): HttpApiConfig {
  const raw = env['AFFIDAVIT_API_URL'];
  if (!raw) throw new Error('AFFIDAVIT_API_URL is not set');
  const config: HttpApiConfig = { baseUrl: normalizeBaseUrl(raw) };
  const token = env['AFFIDAVIT_API_TOKEN'];
  if (token) {
    checkToken(token);
    config.token = token;
  }
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
  // Validate here, not only in configFromEnv, so this function cannot send a token over plain http.
  const base = normalizeBaseUrl(config.baseUrl);
  if (config.token !== undefined) checkToken(config.token);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redact = (text: string): string =>
    config.token ? text.replaceAll(config.token, '[redacted]') : text;
  const isAbort = (err: unknown): boolean =>
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

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
      // Fixed messages only: raw fetch errors can echo request headers, which hold the token.
      if (isAbort(err)) throw new ApiError(`${method} ${path} timed out after ${timeoutMs} ms`);
      throw new ApiError(`request to ${method} ${path} failed: network error`);
    }
    if (!res.ok) throw new ApiError(`${method} ${path} returned HTTP ${res.status}`, res.status);
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      if (isAbort(err)) throw new ApiError(`${method} ${path} timed out after ${timeoutMs} ms`);
      throw new ApiSchemaError(`${method} ${path} returned a body that is not JSON`);
    }
    try {
      return schema.parse(json);
    } catch (err) {
      throw new ApiSchemaError(
        `${method} ${path} returned a body that does not match the contract: ${redact(errorText(err))}`,
      );
    }
  }

  return {
    createCase: async (request) =>
      await call(
        'POST',
        '/cases',
        ApiRoutes.createCase.response,
        ApiRoutes.createCase.request.parse(request),
      ),
    getCase: async (caseId) =>
      await call('GET', `/cases/${safeId(caseId)}`, ApiRoutes.getCase.response),
    getVerdict: async (caseId) =>
      await call('GET', `/cases/${safeId(caseId)}/verdict`, ApiRoutes.getVerdict.response),
    getBundle: async (sha256) =>
      await call('GET', `/bundles/${safeId(sha256)}`, ApiRoutes.getBundle.response),
  };
}
