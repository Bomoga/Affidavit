import type { AddressInfo } from 'node:net';
import { openPool } from '@affidavit/db';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from './app.js';
import type { CaseBackend } from './backend.js';
import { ConfigError, isLoopbackHost, type ApiConfig } from './config.js';
import { MemoryCaseBackend } from './memory-backend.js';
import { PgCaseBackend } from './pg-backend.js';

/** The backend the config selects. The memory store seeds the two fixture trials for dev. */
export async function backendFromConfig(config: ApiConfig): Promise<CaseBackend> {
  if (config.store === 'memory') {
    const backend = new MemoryCaseBackend({ replayMs: config.devReplayMs });
    if (config.auth.mode === 'dev') backend.seedFixtures(config.auth.tenantId);
    return backend;
  }
  if (!config.databaseUrl) throw new ConfigError(['AFFIDAVIT_APP_DATABASE_URL is required']);
  // openPool refuses a superuser, a role that bypasses RLS, or anything but affidavit_app.
  const pool = await openPool(config.databaseUrl, 'affidavit_app', () => undefined);
  return new PgCaseBackend(pool, { ownsPool: true });
}

/**
 * Builds and starts the server. With dev auth it refuses to keep running unless the address it
 * actually bound is loopback (the host name could resolve elsewhere).
 */
export async function startServer(
  config: ApiConfig,
  extra: Omit<BuildAppOptions, 'config' | 'backend'> & { backend?: CaseBackend } = {},
): Promise<FastifyInstance> {
  if (config.auth.mode === 'dev' && !isLoopbackHost(config.host)) {
    throw new ConfigError(['AFFIDAVIT_AUTH=dev only listens on a loopback address']);
  }
  const backend = extra.backend ?? (await backendFromConfig(config));
  const app = await buildApp({ ...extra, config, backend });
  app.addHook('onClose', async () => {
    await backend.close();
  });
  await app.listen({ host: config.host, port: config.port });
  const addr = app.server.address() as AddressInfo | null;
  if (config.auth.mode === 'dev' && (!addr || !isLoopbackHost(addr.address))) {
    await app.close();
    throw new ConfigError(['AFFIDAVIT_AUTH=dev bound a non-loopback address; refusing to serve']);
  }
  return app;
}
