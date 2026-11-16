import { describe, expect, it } from 'vitest';
import { assertHostNotOnSubnet, parseCaseNetworkInspect } from './network.js';

const iface6 = (address: string) => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6' as const,
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0,
});

const iface = (address: string) => ({
  address,
  netmask: '255.255.0.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: `${address}/16`,
});

describe('assertHostNotOnSubnet', () => {
  it('passes when no host address is inside the case subnet', () => {
    expect(() =>
      assertHostNotOnSubnet('172.18.0.0/16', {
        eth0: [iface('192.168.4.23')],
        docker0: [iface('172.17.0.1')],
      }),
    ).not.toThrow();
  });

  it('fails when the host has an address on the case network (a bridge gateway)', () => {
    expect(() =>
      assertHostNotOnSubnet('172.18.0.0/16', { 'br-62334ae875a0': [iface('172.18.0.1')] }),
    ).toThrow(/host interface br-62334ae875a0 has 172.18.0.1/);
  });

  it('fails when the host has an IPv4-mapped IPv6 address inside an IPv4 case subnet', () => {
    expect(() =>
      assertHostNotOnSubnet('172.18.0.0/16', { br0: [iface6('::ffff:172.18.0.1')] }),
    ).toThrow(/host interface br0 has ::ffff:172.18.0.1/);
  });

  it('ignores ordinary IPv6 host addresses for an IPv4 case subnet', () => {
    expect(() =>
      assertHostNotOnSubnet('172.18.0.0/16', { eth0: [iface6('fe80::1%eth0'), iface6('::1')] }),
    ).not.toThrow();
  });

  it('checks IPv6 host addresses against an IPv6 subnet', () => {
    expect(() => assertHostNotOnSubnet('fd00:1::/64', { br1: [iface6('fd00:1::1')] })).toThrow(
      /host interface br1 has fd00:1::1/,
    );
    expect(() =>
      assertHostNotOnSubnet('fd00:1::/64', { eth0: [iface6('fd00:2::1'), iface('172.18.0.1')] }),
    ).not.toThrow();
  });

  it('accepts the numeric family older Node versions report', () => {
    const numeric = { ...iface('172.18.0.1'), family: 4 as unknown as 'IPv4' };
    expect(() => assertHostNotOnSubnet('172.18.0.0/16', { br2: [numeric] })).toThrow(/br2/);
  });

  it('refuses a subnet that is not a CIDR', () => {
    expect(() => assertHostNotOnSubnet('172.18.0.0', {})).toThrow(/not a CIDR/);
  });
});

describe('parseCaseNetworkInspect', () => {
  it('accepts an internal network with IPv6 off and one IPv4 subnet', () => {
    expect(parseCaseNetworkInspect('n', 'true false 172.18.0.0/16 \n')).toEqual(['172.18.0.0/16']);
  });

  it.each([
    ['not internal', 'false false 172.18.0.0/16', /not internal/],
    ['IPv6 enabled', 'true true 172.18.0.0/16', /IPv6 enabled/],
    ['an IPv6 subnet', 'true false 172.18.0.0/16 fd00::/64', /not IPv4: fd00::\/64/],
    ['no subnet', 'true false', /no subnet/],
    ['garbage', 'true false not-a-subnet', /not IPv4/],
    ['an unknown IPv6 flag', 'true <no value> 172.18.0.0/16', /IPv6 enabled/],
  ])('refuses a network with %s', (_name, out, why) => {
    expect(() => parseCaseNetworkInspect('n', out)).toThrow(why);
  });
});
