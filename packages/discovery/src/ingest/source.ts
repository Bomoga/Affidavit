import { lookup } from 'node:dns/promises';
import { statSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IngestInputError } from './types.js';

/** Returns every address a host name resolves to. Injectable so tests need no network. */
export type HostResolver = (host: string) => Promise<readonly string[]>;

export const systemResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type SourcePlan =
  | {
      kind: 'https';
      /** Normalised URL, handed to git after `--`. */
      url: string;
      host: string;
      port: number;
      /** The address that was checked. git is pinned to it (http.curloptResolve). */
      ip: string;
    }
  | { kind: 'local'; path: string };

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible range
  ['64:ff9b::', 96], // NAT64: embeds an IPv4 address
  ['64:ff9b:1::', 48],
  ['fe80::', 10],
  ['fc00::', 7],
  ['ff00::', 8],
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['2001::', 32], // Teredo
] as const) {
  BLOCKED.addSubnet(net, bits, 'ipv6');
}

/** Expands an IPv6 text form to eight 16 bit groups (undefined if it is not valid). */
function groups(ip: string): number[] | undefined {
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4?.[1]) {
    const p = v4[1].split('.').map(Number);
    if (p.some((n) => n > 255)) return undefined;
    const hi = (((p[0] ?? 0) << 8) | (p[1] ?? 0)).toString(16);
    const lo = (((p[2] ?? 0) << 8) | (p[3] ?? 0)).toString(16);
    s = `${s.slice(0, -v4[1].length)}${hi}:${lo}`;
  }
  const [head, tail, extra] = s.split('::');
  if (extra !== undefined) return undefined;
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  if (fill < 0 || (!s.includes('::') && h.length !== 8)) return undefined;
  const all = [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? all
    : undefined;
}

/** Maps `::ffff:a.b.c.d` (either spelling) to the IPv4 address it stands for. */
export function unmapV4(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const g = groups(ip);
  if (g && g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const [a = 0, b = 0] = [g[6], g[7]];
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return ip;
}

export function isBlockedAddress(ip: string): boolean {
  const addr = unmapV4(ip);
  const family = isIP(addr);
  if (family === 0) return true; // anything we cannot parse is not allowed
  return BLOCKED.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

export interface PlanOptions {
  allowLocal: boolean;
  /** Ports a source URL may use. Default [443]. */
  allowedPorts?: readonly number[] | undefined;
  resolve?: HostResolver | undefined;
}

/**
 * Validates a clone source and, for https, resolves the host and checks EVERY address it
 * returns. The checked address travels in the plan so git can be pinned to it: a name that
 * resolves to a public address now cannot resolve to a loopback address when git connects. The
 * clone runs on the host through execFile (not in a jail), so this check is the SSRF defence.
 * A URL with credentials is refused so a token can never reach a log line or an error message.
 */
export async function planSource(source: string, o: PlanOptions): Promise<SourcePlan> {
  if (source.length === 0 || source.length > 2048 || /[\0\r\n]/.test(source)) {
    throw new IngestInputError('source is empty, too long, or has control characters');
  }
  if (o.allowLocal) {
    const local = localPath(source);
    if (local !== undefined) return { kind: 'local', path: local };
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new IngestInputError('source is not a valid https URL');
  }
  if (url.protocol !== 'https:') throw new IngestInputError('source must be an https URL');
  if (url.username !== '' || url.password !== '') {
    throw new IngestInputError('source URL must not carry credentials');
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (!(o.allowedPorts ?? [443]).includes(port)) {
    throw new IngestInputError('source port is not allowed');
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (host === '') throw new IngestInputError('source host is empty');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new IngestInputError('source host is not allowed');
  }
  const literal = isIP(host) !== 0;
  let addresses: readonly string[];
  if (literal) addresses = [host];
  else {
    try {
      addresses = await (o.resolve ?? systemResolver)(host);
    } catch {
      throw new IngestInputError('source host does not resolve');
    }
  }
  if (addresses.length === 0) throw new IngestInputError('source host does not resolve');
  if (addresses.some(isBlockedAddress)) throw new IngestInputError('source host is not allowed');
  return { kind: 'https', url: url.toString(), host, port, ip: unmapV4(addresses[0] as string) };
}

function localPath(source: string): string | undefined {
  let path: string | undefined;
  if (/^file:/i.test(source)) {
    let u: URL;
    try {
      u = new URL(source);
    } catch {
      throw new IngestInputError('local source is not a valid file URL');
    }
    if (u.host !== '' && u.host.toLowerCase() !== 'localhost') {
      throw new IngestInputError('local source must not name a remote host');
    }
    try {
      path = fileURLToPath(source);
    } catch {
      throw new IngestInputError('local source is not a usable file URL');
    }
  } else if (isAbsolute(source)) path = source;
  if (path === undefined) return undefined;
  if (/^(?:\\\\|\/\/)/.test(path) || /^(?:\\\\|\/\/)/.test(source)) {
    throw new IngestInputError('local source must not be a network (UNC) path');
  }
  let ok: boolean;
  try {
    ok = statSync(path).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new IngestInputError('local source is not a directory');
  return path;
}
