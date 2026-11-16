import { describe, expect, it } from 'vitest';
import { PLAIN_RUNTIME, RUN_LABEL } from '../gvisor/args.js';
import {
  FETCH_ALLOW,
  FETCH_IMAGE,
  PROXY_ALIAS,
  PROXY_PORT,
  egressNetworkArgs,
  npmProxyEnv,
  proxyCreateArgs,
  publicIpv4Problem,
  resolveRegistry,
} from './fetch.js';

const EGRESS = 'affidavit-egress-0123456789abcdef';
const RUN = '0123456789abcdef';

describe('fetch image and allowlist', () => {
  it('pins the fetch image by digest and allows only the npm registry on 443', () => {
    expect(FETCH_IMAGE).toMatch(/^node:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(FETCH_ALLOW).toEqual({ host: 'registry.npmjs.org', port: 443 });
  });

  it('points npm at the proxy for both schemes', () => {
    const env = npmProxyEnv();
    expect(env.npm_config_proxy).toBe(`http://${PROXY_ALIAS}:${PROXY_PORT}`);
    expect(env.npm_config_https_proxy).toBe(`http://${PROXY_ALIAS}:${PROXY_PORT}`);
  });
});

describe('publicIpv4Problem', () => {
  it.each(['104.16.0.35', '8.8.8.8', '1.1.1.1'])('accepts public %s', (ip) =>
    expect(publicIpv4Problem(ip)).toBeNull(),
  );
  it.each([
    '10.0.0.1',
    '172.17.0.1',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    'registry.npmjs.org',
    '',
  ])('refuses %j', (ip) => expect(publicIpv4Problem(ip)).not.toBeNull());
});

describe('resolveRegistry', () => {
  it('returns the sorted, de-duplicated public addresses of the registry', async () => {
    const asked: string[] = [];
    const ips = await resolveRegistry((h) => {
      asked.push(h);
      return Promise.resolve([
        { address: '104.16.2.35' },
        { address: '104.16.1.35' },
        { address: '104.16.2.35' },
      ]);
    });
    expect(asked).toEqual(['registry.npmjs.org']);
    expect(ips).toEqual(['104.16.1.35', '104.16.2.35']);
  });

  it('refuses the whole answer if any address is not public (rebinding)', async () => {
    await expect(
      resolveRegistry(() =>
        Promise.resolve([{ address: '104.16.1.35' }, { address: '169.254.169.254' }]),
      ),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('refuses an empty answer', async () => {
    await expect(resolveRegistry(() => Promise.resolve([]))).rejects.toThrow(/none/);
  });
});

describe('egressNetworkArgs', () => {
  it('creates a labelled bridge with IPv6 off and no inter-container traffic', () => {
    const args = egressNetworkArgs(EGRESS, RUN);
    expect(args.slice(0, 2)).toEqual(['network', 'create']);
    expect(args).toContain('--ipv6=false');
    expect(args).toContain('com.docker.network.bridge.enable_icc=false');
    expect(args).toContain(`${RUN_LABEL}=${RUN}`);
    expect(args.at(-1)).toBe(EGRESS);
    expect(args).not.toContain('--internal');
  });

  it.each(['bridge', 'host', 'affidavit-egress-xyz', 'affidavit-case-0123456789abcdef'])(
    'refuses %s',
    (name) => expect(() => egressNetworkArgs(name, RUN)).toThrow(),
  );
});

describe('proxyCreateArgs', () => {
  const args = proxyCreateArgs('affidavit-proxy-1', RUN, EGRESS, ['104.16.1.35', '104.16.2.35']);
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  it('creates (not runs) the proxy from the fetch image on the egress bridge', () => {
    expect(args[0]).toBe('create');
    expect(args).not.toContain('run');
    expect(args).toContain(FETCH_IMAGE);
    expect(after('--network')).toBe(EGRESS);
    expect(after('--runtime')).toBe(PLAIN_RUNTIME);
    expect(args.filter((a) => a === '--network')).toHaveLength(1);
  });

  it('passes the allowed host, port and checked addresses, and no DNS', () => {
    expect(args).toContain(`AFFIDAVIT_ALLOW_HOST=${FETCH_ALLOW.host}`);
    expect(args).toContain('AFFIDAVIT_ALLOW_PORT=443');
    expect(args).toContain('AFFIDAVIT_ALLOW_IPS=104.16.1.35,104.16.2.35');
    expect(after('--dns')).toBe('0.0.0.0');
  });

  it('refuses private addresses and an empty list', () => {
    expect(() => proxyCreateArgs('p', RUN, EGRESS, ['172.17.0.1'])).toThrow(/non-public/);
    expect(() => proxyCreateArgs('p', RUN, EGRESS, [])).toThrow(/at least one/);
  });
});
