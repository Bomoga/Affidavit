import { describe, expect, it } from 'vitest';
import {
  inCidr,
  inCidr6,
  ipv4ToInt,
  ipv6ToBigInt,
  isIpv4Cidr,
  isIpv6Cidr,
  mappedIpv4,
} from './cidr.js';

describe('ipv6ToBigInt', () => {
  it('parses full, compressed and dotted-tail forms', () => {
    expect(ipv6ToBigInt('::')).toBe(0n);
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('fd00::2')).toBe((0xfd00n << 112n) | 2n);
    expect(ipv6ToBigInt('0:0:0:0:0:0:0:1')).toBe(1n);
    expect(ipv6ToBigInt('::ffff:172.18.0.2')).toBe((0xffffn << 32n) | 0xac120002n);
    expect(ipv6ToBigInt('fe80::1%eth0')).toBe((0xfe80n << 112n) | 1n);
  });

  it.each([
    '',
    ':::',
    '1::2::3',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    'g::1',
    '1.2.3.4::',
    '::12345',
  ])('rejects %j', (ip) => {
    expect(ipv6ToBigInt(ip)).toBeNull();
  });
});

describe('inCidr6 and mappedIpv4', () => {
  it('matches IPv6 addresses inside the subnet only', () => {
    expect(inCidr6('fd00:1::5', 'fd00:1::/64')).toBe(true);
    expect(inCidr6('fd00:2::5', 'fd00:1::/64')).toBe(false);
    expect(inCidr6('2001:db8::1', '::/0')).toBe(true);
    expect(inCidr6('::1', '::1/128')).toBe(true);
  });

  it('is false for malformed input rather than true', () => {
    expect(inCidr6('fd00::1', 'fd00::')).toBe(false);
    expect(inCidr6('fd00::1', 'fd00::/129')).toBe(false);
    expect(inCidr6('nope', '::/0')).toBe(false);
  });

  it('recognises an IPv6 CIDR', () => {
    expect(isIpv6Cidr('fd00::/64')).toBe(true);
    expect(isIpv6Cidr('172.18.0.0/16')).toBe(false);
    expect(isIpv6Cidr('fd00::/200')).toBe(false);
  });

  it('extracts the IPv4 address from an IPv4-mapped IPv6 address only', () => {
    expect(mappedIpv4('::ffff:172.18.0.1')).toBe('172.18.0.1');
    expect(mappedIpv4('::ffff:ac12:1')).toBe('172.18.0.1');
    expect(mappedIpv4('fd00::1')).toBeNull();
    expect(mappedIpv4('::1')).toBeNull();
  });
});

describe('ipv4ToInt', () => {
  it('parses dotted quads strictly', () => {
    expect(ipv4ToInt('172.18.0.2')).toBe(0xac120002);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
  });

  it.each(['256.0.0.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.-4', ' 1.2.3.4', 'a.b.c.d', ''])(
    'rejects %j',
    (ip) => {
      expect(ipv4ToInt(ip)).toBeNull();
    },
  );
});

describe('inCidr', () => {
  it('matches addresses inside the subnet only', () => {
    expect(inCidr('172.18.0.2', '172.18.0.0/16')).toBe(true);
    expect(inCidr('172.18.255.255', '172.18.0.0/16')).toBe(true);
    expect(inCidr('172.19.0.1', '172.18.0.0/16')).toBe(false);
    expect(inCidr('172.17.0.1', '172.18.0.0/16')).toBe(false);
  });

  it('handles /0 and /32', () => {
    expect(inCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(inCidr('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(inCidr('10.0.0.2', '10.0.0.1/32')).toBe(false);
  });

  it('is false for malformed input rather than true', () => {
    expect(inCidr('172.18.0.2', '172.18.0.0')).toBe(false);
    expect(inCidr('172.18.0.2', '172.18.0.0/33')).toBe(false);
    expect(inCidr('not-an-ip', '0.0.0.0/0')).toBe(false);
  });

  it('recognises an IPv4 CIDR', () => {
    expect(isIpv4Cidr('172.18.0.0/16')).toBe(true);
    expect(isIpv4Cidr('fd00::/64')).toBe(false);
    expect(isIpv4Cidr('172.18.0.0/40')).toBe(false);
  });
});
