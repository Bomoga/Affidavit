import { isIP } from 'node:net';

type Env = Readonly<Record<string, string | undefined>>;

/** Thrown when the environment cannot start a safe server. Messages name variables, never values. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`refusing to start the API: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export interface DevAuthConfig {
  mode: 'dev';
  /** The one tenant every request acts as. */
  tenantId: string;
}

export interface GithubAuthConfig {
  mode: 'github';
  clientId: string;
  /** Secret: never logged, never in a response. */
  clientSecret: string;
  /** Registered OAuth callback URL. Never derived from the request. */
  redirectUrl: string;
  /** Where the browser goes after sign-in. Optional; without it the callback answers 204. */
  postLoginUrl?: string;
}

export type AuthConfig = DevAuthConfig | GithubAuthConfig;

export interface SseConfig {
  pollMs: number;
  /** How long a case must sit at a terminal stage with nothing new before the stream closes. */
  terminalGraceMs: number;
  heartbeatMs: number;
  /** A stream is closed cleanly after this long; the client resumes with Last-Event-ID. */
  maxStreamMs: number;
  /** How long a hole in the seq sequence is held back before it is skipped. */
  holeWaitMs: number;
  /** Concurrent streams per tenant. */
  maxStreamsPerTenant: number;
  /** Most events read from the store per query; a full page is followed at once by the next. */
  pageSize: number;
}

export interface ApiConfig {
  host: string;
  port: number;
  auth: AuthConfig;
  store: 'memory' | 'postgres';
  /** affidavit_app role URL. Secret. Required for the postgres store. */
  databaseUrl?: string;
  /** POST /cases builds a case only with the fake intake (as the CLI does) until L1-01 lands. */
  intake: 'fake' | 'none';
  /** Browser origins allowed by CORS and on mutating requests. Exact origins, no wildcard. */
  webOrigins: readonly string[];
  /** Cookie signing key (sessions, CSRF secret, OAuth state). Secret. */
  sessionSecret?: string;
  /** GitHub webhook HMAC secret. Secret. Without it POST /webhooks/github answers 503. */
  webhookSecret?: string;
  /** Memory store only: delay between replayed fixture events for a new case. */
  devReplayMs: number;
  rateLimitMax: number;
  sse: SseConfig;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

export const DEFAULT_SSE: SseConfig = {
  pollMs: 1000,
  terminalGraceMs: 2000,
  heartbeatMs: 15_000,
  maxStreamMs: 30 * 60_000,
  holeWaitMs: 5000,
  maxStreamsPerTenant: 16,
  pageSize: 500,
};

const TENANT_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** True for 127.0.0.0/8, ::1, and the name localhost. The bound address is checked again after listen. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::ffff:127.0.0.1';
  return false;
}

/** An exact origin: scheme, host and optional port; https, or http on a loopback host. */
export function parseOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

function safeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  } catch {
    return false;
  }
}

