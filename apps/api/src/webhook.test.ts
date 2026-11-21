import { describe, expect, it } from 'vitest';
import type { GithubWebhook } from './app.js';
import { WEBHOOK_SECRET, devConfig, makeApp } from './test-helpers.js';
import { signGithubBody, verifyGithubSignature } from './webhook.js';

const BODY = JSON.stringify({ action: 'opened', number: 1 });
const headers = (sig: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-hub-signature-256': sig,
  'x-github-event': 'pull_request',
  'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  ...extra,
});

describe('POST /webhooks/github', () => {
  it('accepts a correctly signed delivery and hands the parsed request to the handler', async () => {
    const seen: GithubWebhook[] = [];
    const { app } = await makeApp(devConfig(), {
      onWebhook: (h) => {
        seen.push(h);
        return Promise.resolve();
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: headers(signGithubBody(WEBHOOK_SECRET, BODY)),
      payload: BODY,
    });
    expect(res.statusCode).toBe(202);
    expect(seen).toEqual([
      {
        event: 'pull_request',
        deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
        payload: { action: 'opened', number: 1 },
      },
    ]);
    await app.close();
  });

  it.each([
    ['a wrong secret', signGithubBody('another-secret-value-123', BODY)],
    [
      'a tampered digest',
      signGithubBody(WEBHOOK_SECRET, BODY).replace(/.$/, (c) => (c === '0' ? '1' : '0')),
    ],
    ['the sha1 header format', 'sha1=0123456789abcdef0123456789abcdef01234567'],
    ['an empty header', ''],
    ['uppercase hex', signGithubBody(WEBHOOK_SECRET, BODY).toUpperCase()],
  ])('rejects %s with 401 before parsing', async (_name, sig) => {
    let called = false;
    const { app } = await makeApp(devConfig(), {
      onWebhook: () => {
        called = true;
        return Promise.resolve();
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: headers(sig),
      payload: BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'bad-signature' });
    expect(called).toBe(false);
    await app.close();
  });

  it('rejects a missing signature header and a body signed for different bytes', async () => {
    const { app } = await makeApp(devConfig());
    const h = headers('');
    delete (h as Record<string, string>)['x-hub-signature-256'];
    const missing = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: h,
      payload: BODY,
    });
    expect(missing.statusCode).toBe(401);
    const other = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: headers(signGithubBody(WEBHOOK_SECRET, BODY)),
      payload: `${BODY} `,
    });
    expect(other.statusCode).toBe(401);
    await app.close();
  });

  it('a signed but malformed delivery is a fixed 400', async () => {
    const { app } = await makeApp(devConfig());
    const notJson = 'not json';
    const r1 = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: headers(signGithubBody(WEBHOOK_SECRET, notJson)),
      payload: notJson,
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: headers(signGithubBody(WEBHOOK_SECRET, BODY), { 'x-github-event': '<script>' }),
      payload: BODY,
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.body).toBe('{"error":"bad-request"}');
    await app.close();
  });

  it('answers 503 when no webhook secret is configured', async () => {
    const config = devConfig();
    delete config.webhookSecret;
    const { app } = await makeApp(config);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: headers(signGithubBody(WEBHOOK_SECRET, BODY)),
      payload: BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'webhooks-disabled' });
    await app.close();
  });

  it('caps the webhook body size', async () => {
    const { app } = await makeApp(devConfig());
    const big = JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: headers(signGithubBody(WEBHOOK_SECRET, big)),
      payload: big,
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it('verifyGithubSignature is false for non-string headers', () => {
    expect(verifyGithubSignature(WEBHOOK_SECRET, Buffer.from(BODY), undefined)).toBe(false);
    expect(verifyGithubSignature(WEBHOOK_SECRET, Buffer.from(BODY), ['a', 'b'])).toBe(false);
  });
});
