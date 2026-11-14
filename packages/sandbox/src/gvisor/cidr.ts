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
