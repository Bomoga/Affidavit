import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { promisify } from 'node:util';
import {
  EGRESS_NETWORK,
  PLAIN_RUNTIME,
  RUN_LABEL,
  buildGvisorRunArgs,
  type FetchNetwork,
} from '../gvisor/args.js';
import { inCidr, ipv4ToInt } from '../gvisor/cidr.js';
import { createCaseNetwork, removeCaseNetwork, type CaseNetwork } from '../gvisor/network.js';
import { NPM_REGISTRY } from './lockfile.js';

const exec = promisify(execFile);

/**
 * The image the dependency fetch (`npm ci --ignore-scripts`) and the fetch proxy run from. Owned
 * and pinned by Lane 2, never taken from the target: a target's base image is untrusted, and the
 * fetch step is the only one with a route out, so the npm doing the download must be ours.
 * Debian based (glibc) like the `node` images targets are assembled on, so npm picks the same
 * platform-specific optional packages. Configuration; bump deliberately.
 */
export const FETCH_IMAGE =
  'node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da';

/** The one host and port the fetch proxy forwards to. */
export const FETCH_ALLOW = { host: NPM_REGISTRY, port: 443 } as const;
export const PROXY_ALIAS = 'affidavit-proxy';
export const PROXY_PORT = 3128;

/**
 * IPv4 ranges the proxy must never be pointed at, even if the registry name resolved there
 * (DNS rebinding, a hostile resolver): private, loopback, link-local (169.254/16, cloud metadata),
 * CGNAT, benchmarking, multicast, reserved.
 */
export const NON_PUBLIC_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

/** Null when `ip` is a public IPv4 address the proxy may dial, else why not. */
export function publicIpv4Problem(ip: string): string | null {
  if (ipv4ToInt(ip) === null) return `not an IPv4 address: ${ip}`;
  const range = NON_PUBLIC_V4.find((c) => inCidr(ip, c));
  return range === undefined ? null : `${ip} is in non-public range ${range}`;
}

/** Resolves the registry on the host and keeps only public IPv4 addresses. Throws if none. */
export async function resolveRegistry(
  resolve: (host: string) => Promise<{ address: string }[]> = (h) =>
    lookup(h, { family: 4, all: true }),
): Promise<string[]> {
  const addrs = [...new Set((await resolve(FETCH_ALLOW.host)).map((a) => a.address))].sort();
  const bad = addrs.map(publicIpv4Problem).filter((p): p is string => p !== null);
  if (addrs.length === 0 || bad.length > 0) {
    throw new Error(
      `refusing registry addresses for ${FETCH_ALLOW.host}: ${bad.join('; ') || 'none'}`,
    );
  }
  return addrs;
}

/**
 * The fetch proxy: our code, a few lines of Node. It answers only `CONNECT <registry>:443` and
 * dials one of the addresses the host resolved and checked (it never resolves a name itself).
 * TLS stays end to end between npm and the registry, so the proxy sees no content. Anything else
 * (plain HTTP, another host, another port, an IP literal) gets 403.
 */
export const PROXY_SCRIPT = `
const net = require('net');
const http = require('http');
const host = process.env.AFFIDAVIT_ALLOW_HOST;
const port = process.env.AFFIDAVIT_ALLOW_PORT;
const ips = (process.env.AFFIDAVIT_ALLOW_IPS || '').split(',').filter(Boolean);
if (!host || !port || ips.length === 0) process.exit(2);
let next = 0;
const server = http.createServer((req, res) => { res.statusCode = 403; res.end(); });
server.on('connect', (req, sock, head) => {
  sock.on('error', () => {});
  if (String(req.url).toLowerCase() !== host + ':' + port) {
    sock.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
    return;
  }
  const ip = ips[next++ % ips.length];
  const up = net.connect(Number(port), ip, () => {
    sock.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head && head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on('error', () => sock.destroy());
  sock.on('close', () => up.destroy());
});
server.listen(${PROXY_PORT}, '0.0.0.0');
`;

/** Environment that points npm at the proxy for every request. */
export const npmProxyEnv = (): Record<string, string> => ({
  npm_config_proxy: `http://${PROXY_ALIAS}:${PROXY_PORT}`,
  npm_config_https_proxy: `http://${PROXY_ALIAS}:${PROXY_PORT}`,
  npm_config_noproxy: '',
});

