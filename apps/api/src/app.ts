import { createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { ApiRoutes, type CaseStage } from '@affidavit/contracts';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type preHandlerAsyncHookHandler,
  type preHandlerHookHandler,
} from 'fastify';
import {
  devAuth,
  githubAuth,
  type AuthProvider,
  type GithubAuthDeps,
  type Principal,
} from './auth.js';
import type { SessionStore } from './session-store.js';
import { UnknownTenantError, type CaseBackend } from './backend.js';
import { isLoopbackHost, secretsOf, type ApiConfig } from './config.js';
import { ApiError, NOT_FOUND_BODY, sendError } from './errors.js';
import { isCaseId, isSha256, parseSeq } from './ids.js';
import { DEFAULT_BUDGET, buildFakeCaseFile } from './intake.js';
import { abortableSleep, resumeAfter, trialEventStream } from './sse.js';
import { GITHUB_DELIVERY_RE, GITHUB_EVENT_RE, verifyGithubSignature } from './webhook.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/** Default body cap for JSON requests. POST /cases needs well under 1 KiB. */
export const BODY_LIMIT = 16 * 1024;
/** Webhook body cap. GitHub can send more; the L1-15 handler can raise this if it needs to. */
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
const MAX_REPO_URL = 2048;

export type GithubWebhook = (typeof ApiRoutes.githubWebhook.request)['_output'];

export interface BuildAppOptions {
  config: ApiConfig;
  backend: CaseBackend;
  /** Defaults to the provider the config selects. */
  auth?: AuthProvider;
  /** Used by the GitHub provider for the OAuth exchange. Tests inject a fake. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Fastify logger options. Defaults to the config log level with path-only request logging. */
  logger?: Exclude<FastifyServerOptions['logger'], boolean> | false;
  /** Called with a verified, parsed webhook. A no-op until L1-15. */
  onWebhook?: (hook: GithubWebhook) => Promise<void>;
  /** Server-side sessions for GitHub auth. Defaults to an in-process MemorySessionStore. */
  sessions?: SessionStore;
}

const serializers = {
  // The query string can carry an OAuth code or state: log the path only.
  req: (req: { method?: string; url?: string; id?: string }) => ({
    method: req.method,
    url: (req.url ?? '').split('?')[0],
    reqId: req.id,
  }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
};

function scrub(message: string, secrets: readonly string[]): string {
  let m = message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]');
  for (const s of secrets) m = m.split(s).join('[redacted]');
  return m.slice(0, 300);
}

/**
 * The only repo URL a tenant may submit: `https://github.com/<owner>/<repo>` with an optional
 * `.git`, matched on the raw string (no URL normalisation), so no other host, port, userinfo,
 * query, fragment, percent-encoding, extra path segment, unicode or IDN form gets through. The
 * worker clones this later, so anything else (a metadata address, an internal host, a local path)
 * is refused here. Owner: GitHub's rule (alphanumeric or single inner hyphens, 1 to 39). Repo:
 * letters, digits, `.`, `_`, `-`, 1 to 100, not `.` or `..`.
 */
const GITHUB_REPO_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,104})$/;

export function isAcceptableRepoUrl(raw: string): boolean {
  if (raw.length > MAX_REPO_URL) return false;
  const m = GITHUB_REPO_URL_RE.exec(raw);
  if (!m) return false;
  const repo = m[2]!.endsWith('.git') ? m[2]!.slice(0, -4) : m[2]!;
  return (
    repo.length >= 1 &&
    repo.length <= 100 &&
    repo !== '.' &&
    repo !== '..' &&
    !repo.endsWith('.git')
  );
}

