import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DevAuthConfig, GithubAuthConfig } from './config.js';
import { sendError } from './errors.js';
import {
  MemorySessionStore,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_ID_RE,
  SESSION_RETRY_AFTER_S,
  SessionCapacityError,
  type SessionStore,
} from './session-store.js';

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
  authenticate(req: FastifyRequest): Promise<Principal | null>;
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
    authenticate: () => Promise.resolve(principal),
    register: () => undefined,
  };
}

export const SESSION_COOKIE = 'affidavit_session';
export const STATE_COOKIE = 'affidavit_oauth_state';
export const SESSION_TTL_MS = SESSION_ABSOLUTE_TTL_MS;
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

/** The cookie: a random session id plus the tenant and subject it must match on the server. */
interface SessionPayload {
  v: 2;
  i: string;
  t: string;
  s: string;
}

function encodeSession(p: SessionPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

function decodeSession(raw: string): SessionPayload | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(raw)) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (
      p.v !== 2 ||
      typeof p.i !== 'string' ||
      typeof p.t !== 'string' ||
      typeof p.s !== 'string'
    ) {
      return null;
    }
    if (!SESSION_ID_RE.test(p.i) || !GITHUB_TENANT_RE.test(p.t) || !/^[0-9]{1,20}$/.test(p.s)) {
      return null;
    }
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
  /** Server-side session state. Defaults to an in-process store (see MemorySessionStore). */
  sessions?: SessionStore;
}

/**
 * GitHub OAuth (web flow). Sign-in sets a signed, httpOnly, Secure, SameSite=Lax session cookie
 * holding a random session id, the tenant and the GitHub user id; the session itself lives in a
 * SessionStore (8 hours absolute, 1 hour idle) and logout deletes it. The access token is used once to read
 * the user id and then dropped. The client secret goes only into the token exchange body.
 */
export function githubAuth(config: GithubAuthConfig, deps: GithubAuthDeps = {}): AuthProvider {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;

  const sessions = deps.sessions ?? new MemorySessionStore();

  /** The signed, well-formed session cookie of a request, or null. */
  function sessionCookie(req: FastifyRequest): SessionPayload | null {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) return null;
    return decodeSession(unsigned.value);
  }

  /**
   * Valid only when the signed cookie names a live server-side session of the same tenant and
   * subject. Logout, expiry (absolute and idle) and an unknown id all end in null.
   */
  async function authenticate(req: FastifyRequest): Promise<Principal | null> {
    const p = sessionCookie(req);
    if (!p) return null;
    const rec = await sessions.use(p.i, p.t, now());
    if (!rec || rec.subject !== p.s) return null;
    return { tenantId: rec.tenantId, subject: rec.subject, via: 'cookie' };
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
    // Expired sessions also free capacity on a timer, not only when touched or at the cap.
    if (sessions instanceof MemorySessionStore) {
      const timer = setInterval(() => sessions.sweep(now()), 5 * 60 * 1000);
      timer.unref();
      app.addHook('onClose', (_app, done) => {
        clearInterval(timer);
        done();
      });
    }
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

    // Each successful callback creates a session: limited per IP on top of the global limit.
    const callbackLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
    app.get('/auth/github/callback', callbackLimit, async (req, reply) => {
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
      const tenantId = githubTenantId(user.id);
      const subject = String(user.id);
      let sid: string;
      try {
        sid = await sessions.create(tenantId, subject, now());
      } catch (err) {
        if (!(err instanceof SessionCapacityError)) throw err;
        // Full of live sessions: refuse this sign-in rather than log anybody else out.
        reply.header('retry-after', String(SESSION_RETRY_AFTER_S));
        return sendError(reply, 503, 'sessions-full');
      }
      const session = encodeSession({ v: 2, i: sid, t: tenantId, s: subject });
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
      async (req, reply) => {
        // Revoke on the server, so a copied cookie stops working too. The store deletes the
        // session only for the tenant the signed cookie names.
        const p = sessionCookie(req);
        if (p) await sessions.revoke(p.i, p.t);
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.code(204).send();
      },
    );
  }

  return { mode: 'github', usesCookies: true, authenticate, register };
}
