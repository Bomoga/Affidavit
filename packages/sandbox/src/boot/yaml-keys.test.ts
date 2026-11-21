import { describe, expect, it } from 'vitest';
import { precheckCompose, selectServices } from './compose.js';
import { scanYamlKeys } from './yaml-keys.js';

/**
 * Parser differentials: inputs where a YAML parser (Compose uses go-yaml) reads a key that a
 * scanner skipping text as a block scalar, a comment or a plain scalar would miss. The scanner is
 * a security check, so each one must be refused outright.
 */
describe('scanYamlKeys refuses what it does not fully understand', () => {
  it.each([
    [
      // YAML: the mapping inside the sequence entry sits at column 4, so `env_file` (column 4)
      // ends the empty block scalar and is a sibling key of `a`.
      'a block scalar whose header follows "- "',
      'services:\n  web:\n    x-list:\n      - a: |\n        env_file: /etc/shadow\n',
    ],
    ['a block scalar right after "- "', 'services:\n  web:\n    command:\n      - |\n        x\n'],
    ['a block scalar after an anchor', 'services:\n  web:\n    command: &c |\n      x\n'],
    ['a block scalar in a flow collection', 'services: {web: {command: |}}'],
    [
      'a block scalar with an indentation indicator',
      'services:\n  web:\n    command: |2\n      x\n',
    ],
    ['a block scalar with text on its header line', 'services:\n  web:\n    command: | x\n'],
    [
      'a block scalar with no content line',
      'services:\n  web:\n    command: |\n    env_file: /etc/shadow\n',
    ],
    [
      'a block scalar whose content dedents below its first line',
      'services:\n  web:\n    command: |\n        x\n      env_file: /etc/shadow\n',
    ],
    ['an anchor', 'x-base: &base\n  restart: always\nservices: {}\n'],
    ['an alias', 'x-base: {}\nservices:\n  web: *base\n'],
    ['a merge key', 'services:\n  web:\n    <<: {}\n    build: .\n'],
    ['a quoted merge key', 'services:\n  web:\n    "<<": {}\n'],
    ['a flow collection spanning lines', 'services: {web: {build: .,\n  env_file: x}}\n'],
    [
      // go-yaml treats a bare CR as a line break, so the comment ends there.
      'a bare carriage return inside a comment',
      'services:\n  web:\n    build: . # note\renv_file: /etc/shadow\n',
    ],
    ['a NEL line break', 'services:\n  web:\n    image: node\u0085env_file: /etc/shadow\n'],
    ['a line separator', 'services:\n  web:\n    image: node\u2028env_file: /etc/shadow\n'],
    ['a paragraph separator', 'services:\n  web:\n    image: node\u2029env_file: /etc/shadow\n'],
    ['a bare carriage return inside a block scalar', 'a: |\n  x\ry: 1\n'],
    // `env_file: null` then a deeper line is one multi-line plain scalar to YAML
    // ("null /../../etc/shadow"), not an empty value (reproduced against Compose v5.5.1).
    [
      'a null value continued on a deeper line',
      'services:\n  web:\n    build: .\n    env_file: null\n      /../../../../etc/shadow\n',
    ],
    [
      'a ~ value continued on a deeper line',
      'services:\n  web:\n    build: .\n    env_file: ~\n      /../../../../etc/shadow\n',
    ],
    [
      'a null label_file continued on a deeper line',
      'services:\n  web:\n    build: .\n    label_file: null\n      /etc/hosts\n',
    ],
    [
      'a null value with a comment, then a deeper line',
      'services:\n  web:\n    build: .\n    env_file: null # none\n      /../../etc/shadow\n',
    ],
    [
      'a null value continued on a tab-indented line',
      'services:\n  web:\n    build: .\n    env_file: null\n\t/../../etc/shadow\n',
    ],
    [
      'an empty flow value followed by a deeper line',
      'services:\n  web:\n    build: .\n    env_file: []\n      /../../etc/shadow\n',
    ],
  ])('%s', (_, text) => {
    expect(scanYamlKeys(text).ok).toBe(false);
    expect(precheckCompose(text)).not.toBeNull();
  });

  it('still reads block scalars owned by a key that starts its line', () => {
    const text =
      'services:\n  web:\n    command: >-\n      echo a\n\n      echo b\n    healthcheck:\n      test: |+ # kept\n        x\n    build: .\n';
    const scan = scanYamlKeys(text);
    expect(scan.ok).toBe(true);
    expect(scan.ok && scan.keys.map((k) => k.name)).toEqual([
      'services',
      'web',
      'command',
      'healthcheck',
      'test',
      'build',
    ]);
  });

  it('trims the first segment of a plain scalar it also reports as a key', () => {
    const scan = scanYamlKeys('services:\n  web:\n    labels:\n      - env_file :/etc/shadow\n');
    expect(scan.ok && scan.keys.map((k) => k.name)).toContain('env_file');
  });

  it('accepts CRLF line endings', () => {
    expect(scanYamlKeys('services:\r\n  web:\r\n    build: .\r\n').ok).toBe(true);
  });
});

describe('selectServices drops host-facing keys only because it never reads them', () => {
  // volumes, privileged, network_mode and devices pass the key precheck (they read no other
  // file), so the only thing keeping them out of the jail is that selectServices ignores them.
  // This pins the exact output: a change that starts reading any of them fails here and must add
  // a host-path check first.
  it('returns exactly the fields it reads, whatever else a service says', () => {
    const hostKeys = {
      volumes: ['/:/host', '/var/run/docker.sock:/var/run/docker.sock'],
      privileged: true,
      network_mode: 'host',
      devices: ['/dev/kvm:/dev/kvm'],
      cap_add: ['ALL'],
      pid: 'host',
    };
    const r = selectServices(
      {
        services: {
          web: { build: { context: '/tree' }, command: ['node', 'x'], ...hostKeys },
          mongo: { image: 'mongo:4.4', ...hostKeys },
        },
      },
      'web',
      '/tree',
    );
    expect(r).toEqual({
      ok: true,
      target: {
        dockerfile: 'Dockerfile',
        command: ['node', 'x'],
        env: {},
        passThrough: [],
        sidecars: [{ name: 'mongo', image: 'mongo:4.4', env: {} }],
      },
    });
    for (const k of Object.keys(hostKeys)) {
      expect(precheckCompose(`services:\n  web:\n    ${k}: x\n`)).toBeNull();
    }
  });
});