/** Args for `docker network create` of a per-build egress bridge. Pure, for tests. */
export function egressNetworkArgs(name: string, runId: string): string[] {
  if (!EGRESS_NETWORK.test(name)) throw new Error(`not an egress network name: ${name}`);
  return [
    'network',
    'create',
    '--driver',
    'bridge',
    '--ipv6=false',
    '--opt',
    'com.docker.network.bridge.enable_icc=false',
    '--label',
    `${RUN_LABEL}=${runId}`,
    name,
  ];
}

/** Args for `docker create` of the proxy on the egress bridge. Pure, for tests. */
export function proxyCreateArgs(
  name: string,
  runId: string,
  egress: string,
  ips: readonly string[],
): string[] {
  for (const ip of ips) {
    const p = publicIpv4Problem(ip);
    if (p !== null) throw new Error(p);
  }
  if (ips.length === 0) throw new Error('the proxy needs at least one registry address');
  const args = buildGvisorRunArgs({
    name,
    runId,
    image: FETCH_IMAGE,
    command: ['node', '-e', PROXY_SCRIPT],
    mounts: [],
    runtime: PLAIN_RUNTIME,
    egress,
    env: {
      AFFIDAVIT_ALLOW_HOST: FETCH_ALLOW.host,
      AFFIDAVIT_ALLOW_PORT: String(FETCH_ALLOW.port),
      AFFIDAVIT_ALLOW_IPS: ips.join(','),
    },
    limits: { memoryMb: 256, pids: 64, cpus: 1, scratchMb: 16 },
  });
  return ['create', ...args.slice(1)];
}

/** One build's fetch setup: an internal network for npm, an egress bridge, and the proxy. */
export interface FetchEnv {
  net: CaseNetwork;
  egress: string;
  /** What the fetch step's run spec joins. */
  fetch: FetchNetwork;
}

/**
 * Creates the per-build fetch setup. Nothing here is shared across builds or cases:
 * - npm joins a fresh case network (internal, IPv6 off, the host bridge has no address), so an
 *   IP literal, the bridge gateway, RFC1918 and link-local addresses are all unreachable;
 * - the proxy joins that network and a fresh egress bridge (IPv6 off), and forwards only to the
 *   registry on 443 at the addresses checked above.
 */
export async function createFetchEnv(ips: readonly string[]): Promise<FetchEnv> {
  const net = await createCaseNetwork();
  const egress = `affidavit-egress-${net.runId}`;
  try {
    await exec('docker', egressNetworkArgs(egress, net.runId));
    const { stdout } = await exec('docker', [
      'network',
      'inspect',
      '--format',
      '{{.EnableIPv6}}',
      egress,
    ]);
    if (stdout.trim() !== 'false') throw new Error(`egress network ${egress} has IPv6 enabled`);
    const name = `affidavit-proxy-${randomBytes(8).toString('hex')}`;
    await exec('docker', proxyCreateArgs(name, net.runId, egress, ips));
    await exec('docker', ['network', 'connect', net.name, name]);
    await exec('docker', ['start', name]);
    const ip = (
      await exec('docker', [
        'inspect',
        '--format',
        `{{(index .NetworkSettings.Networks "${net.name}").IPAddress}}`,
        name,
      ])
    ).stdout.trim();
    if (ipv4ToInt(ip) === null || !inCidr(ip, net.subnet)) {
      throw new Error(`fetch proxy has no address on ${net.name}: ${ip}`);
    }
    await waitListening(name);
    return { net, egress, fetch: { name: net.name, proxy: { host: PROXY_ALIAS, ip } } };
  } catch (err) {
    await removeFetchEnv({
      net,
      egress,
      fetch: { name: net.name, proxy: { host: PROXY_ALIAS, ip: '0.0.0.0' } },
    });
    throw err;
  }
}

async function waitListening(name: string): Promise<void> {
  const probe = `require('net').connect(${PROXY_PORT}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await exec('docker', ['exec', name, 'node', '-e', probe], { timeout: 10_000 });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`fetch proxy ${name} did not start listening`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Removes the proxy, the egress bridge and the internal network, and checks nothing is left. */
export async function removeFetchEnv(env: FetchEnv): Promise<void> {
  const filter = `label=${RUN_LABEL}=${env.net.runId}`;
  const { stdout } = await exec('docker', ['ps', '--all', '--quiet', '--filter', filter]);
  const ids = stdout.split('\n').filter((l) => l !== '');
  if (ids.length > 0) await exec('docker', ['rm', '--force', '--volumes', ...ids]);
  await exec('docker', ['network', 'rm', env.egress]).catch(() => undefined);
  await removeCaseNetwork(env.net);
}
