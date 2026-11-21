// Test support only (not exported from the package).
import { TrialEvent, type TrialEvent as TrialEventT } from '@affidavit/contracts';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from './app.js';
import type { CaseBackend } from './backend.js';
import { DEFAULT_SSE, type ApiConfig } from './config.js';
import { MemoryCaseBackend } from './memory-backend.js';

export const CLIENT_SECRET = 'test-client-secret-0123456789abcdef';
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef0123';
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';

export const FAST_SSE = {
  ...DEFAULT_SSE,
  pollMs: 5,
  terminalGraceMs: 30,
  holeWaitMs: 60,
  heartbeatMs: 10_000,
};

export function devConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    auth: { mode: 'dev', tenantId: 'tenant-dev' },
    store: 'memory',
    intake: 'fake',
    webOrigins: ['http://localhost:5173'],
    webhookSecret: WEBHOOK_SECRET,
    devReplayMs: 0,
    rateLimitMax: 1000,
    sse: FAST_SSE,
    logLevel: 'silent',
    ...overrides,
  };
}

export function githubConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return devConfig({
    auth: {
      mode: 'github',
      clientId: 'Iv1.testclient',
      clientSecret: CLIENT_SECRET,
      redirectUrl: 'https://api.example.test/auth/github/callback',
    },
    store: 'postgres',
    sessionSecret: SESSION_SECRET,
    ...overrides,
  });
}

/**
 * A fake of the two GitHub endpoints the OAuth exchange calls. An authorization code `code-<id>`
 * signs in GitHub user `<id>`. It refuses a token exchange without the right client secret.
 */
export function fakeGithubFetch(calls: string[] = []): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init?.body as string) as { code: string; client_secret: string };
      if (body.client_secret !== CLIENT_SECRET) {
        return Promise.resolve(new Response('{"error":"bad"}', { status: 401 }));
      }
      const m = /^code-([0-9]+)$/.exec(body.code);
      if (!m) return Promise.resolve(Response.json({ error: 'bad_verification_code' }));
      return Promise.resolve(Response.json({ access_token: `gho_${m[1]}`, token_type: 'bearer' }));
    }
    if (url === 'https://api.github.com/user') {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const m = /^Bearer gho_([0-9]+)$/.exec(auth);
      if (!m) return Promise.resolve(new Response('{}', { status: 401 }));
      return Promise.resolve(Response.json({ id: Number(m[1]), login: `user${m[1]}` }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

export async function makeApp(
  config: ApiConfig = devConfig(),
  extra: Partial<BuildAppOptions> & { backend?: CaseBackend } = {},
): Promise<{ app: FastifyInstance; backend: CaseBackend }> {
  const backend = extra.backend ?? new MemoryCaseBackend();
  const app = await buildApp({
    fetch: fakeGithubFetch(),
    logger: false,
    ...extra,
    config,
    backend,
  });
  return { app, backend };
}

function cookieValue(res: { cookies: { name: string; value: string }[] }, name: string): string {
  const c = res.cookies.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} cookie`);
  return c.value;
}

export interface Session {
  cookies: Record<string, string>;
  csrf: string;
}

/** Full OAuth sign-in through the fake GitHub, then fetches a CSRF token. */
export async function signIn(app: FastifyInstance, githubUserId: number): Promise<Session> {
  const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
  if (login.statusCode !== 302) throw new Error(`login ${login.statusCode}`);
  const state = new URL(String(login.headers.location)).searchParams.get('state') ?? '';
  const stateCookie = cookieValue(login, 'affidavit_oauth_state');
  const cb = await app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=code-${githubUserId}&state=${state}`,
    cookies: { affidavit_oauth_state: stateCookie },
  });
  if (cb.statusCode !== 204) throw new Error(`callback ${cb.statusCode}`);
  const session = cookieValue(cb, 'affidavit_session');
  const csrfRes = await app.inject({
    method: 'GET',
    url: '/auth/csrf',
    cookies: { affidavit_session: session },
  });
  const csrfCookie = cookieValue(csrfRes, 'affidavit_csrf');
  const { token } = csrfRes.json<{ token: string }>();
  return { cookies: { affidavit_session: session, affidavit_csrf: csrfCookie }, csrf: token };
}

export interface ParsedSse {
  /** The `id:` field of each message, in order. */
  ids: string[];
  /** Each message's data, parsed with the contract schema. */
  events: TrialEventT[];
}

/** Parses an SSE body with the standard field rules (data, id; comments ignored). */
export function parseSse(body: string): ParsedSse {
  const ids: string[] = [];
  const events: TrialEventT[] = [];
  for (const block of body.split(/\r\n\r\n|\n\n|\r\r/)) {
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (line.startsWith('id:')) id = line.slice(3).replace(/^ /, '');
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) continue;
    events.push(TrialEvent.parse(JSON.parse(data.join('\n'))));
    ids.push(id ?? '');
  }
  return { ids, events };
}
