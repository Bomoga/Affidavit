import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadApiConfig } from './config.js';
import { startServer } from './server.js';
import { CLIENT_SECRET, SESSION_SECRET, devConfig } from './test-helpers.js';

const GITHUB_ENV = {
  AFFIDAVIT_AUTH: 'github',
  GITHUB_OAUTH_CLIENT_ID: 'Iv1.testclient',
  GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL: 'https://api.example.test/auth/github/callback',
  AFFIDAVIT_SESSION_SECRET: SESSION_SECRET,
  AFFIDAVIT_APP_DATABASE_URL: 'postgres://affidavit_app:pw-very-secret@db.internal:5432/affidavit',
};

function refusal(env: Record<string, string>): ConfigError {
  try {
    loadApiConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('auth selection refuses unsafe starts', () => {
  it('refuses to start without AFFIDAVIT_AUTH', () => {
    expect(refusal({}).message).toMatch(/AFFIDAVIT_AUTH is required/);
  });

  it('refuses an unknown auth mode', () => {
    expect(refusal({ AFFIDAVIT_AUTH: 'none' }).message).toMatch(/must be "dev" or "github"/);
  });

  it('dev auth starts on loopback with the fixed dev tenant and the memory store', () => {
    const c = loadApiConfig({ AFFIDAVIT_AUTH: 'dev' });
    expect(c.host).toBe('127.0.0.1');
    expect(c.auth).toEqual({ mode: 'dev', tenantId: 'tenant-dev' });
    expect(c.store).toBe('memory');
    for (const host of ['127.0.0.1', '::1', 'localhost', '127.1.2.3', '[::1]']) {
      expect(loadApiConfig({ AFFIDAVIT_AUTH: 'dev', AFFIDAVIT_API_HOST: host }).host).toBe(host);
    }
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com', '10.0.0.1'])(
    'dev auth refuses the non-loopback host %s',
    (host) => {
      expect(refusal({ AFFIDAVIT_AUTH: 'dev', AFFIDAVIT_API_HOST: host }).message).toMatch(
        /AFFIDAVIT_AUTH=dev only listens on a loopback address/,
      );
    },
  );

  it.each([
    ['GITHUB_OAUTH_CLIENT_ID'],
    ['GITHUB_OAUTH_CLIENT_SECRET'],
    ['AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL'],
    ['AFFIDAVIT_SESSION_SECRET'],
  ])('github auth refuses to start without %s', (name) => {
    const env: Record<string, string> = { ...GITHUB_ENV };
    delete env[name];
    expect(refusal(env).message).toContain(name);
  });

  it('github auth starts with every credential set', () => {
    const c = loadApiConfig(GITHUB_ENV);
    expect(c.auth.mode).toBe('github');
    expect(c.store).toBe('postgres');
  });

  it('refusal messages name variables, never secret values', () => {
    const env: Record<string, string> = {
      ...GITHUB_ENV,
      AFFIDAVIT_SESSION_SECRET: 'short-but-secret',
      AFFIDAVIT_API_STORE: 'memory',
      AFFIDAVIT_GITHUB_WEBHOOK_SECRET: 'tiny',
    };
    const msg = refusal(env).message;
    expect(msg).toMatch(/AFFIDAVIT_SESSION_SECRET/);
    expect(msg).toMatch(/AFFIDAVIT_API_STORE=memory is for AFFIDAVIT_AUTH=dev only/);
    for (const secret of [CLIENT_SECRET, 'short-but-secret', 'pw-very-secret', 'tiny']) {
      expect(msg).not.toContain(secret);
    }
  });

  it('github auth refuses a redirect URL over plain http to a public host', () => {
    expect(
      refusal({ ...GITHUB_ENV, AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL: 'http://api.example.test/cb' })
        .message,
    ).toMatch(/AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL must be https/);
  });

  it('the postgres store needs a database URL', () => {
    expect(refusal({ AFFIDAVIT_AUTH: 'dev', AFFIDAVIT_API_STORE: 'postgres' }).message).toMatch(
      /needs AFFIDAVIT_APP_DATABASE_URL/,
    );
  });

  it('web origins must be exact origins', () => {
    expect(
      loadApiConfig({ AFFIDAVIT_AUTH: 'dev', AFFIDAVIT_WEB_ORIGINS: 'http://localhost:5173' })
        .webOrigins,
    ).toEqual(['http://localhost:5173']);
    for (const bad of ['*', 'http://evil.example', 'https://a.test/path', 'https://u:p@a.test']) {
      expect(refusal({ AFFIDAVIT_AUTH: 'dev', AFFIDAVIT_WEB_ORIGINS: bad }).message).toMatch(
        /AFFIDAVIT_WEB_ORIGINS/,
      );
    }
  });
});

describe('isLoopbackHost', () => {
  it('accepts only loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('localhost.evil.test')).toBe(false);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
  });
});

describe('startServer', () => {
  it('refuses dev auth on a non-loopback host even if the config was built by hand', async () => {
    await expect(startServer(devConfig({ host: '0.0.0.0' }))).rejects.toThrow(
      /only listens on a loopback address/,
    );
  });

  it('serves dev auth on loopback', async () => {
    const app = await startServer(devConfig());
    try {
      const addr = app.server.address();
      expect(typeof addr === 'object' && addr !== null && isLoopbackHost(addr.address)).toBe(true);
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
