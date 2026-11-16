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

export interface HttpApiConfig {
  baseUrl: string;
  /** Optional bearer token, supplied by the caller from its environment. Never hard-coded. */
  token?: string;
  fetch?: typeof fetch;
}

/** Reads AFFIDAVIT_API_URL (required) and AFFIDAVIT_API_TOKEN (optional) from an environment. */
export function configFromEnv(env: Record<string, string | undefined>): HttpApiConfig {
  const baseUrl = env['AFFIDAVIT_API_URL'];
  if (!baseUrl) throw new Error('AFFIDAVIT_API_URL is not set');
  const token = env['AFFIDAVIT_API_TOKEN'];
  return token ? { baseUrl, token } : { baseUrl };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
}

/** Thin fetch wrapper. Every response body is parsed with its contract schema. */
export function createHttpApi(config: HttpApiConfig): AffidavitApi {
  const doFetch = config.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: { parse: (v: unknown) => T },
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.token) headers['authorization'] = `Bearer ${config.token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
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
    createCase: (request) =>
      call(
        'POST',
        '/cases',
        ApiRoutes.createCase.response,
        ApiRoutes.createCase.request.parse(request),
      ),
    getCase: (caseId) =>
      call('GET', `/cases/${encodeURIComponent(caseId)}`, ApiRoutes.getCase.response),
    getVerdict: (caseId) =>
      call('GET', `/cases/${encodeURIComponent(caseId)}/verdict`, ApiRoutes.getVerdict.response),
    getBundle: (sha256) =>
      call('GET', `/bundles/${encodeURIComponent(sha256)}`, ApiRoutes.getBundle.response),
  };
}