export function authFromConfig(config: ApiConfig, deps: GithubAuthDeps = {}): AuthProvider {
  return config.auth.mode === 'dev' ? devAuth(config.auth) : githubAuth(config.auth, deps);
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, backend } = options;
  const now = options.now ?? Date.now;
  const auth =
    options.auth ??
    authFromConfig(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sessions ? { sessions: options.sessions } : {}),
      isProvisioned: (tenantId) => backend.isProvisioned(tenantId),
      now,
    });
  const secrets = secretsOf(config);
  const allowedOrigins = new Set(config.webOrigins);
  const onWebhook = options.onWebhook ?? (() => Promise.resolve());

  const logger =
    options.logger === undefined
      ? config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, serializers }
      : options.logger === false
        ? false
        : { ...options.logger, serializers };

  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT,
    // Long enough that an over-long id reaches the handler and gets a 400, not a router 404.
    routerOptions: { maxParamLength: 200 },
    trustProxy: false,
    forceCloseConnections: true,
    return503OnClosing: true,
  });

  app.decorateRequest('principal', null);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  });

  await app.register(fastifyCors, {
    origin: (origin, cb) => cb(null, origin !== undefined && allowedOrigins.has(origin)),
    credentials: auth.usesCookies,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'last-event-id'],
    maxAge: 600,
  });

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new ApiError(429, 'rate-limited'),
  });

  // Dev auth sets no cookies of its own; a per-process key keeps the plugins consistent.
  const cookieSecret = config.sessionSecret ?? randomBytes(32).toString('hex');
  await app.register(fastifyCookie, { secret: cookieSecret });
  const csrfUserInfo = auth.csrfUserInfo?.bind(auth);
  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: auth.cookies?.csrfName ?? 'affidavit_csrf',
    cookieOpts: {
      signed: true,
      httpOnly: true,
      secure: auth.cookies?.secure ?? true,
      sameSite: 'strict',
      path: '/',
    },
    // Header only: a token in the query string would end up in logs and histories.
    getToken: (req) => {
      const v = req.headers['x-csrf-token'];
      return typeof v === 'string' ? v : undefined;
    },
    // Tokens are bound to the session id, so one minted for another session never verifies.
    ...(csrfUserInfo
      ? {
          getUserInfo: csrfUserInfo,
          csrfOpts: {
            hmacKey: createHmac('sha256', cookieSecret).update('affidavit-csrf-v1').digest(),
          },
        }
      : {}),
  });

  // Only JSON bodies (the webhook scope below adds its own raw parser).
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', (req, reply, done) => {
    if (auth.mode === 'dev' && !isLoopbackHost(req.hostname)) {
      // Dev auth trusts whoever reaches the loopback port. A non-loopback Host header means a
      // DNS-rebound page or a proxy, so refuse it.
      void sendError(reply, 403, 'host-not-allowed');
      return;
    }
    const origin = req.headers.origin;
    if (
      req.method === 'POST' &&
      !req.url.startsWith('/webhooks/') &&
      origin !== undefined &&
      !allowedOrigins.has(origin)
    ) {
      void sendError(reply, 403, 'origin-not-allowed');
      return;
    }
    done();
  });

  app.addHook('onSend', (_req, reply, payload, done) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err.statusCode, err.code);
    const status = err.statusCode ?? 500;
    if (typeof err.code === 'string' && err.code.startsWith('FST_CSRF')) {
      return sendError(reply, 403, 'csrf-failed');
    }
    if (status === 413) return sendError(reply, 413, 'payload-too-large');
    if (status === 415) return sendError(reply, 415, 'unsupported-media-type');
    if (status === 429) return sendError(reply, 429, 'rate-limited');
    if (status >= 400 && status < 500) return sendError(reply, status, 'bad-request');
    req.log.error(
      { errName: err.name, errCode: err.code, msg: scrub(err.message, secrets) },
      'request failed',
    );
    return sendError(reply, 500, 'internal');
  });

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (_req, reply) =>
    reply.code(404).send(NOT_FOUND_BODY),
  );

  const requireAuth: preHandlerAsyncHookHandler = async (req, reply) => {
    const p = await auth.authenticate(req);
    if (!p) return sendError(reply, 401, 'unauthenticated');
    req.principal = p;
  };
  const readHooks = [requireAuth];
  const writeHooks: (preHandlerHookHandler | preHandlerAsyncHookHandler)[] = auth.usesCookies
    ? [requireAuth, app.csrfProtection.bind(app)]
    : [requireAuth];

  const principal = (req: FastifyRequest): Principal => {
    if (!req.principal) throw new ApiError(401, 'unauthenticated');
    return req.principal;
  };
  const caseIdOf = (req: FastifyRequest): string => {
    const id = (req.params as { id?: unknown }).id;
    if (!isCaseId(id)) throw new ApiError(400, 'invalid-id');
    return id;
  };

  auth.register(app);

  app.get('/healthz', { config: { rateLimit: false } }, (_req, reply) =>
    reply.send({ status: 'ok' }),
  );

  app.post(
    '/cases',
    { preHandler: writeHooks, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const p = principal(req);
      const type = req.headers['content-type'] ?? '';
      if (!/^application\/json(\s*;|$)/i.test(type)) {
        return sendError(reply, 415, 'unsupported-media-type');
      }
      const parsed = ApiRoutes.createCase.request.safeParse(req.body);
      if (!parsed.success || !isAcceptableRepoUrl(parsed.data.repoUrl)) {
        return sendError(reply, 400, 'bad-request');
      }
      if (config.intake !== 'fake') return sendError(reply, 501, 'intake-not-implemented');
      const file = buildFakeCaseFile(parsed.data.repoUrl, p.tenantId);
      try {
        await backend.forTenant(p.tenantId).create(file, DEFAULT_BUDGET);
      } catch (err) {
        if (err instanceof UnknownTenantError) {
          return sendError(reply, 403, 'tenant-not-provisioned');
        }
        throw err;
      }
      const body = ApiRoutes.createCase.response.parse({
        schemaVersion: 1,
        caseId: file.id,
        stage: 'intake',
      });
      return reply.code(201).send(body);
    },
  );

  app.get('/cases/:id', { preHandler: readHooks }, async (req, reply) => {
    const p = principal(req);
    const id = caseIdOf(req);
    const view = await backend.forTenant(p.tenantId).get(id);
    if (!view) return reply.code(404).send(NOT_FOUND_BODY);
    const body = ApiRoutes.getCase.response.parse({
      schemaVersion: 1,
      caseId: view.caseId,
      stage: view.stage,
      ...(view.caseFile ? { caseFile: view.caseFile } : {}),
      ...(view.verdict ? { verdict: view.verdict } : {}),
    });
    return reply.send(body);
  });

  app.get('/cases/:id/verdict', { preHandler: readHooks }, async (req, reply) => {
    const p = principal(req);
    const id = caseIdOf(req);
    const view = await backend.forTenant(p.tenantId).get(id);
    if (!view) return reply.code(404).send(NOT_FOUND_BODY);
    // Reachable only for the caller's own case, so it reveals nothing across tenants.
    if (!view.verdict) return sendError(reply, 404, 'verdict-not-written');
    return reply.send(ApiRoutes.getVerdict.response.parse(view.verdict));
  });

  const openStreams = new Map<string, number>();
  const liveStreams = new Set<AbortController>();
  app.addHook('onClose', (_app, done) => {
    for (const c of liveStreams) c.abort();
    done();
  });

  app.get('/cases/:id/events', { preHandler: readHooks }, async (req, reply) => {
    const p = principal(req);
    const id = caseIdOf(req);
    const header = parseSeq(req.headers['last-event-id']);
    const query = parseSeq((req.query as { after?: unknown }).after);
    if (header === null || query === null) {
      return sendError(reply, 400, 'invalid-resume-position');
    }
    const cases = backend.forTenant(p.tenantId);
    const stage: CaseStage | null = await cases.stage(id);
    if (stage === null) return reply.code(404).send(NOT_FOUND_BODY);
    const open = openStreams.get(p.tenantId) ?? 0;
    if (open >= config.sse.maxStreamsPerTenant) {
      return sendError(reply, 429, 'too-many-streams');
    }
    openStreams.set(p.tenantId, open + 1);
    const controller = new AbortController();
    liveStreams.add(controller);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      controller.abort();
      liveStreams.delete(controller);
      const n = (openStreams.get(p.tenantId) ?? 1) - 1;
      if (n <= 0) openStreams.delete(p.tenantId);
      else openStreams.set(p.tenantId, n);
    };
    // The response closing (finished or the client went away) ends the poll loop.
    reply.raw.on('close', release);
    const body = Readable.from(
      trialEventStream(cases, id, resumeAfter(header, query), config.sse, controller.signal, {
        now,
        sleep: abortableSleep,
        onInvalid: () => req.log.warn('stored event failed the contract and was not sent'),
        // Logout, expiry and eviction end an open stream too, not only new requests.
        sessionLive: () => auth.sessionLive(req),
      }),
      { objectMode: false },
    );
    body.on('close', release);
    return reply
      .code(200)
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-accel-buffering', 'no')
      .send(body);
  });

  app.get('/bundles/:sha256', { preHandler: readHooks }, (req, reply) => {
    principal(req);
    const sha = (req.params as { sha256?: unknown }).sha256;
    if (!isSha256(sha)) return sendError(reply, 400, 'invalid-id');
    // Signed bundle URLs need Lane 2's evidence store and signer (L2-08, L2-09). Until then the
    // route exists, authenticates and validates, and answers 501.
    return sendError(reply, 501, 'not-implemented');
  });

  await app.register((scope, _opts, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_req, body, done) => done(null, body),
    );
    scope.post(
      '/webhooks/github',
      {
        bodyLimit: WEBHOOK_BODY_LIMIT,
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      },
      async (req, reply: FastifyReply) => {
        if (!config.webhookSecret) return sendError(reply, 503, 'webhooks-disabled');
        const raw = req.body;
        if (!Buffer.isBuffer(raw)) return sendError(reply, 401, 'bad-signature');
        if (!verifyGithubSignature(config.webhookSecret, raw, req.headers['x-hub-signature-256'])) {
          return sendError(reply, 401, 'bad-signature');
        }
        const event = req.headers['x-github-event'];
        const delivery = req.headers['x-github-delivery'];
        if (
          typeof event !== 'string' ||
          typeof delivery !== 'string' ||
          !GITHUB_EVENT_RE.test(event) ||
          !GITHUB_DELIVERY_RE.test(delivery)
        ) {
          return sendError(reply, 400, 'bad-request');
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString('utf8')) as unknown;
        } catch {
          return sendError(reply, 400, 'bad-request');
        }
        const parsed = ApiRoutes.githubWebhook.request.safeParse({
          event,
          deliveryId: delivery,
          payload,
        });
        if (!parsed.success) return sendError(reply, 400, 'bad-request');
        await onWebhook(parsed.data);
        return reply.code(202).send();
      },
    );
    done();
  });

  return app;
}
