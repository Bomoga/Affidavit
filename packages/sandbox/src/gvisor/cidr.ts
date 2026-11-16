/** Strict dotted-quad IPv4 to a 32-bit unsigned integer, or null. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** True when `ip` is an IPv4 address inside `cidr` (for example `172.18.0.0/16`). */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const addr = ipv4ToInt(ip);
  const net = ipv4ToInt(base ?? '');
  const bits = Number(bitsText);
  if (addr === null || net === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const size = 2 ** (32 - bits);
  return Math.floor(addr / size) === Math.floor(net / size);
}

export const isIpv4Cidr = (cidr: string): boolean => {
  const [base, bits] = cidr.split('/');
  return ipv4ToInt(base ?? '') !== null && /^(\d|[12]\d|3[0-2])$/.test(bits ?? '');
};

/**
 * Strict IPv6 address to a 128-bit unsigned integer, or null. Accepts `::` compression and a
 * dotted-quad tail (`::ffff:1.2.3.4`); a zone id (`fe80::1%eth0`) is ignored.
 */
export function ipv6ToBigInt(ip: string): bigint | null {
  const addr = ip.split('%')[0] ?? '';
  if (addr === '' || !/^[0-9a-fA-F:.]+$/.test(addr)) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const words = (part: string, last: boolean): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] ?? '';
      if (last && i === groups.length - 1 && g.includes('.')) {
        const v4 = ipv4ToInt(g);
        if (v4 === null) return null;
        out.push(Math.floor(v4 / 0x10000), v4 % 0x10000);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(g)) {
        out.push(parseInt(g, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const compressed = halves.length === 2;
  const head = words(halves[0] ?? '', !compressed);
  const tail = compressed ? words(halves[1] ?? '', true) : [];
  if (head === null || tail === null) return null;
  const given = head.length + tail.length;
  if (compressed ? given > 7 : given !== 8) return null;
  const all = [...head, ...new Array<number>(8 - given).fill(0), ...tail];
  return all.reduce((n, w) => (n << 16n) | BigInt(w), 0n);
}

/** True when `ip` is an IPv6 address inside the IPv6 `cidr` (for example `fd00::/64`). */
export function inCidr6(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const addr = ipv6ToBigInt(ip);
  const net = ipv6ToBigInt(base ?? '');
  if (addr === null || net === null || !/^\d{1,3}$/.test(bitsText ?? '')) return false;
  const bits = Number(bitsText);
  if (bits > 128) return false;
  const shift = BigInt(128 - bits);
  return addr >> shift === net >> shift;
}

export const isIpv6Cidr = (cidr: string): boolean => {
  const [base, bits] = cidr.split('/');
  return ipv6ToBigInt(base ?? '') !== null && /^\d{1,3}$/.test(bits ?? '') && Number(bits) <= 128;
};

/** The IPv4 address carried by an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`), or null. */
export function mappedIpv4(ip: string): string | null {
  const n = ipv6ToBigInt(ip);
  if (n === null || n >> 32n !== 0xffffn) return null;
  const v4 = Number(n & 0xffffffffn);
  return [24, 16, 8, 0].map((s) => (v4 >>> s) & 0xff).join('.');
}
