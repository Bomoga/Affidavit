import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DevAuthConfig, GithubAuthConfig } from './config.js';
import { sendError } from './errors.js';

export interface Principal {
  tenantId: string;
  /** Stable subject id, for audit. Never a token. */
  subject: string;
  /** `cookie` principals must pass CSRF on mutating routes. */
  via: 'dev' | 'cookie';
}

/** An auth provider decides who a request is. Routes never read credentials themselves. */
export interface AuthProvider {
  readonly mode: 'dev' | 'github';
  /** True when the browser carries an ambient credential (a cookie), so CSRF applies. */
  readonly usesCookies: boolean;
  authenticate(req: FastifyRequest): Principal | null;
  /** Adds the provider's own routes (sign-in, sign-out). */
  register(app: FastifyInstance): void;
}

/**
 * Dev auth: every request is the fixed dev tenant. Only valid on a loopback listener; the config
 * loader refuses anything else, `startServer` checks the bound address, and the app refuses a
 * non-loopback Host header (DNS rebinding).
 */
export function devAuth(config: DevAuthConfig): AuthProvider {
  const principal: Principal = { tenantId: config.tenantId, subject: 'dev', via: 'dev' };
  return {
    mode: 'dev',
    usesCookies: false,
    authenticate: () => principal,
    register: () => undefined,
  };
}

export const SESSION_COOKIE = 'affidavit_session';
export const STATE_COOKIE = 'affidavit_oauth_state';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const STATE_TTL_S = 600;
const GITHUB_TENANT_RE = /^github-[1-9][0-9]{0,19}$/;
const OAUTH_PARAM_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_GITHUB_BODY = 64 * 1024;

/**
 * Tenant for a GitHub user. One tenant per user for now; it must be provisioned (by the owner,
 * `provisionTenant`) before that user can open cases. Org-based tenancy is a follow-up.
 */
export function githubTenantId(userId: number): string {
  return `github-${userId}`;
}

interface SessionPayload {
  v: 1;
  t: string;
  s: string;
  e: number;
}

function encodeSession(p: SessionPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

function decodeSession(raw: string, now: number): SessionPayload | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(raw)) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (p.v !== 1 || typeof p.t !== 'string' || typeof p.s !== 'string') return null;
    if (typeof p.e !== 'number' || p.e <= now) return null;
    if (!GITHUB_TENANT_RE.test(p.t) || !/^[0-9]{1,20}$/.test(p.s)) return null;
    return p as SessionPayload;
  } catch {
    return null;
  }
}

async function readCapped(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_GITHUB_BODY) throw new Error('response too large');
  return JSON.parse(text) as unknown;
}

export interface GithubAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * GitHub OAuth (web flow). Sign-in sets a signed, httpOnly, Secure, SameSite=Lax session cookie
 * holding only the tenant, the GitHub user id and an expiry. The access token is used once to read
 * the user id and then dropped. The client secret goes only into the token exchange body.
 */
export function githubAuth(config: GithubAuthConfig, deps: GithubAuthDeps = {}): AuthProvider {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;

  function authenticate(req: FastifyRequest): Principal | null {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) return null;
    const p = decodeSession(unsigned.value, now());
    return p ? { tenantId: p.t, subject: p.s, via: 'cookie' } : null;
  }

  async function exchange(code: string): Promise<{ id: number } | null> {
    const tokenRes = await doFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUrl,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) return null;
    const token = (await readCapped(tokenRes)) as { access_token?: unknown };
    if (
      typeof token.access_token !== 'string' ||
      !/^[\x21-\x7e]{1,512}$/.test(token.access_token)
    ) {
      return null;
    }
    const userRes = await doFetch('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token.access_token}`,
        'user-agent': 'affidavit-api',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) return null;
    const user = (await readCapped(userRes)) as { id?: unknown };
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return { id: user.id };
  }

  function register(app: FastifyInstance): void {
    const authLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

    app.get('/auth/github/login', authLimit, (_req, reply) => {
      const state = randomBytes(32).toString('base64url');
      reply.setCookie(STATE_COOKIE, state, {
        signed: true,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/auth/github',
        maxAge: STATE_TTL_S,
      });
      const u = new URL('https://github.com/login/oauth/authorize');
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', config.redirectUrl);
      u.searchParams.set('state', state);
      u.searchParams.set('allow_signup', 'false');
      return reply.redirect(u.toString(), 302);
    });

    app.get('/auth/github/callback', authLimit, async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const code = q['code'];
      const state = q['state'];
      const rawState = req.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: '/auth/github' });
      if (typeof code !== 'string' || typeof state !== 'string' || !rawState) {
        return sendError(reply, 400, 'oauth-failed');
      }
      if (!OAUTH_PARAM_RE.test(code) || !OAUTH_PARAM_RE.test(state)) {
        return sendError(reply, 400, 'oauth-failed');
      }
      const expected = req.unsignCookie(rawState);
      const a = Buffer.from(state);
      const b = Buffer.from(expected.valid && expected.value ? expected.value : '');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return sendError(reply, 400, 'oauth-failed');
      }
      let user: { id: number } | null;
      try {
        user = await exchange(code);
      } catch {
        user = null;
      }
      if (!user) return sendError(reply, 502, 'oauth-failed');
      const session = encodeSession({
        v: 1,
        t: githubTenantId(user.id),
        s: String(user.id),
        e: now() + SESSION_TTL_MS,
      });
      reply.setCookie(SESSION_COOKIE, session, {
        signed: true,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      });
      if (config.postLoginUrl) return reply.redirect(config.postLoginUrl, 303);
      return reply.code(204).send();
    });

    // A CSRF token for the cookie-authenticated mutating routes. Send it back as x-csrf-token.
    app.get('/auth/csrf', authLimit, (_req, reply) => {
      const token = reply.generateCsrf();
      return reply.send({ token });
    });

    app.post(
      '/auth/logout',
      { ...authLimit, onRequest: app.csrfProtection.bind(app) },
      (_req, reply) => {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.code(204).send();
      },
    );
  }

  return { mode: 'github', usesCookies: true, authenticate, register };
}