function intVar(
  env: Env,
  name: string,
  def: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}`);
    return def;
  }
  return Number(raw);
}

/**
 * Reads the API configuration. Refuses to start (ConfigError) when:
 * - AFFIDAVIT_AUTH is unset or not `dev` or `github`;
 * - `dev` auth is selected and AFFIDAVIT_API_HOST is not a loopback address;
 * - `github` auth is selected without GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET,
 *   AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL or a 32+ character AFFIDAVIT_SESSION_SECRET;
 * - the memory store is selected with anything but `dev` auth;
 * - the postgres store is selected without AFFIDAVIT_APP_DATABASE_URL.
 */
export function loadApiConfig(env: Env): ApiConfig {
  const problems: string[] = [];
  const host = env.AFFIDAVIT_API_HOST || '127.0.0.1';
  const port = intVar(env, 'AFFIDAVIT_API_PORT', 3000, 0, 65535, problems);

  let auth: AuthConfig | undefined;
  const mode = env.AFFIDAVIT_AUTH;
  if (mode === 'dev') {
    if (!isLoopbackHost(host)) {
      problems.push(
        'AFFIDAVIT_AUTH=dev only listens on a loopback address: set AFFIDAVIT_API_HOST to 127.0.0.1, ::1 or localhost',
      );
    }
    const tenantId = env.AFFIDAVIT_DEV_TENANT_ID || 'tenant-dev';
    if (!TENANT_RE.test(tenantId)) {
      problems.push(
        'AFFIDAVIT_DEV_TENANT_ID may only contain letters, digits, ". _ : -" (max 128)',
      );
    }
    auth = { mode: 'dev', tenantId };
  } else if (mode === 'github') {
    const clientId = env.GITHUB_OAUTH_CLIENT_ID ?? '';
    const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET ?? '';
    const redirectUrl = env.AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL ?? '';
    const postLoginUrl = env.AFFIDAVIT_GITHUB_POST_LOGIN_URL;
    if (clientId === '') problems.push('AFFIDAVIT_AUTH=github needs GITHUB_OAUTH_CLIENT_ID');
    else if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) {
      problems.push('GITHUB_OAUTH_CLIENT_ID has unexpected characters');
    }
    if (clientSecret === '')
      problems.push('AFFIDAVIT_AUTH=github needs GITHUB_OAUTH_CLIENT_SECRET');
    else if (!/^[\x21-\x7e]{8,200}$/.test(clientSecret)) {
      problems.push('GITHUB_OAUTH_CLIENT_SECRET has an unexpected format');
    }
    if (redirectUrl === '') {
      problems.push('AFFIDAVIT_AUTH=github needs AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL');
    } else if (!safeHttpUrl(redirectUrl)) {
      problems.push('AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL must be https (http only on loopback)');
    }
    if (postLoginUrl !== undefined && postLoginUrl !== '' && !safeHttpUrl(postLoginUrl)) {
      problems.push('AFFIDAVIT_GITHUB_POST_LOGIN_URL must be https (http only on loopback)');
    }
    auth = {
      mode: 'github',
      clientId,
      clientSecret,
      redirectUrl,
      ...(postLoginUrl ? { postLoginUrl } : {}),
    };
  } else if (mode === undefined || mode === '') {
    problems.push('AFFIDAVIT_AUTH is required: "dev" (loopback only) or "github"');
  } else {
    problems.push('AFFIDAVIT_AUTH must be "dev" or "github"');
  }

  const sessionSecret = env.AFFIDAVIT_SESSION_SECRET || undefined;
  if (auth?.mode === 'github' && (sessionSecret === undefined || sessionSecret.length < 32)) {
    problems.push('AFFIDAVIT_AUTH=github needs AFFIDAVIT_SESSION_SECRET of at least 32 characters');
  }

  const storeRaw = env.AFFIDAVIT_API_STORE || (auth?.mode === 'dev' ? 'memory' : 'postgres');
  let store: ApiConfig['store'] = 'postgres';
  if (storeRaw === 'memory' || storeRaw === 'postgres') store = storeRaw;
  else problems.push('AFFIDAVIT_API_STORE must be "memory" or "postgres"');
  if (store === 'memory' && auth?.mode !== 'dev') {
    problems.push('AFFIDAVIT_API_STORE=memory is for AFFIDAVIT_AUTH=dev only');
  }
  const databaseUrl = env.AFFIDAVIT_APP_DATABASE_URL || undefined;
  if (store === 'postgres') {
    if (!databaseUrl)
      problems.push('AFFIDAVIT_API_STORE=postgres needs AFFIDAVIT_APP_DATABASE_URL');
    else {
      try {
        const u = new URL(databaseUrl);
        if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
          problems.push('AFFIDAVIT_APP_DATABASE_URL must be a postgres:// URL');
        }
      } catch {
        problems.push('AFFIDAVIT_APP_DATABASE_URL is not a valid URL');
      }
    }
  }

  const intakeRaw = env.AFFIDAVIT_INTAKE_IMPL ?? '';
  let intake: ApiConfig['intake'] = 'none';
  if (intakeRaw === 'fake') intake = 'fake';
  else if (intakeRaw !== '' && intakeRaw !== 'real') {
    problems.push('AFFIDAVIT_INTAKE_IMPL must be "fake" or "real"');
  }

  const webOrigins: string[] = [];
  for (const part of (env.AFFIDAVIT_WEB_ORIGINS ?? '').split(',')) {
    const p = part.trim();
    if (p === '') continue;
    const o = parseOrigin(p);
    if (o === null) {
      problems.push(
        'AFFIDAVIT_WEB_ORIGINS must be a comma-separated list of exact https origins (http only on loopback)',
      );
      break;
    }
    webOrigins.push(o);
  }

  const webhookSecret = env.AFFIDAVIT_GITHUB_WEBHOOK_SECRET || undefined;
  if (webhookSecret !== undefined && webhookSecret.length < 16) {
    problems.push('AFFIDAVIT_GITHUB_WEBHOOK_SECRET must be at least 16 characters');
  }

  const logRaw = env.AFFIDAVIT_API_LOG_LEVEL || 'info';
  const levels = ['silent', 'error', 'warn', 'info', 'debug'] as const;
  const logLevel = levels.find((l) => l === logRaw);
  if (!logLevel)
    problems.push('AFFIDAVIT_API_LOG_LEVEL must be silent, error, warn, info or debug');

  const devReplayMs = intVar(env, 'AFFIDAVIT_DEV_REPLAY_MS', 300, 0, 60_000, problems);
  const rateLimitMax = intVar(env, 'AFFIDAVIT_RATE_LIMIT_MAX', 300, 1, 100_000, problems);

  if (problems.length > 0 || !auth) throw new ConfigError(problems);
  return {
    host,
    port,
    auth,
    store,
    ...(databaseUrl ? { databaseUrl } : {}),
    intake,
    webOrigins,
    ...(sessionSecret ? { sessionSecret } : {}),
    ...(webhookSecret ? { webhookSecret } : {}),
    devReplayMs,
    rateLimitMax,
    sse: DEFAULT_SSE,
    logLevel: logLevel ?? 'info',
  };
}

/** Every secret value in a config, for scrubbing anything that might be logged. */
export function secretsOf(config: ApiConfig): string[] {
  const out: string[] = [];
  if (config.auth.mode === 'github') out.push(config.auth.clientSecret);
  if (config.sessionSecret) out.push(config.sessionSecret);
  if (config.webhookSecret) out.push(config.webhookSecret);
  if (config.databaseUrl) {
    out.push(config.databaseUrl);
    try {
      const u = new URL(config.databaseUrl);
      if (u.password) out.push(u.password, decodeURIComponent(u.password));
    } catch {
      // Rejected by loadApiConfig already.
    }
  }
  return out.filter((s) => s.length > 0);
}
