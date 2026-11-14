import { describe, expect, it } from 'vitest';
import { inCidr, ipv4ToInt, isIpv4Cidr } from './cidr.js';

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
