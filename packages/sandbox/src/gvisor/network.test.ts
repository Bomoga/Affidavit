import { describe, expect, it } from 'vitest';
import { assertHostNotOnSubnet } from './network.js';

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
});
