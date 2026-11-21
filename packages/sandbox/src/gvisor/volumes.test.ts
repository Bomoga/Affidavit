import { describe, expect, it } from 'vitest';
import {
  assertNoImageVolumes,
  parseContainerVolumes,
  parseImageVolumes,
  uncoveredVolumes,
} from './volumes.js';

describe('uncoveredVolumes', () => {
  it('is empty when every declared volume has a tmpfs over it', () => {
    expect(
      uncoveredVolumes(
        ['/data/db', '/data/configdb'],
        [{ path: '/data/db/' }, { path: '/data/configdb' }],
      ),
    ).toEqual([]);
  });

  it('lists volumes with no tmpfs exactly over them (a parent or child path does not count)', () => {
    expect(
      uncoveredVolumes(['/data/db', '/var/lib/x'], [{ path: '/data' }, { path: '/var/lib/x/y' }]),
    ).toEqual(['/data/db', '/var/lib/x']);
  });
});

describe('parseImageVolumes', () => {
  it('reads no volumes from null or an empty object', () => {
    expect(parseImageVolumes('null\n')).toEqual([]);
    expect(parseImageVolumes('{}')).toEqual([]);
  });

  it('lists declared volume paths', () => {
    expect(parseImageVolumes('{"/data":{},"/cache":{}}')).toEqual(['/cache', '/data']);
  });

  it.each(['', 'not json', '[]', '"x"', '42'])('fails closed on %j', (json) => {
    expect(() => parseImageVolumes(json)).toThrow();
  });
});

describe('assertNoImageVolumes', () => {
  it('accepts an image without volumes', () => {
    expect(() => assertNoImageVolumes('node:24', 'null')).not.toThrow();
  });

  it('refuses an image that declares a volume', () => {
    expect(() => assertNoImageVolumes('evil:1', '{"/data":{}}')).toThrow(
      /declares volumes.*\/data/,
    );
  });
});

describe('parseContainerVolumes', () => {
  it('keeps only volume mounts', () => {
    const mounts = JSON.stringify([
      { Type: 'bind', Source: '/work', Destination: '/src' },
      { Type: 'tmpfs', Destination: '/scratch' },
      { Type: 'volume', Name: 'abc123', Destination: '/data' },
    ]);
    expect(parseContainerVolumes(mounts)).toEqual(['abc123']);
  });

  it('reads no volumes from null or an empty list', () => {
    expect(parseContainerVolumes('null')).toEqual([]);
    expect(parseContainerVolumes('[]')).toEqual([]);
  });

  it.each(['', '{}', '[1]', '[{"Type":"volume"}]', '[{"Type":"volume","Name":""}]'])(
    'fails closed on %j',
    (json) => {
      expect(() => parseContainerVolumes(json)).toThrow();
    },
  );
});
