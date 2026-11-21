import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGvisorRunArgs, tmpfsPathProblem, type GvisorRunSpec } from '../gvisor/args.js';
import * as sandbox from '../index.js';
import { precheckCompose } from './compose.js';
import { dependencyFetchProblem } from './lockfile.js';

// Lead decision 2026-11-20 on PR #18: no egress exception for a dependency fetch and no js-yaml.
// A target that needs a fetch at build time is `unsupported` (plan.md, Lane 2 item 3).

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = join(HERE, '..', '..', 'package.json');

describe('no egress exception for the split build', () => {
  it('ships no fetch proxy, egress network or registry allowlist', () => {
    const names = Object.keys(sandbox);
    for (const gone of [
      'FETCH_IMAGE',
      'FETCH_ALLOW',
      'PROXY_SCRIPT',
      'EGRESS_NETWORK',
      'createFetchEnv',
      'removeFetchEnv',
      'resolveRegistry',
      'egressNetworkArgs',
      'proxyCreateArgs',
      'npmProxyEnv',
    ]) {
      expect(names).not.toContain(gone);
    }
    expect(readdirSync(HERE)).not.toContain('fetch.ts');
  });

  const spec: GvisorRunSpec = {
    name: 'affidavit-x',
    runId: '0123456789abcdef',
    image: `sha256:${'a'.repeat(64)}`,
    command: ['true'],
    mounts: [],
  };
  it.each([
    ['fetch', { name: 'affidavit-net-0123456789abcdef', proxy: { host: 'p', ip: '10.0.0.2' } }],
    ['egress', 'affidavit-egress-0123456789abcdef'],
    ['dns', ['1.1.1.1']],
  ])('refuses a run spec that asks for %s, so no caller can add a route out', (key, value) => {
    expect(() => buildGvisorRunArgs({ ...spec, [key]: value })).toThrow(/unknown run spec key/);
  });
  it('keeps the networked bundle builder out of the package: only the human-run script fetches', () => {
    const srcRoot = join(HERE, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(srcRoot);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/['"]cache['"],\s*['"]add['"]|npm cache add --/);
      expect(text, f).not.toMatch(/from ['"][./]*scripts\//);
    }
    expect(Object.keys(sandbox)).not.toContain('buildDependencyBundle');
  });

  it('still joins only none or a per-case internal network', () => {
    const args = buildGvisorRunArgs(spec);
    expect(args[args.indexOf('--network') + 1]).toBe('none');
  });
});

describe('dependencyFetchProblem', () => {
  const lock = (packages: Record<string, unknown>, version = 3) =>
    JSON.stringify({ lockfileVersion: version, packages: { '': {}, ...packages } });
  const reg = { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' };
  const prod = { production: true };
  const all = { production: false };

  it('accepts a target with nothing to download', () => {
    expect(dependencyFetchProblem(lock({}), '{}', all)).toBeNull();
    expect(dependencyFetchProblem(lock({}, 2), '{"dependencies":{}}', all)).toBeNull();
  });

  it('marks a lockfile that lists any package as needing a fetch, even from the registry', () => {
    const why = dependencyFetchProblem(lock({ 'node_modules/a': reg }), '{}', all);
    expect(why).toMatch(/dependency fetch/);
    expect(why).toMatch(/1 package/);
  });

  it('counts only what the install would download', () => {
    const devOnly = lock({ 'node_modules/d': { ...reg, dev: true } });
    expect(dependencyFetchProblem(devOnly, '{}', prod)).toBeNull();
    expect(dependencyFetchProblem(devOnly, '{}', all)).toMatch(/dependency fetch/);
    const bundled = lock({ 'node_modules/a/node_modules/b': { version: '1', inBundle: true } });
    expect(dependencyFetchProblem(bundled, '{}', all)).toBeNull();
  });

  it('reads v1 lockfiles too', () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: reg } });
    expect(dependencyFetchProblem(v1, '{}', all)).toMatch(/dependency fetch/);
  });

  it('refuses dependencies package.json declares but the lockfile does not list', () => {
    expect(
      dependencyFetchProblem(lock({}), JSON.stringify({ dependencies: { express: '4' } }), prod),
    ).toMatch(/dependency fetch/);
    const devDeclared = JSON.stringify({ devDependencies: { vitest: '5' } });
    expect(dependencyFetchProblem(lock({}), devDeclared, prod)).toBeNull();
    expect(dependencyFetchProblem(lock({}), devDeclared, all)).toMatch(/dependency fetch/);
    expect(
      dependencyFetchProblem(lock({}), JSON.stringify({ optionalDependencies: { x: '1' } }), prod),
    ).toMatch(/dependency fetch/);
  });

  it('fails closed on input it cannot read', () => {
    expect(dependencyFetchProblem('not json', '{}', all)).not.toBeNull();
    expect(dependencyFetchProblem(lock({}), 'not json', all)).not.toBeNull();
    expect(dependencyFetchProblem(lock({}), '{"dependencies":[1]}', all)).not.toBeNull();
  });
});

describe('compose precheck without a YAML dependency', () => {
  it('declares no js-yaml (or any new) dependency', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { dependencies: Record<string, string> };
    // tar-stream is the one addition, for the dependency bundle reader (L2-04c); it is on the
    // implementation plan's approved Lane 2 list (section 2.3) and already used by evidence.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@affidavit/contracts',
      'dockerode',
      'tar-stream',
    ]);
    expect(Object.keys(pkg.dependencies)).not.toContain('js-yaml');
  });

  it("accepts NodeGoat's compose file as written", () => {
    const text = `version: "3.7"

services:
  web:
    build: .
    environment:
      NODE_ENV:
      MONGODB_URI: mongodb://mongo:27017/nodegoat
    command: sh -c "until nc -z -w 2 mongo 27017 && echo 'mongo is ready for connections' && node artifacts/db-reset.js && npm start; do sleep 2; done"
    ports:
      - "4000:4000"

  mongo:
    image: mongo:4.4
    user: mongodb
    expose:
      - 27017
`;
    expect(precheckCompose(text)).toBeNull();
  });

  it.each([
    [
      'a key after an apostrophe in a plain value',
      "services:\n  web:\n    command: don't\n    env_file: x\n    labels: 'y'",
    ],
    ['a key inside a flow map with no space', 'services: {web: {env_file:/etc/shadow}}'],
    ['an alias used as a key', 'x: &k env_file\nservices:\n  web:\n    *k : /etc/shadow'],
    ['an explicit key', 'services:\n  web:\n    ? env_file\n    : /etc/shadow'],
    ['a binary-tagged key', 'services:\n  web:\n    ? !!binary ZW52X2ZpbGU=\n    : x'],
    ['a key folded across lines', 'services:\n  web:\n    "env_\n      file": x'],
    ['tab indentation', 'services:\n\tweb:\n\t\tenv_file: x'],
    ['a NUL byte', 'services:\n  web:\n    build: .\0'],
    ['a byte order mark', '\uFEFFservices: {}'],
    ['a YAML directive', '%YAML 1.2\n---\nservices: {}'],
    ['an unterminated quote', 'services:\n  web:\n    command: "x\n'],
    [
      'a reading key whose value is on the next lines',
      'services:\n  web:\n    env_file:\n      - /etc/shadow',
    ],
  ])('refuses %s', (_, text) => expect(precheckCompose(text)).not.toBeNull());

  it('accepts block scalars, comments and empty reading keys', () => {
    expect(
      precheckCompose(
        'services:\n  web:\n    build: . # the app\n    command: |\n      echo "env_file: no"\n      echo \'\n    secrets:\n    configs: {}\n  db:\n    image: mongo:4.4\n',
      ),
    ).toBeNull();
  });

  it('refuses duplicate keys in flow and block maps, but not across sequence items', () => {
    expect(precheckCompose('services: {web: {build: .}, web: {build: ..}}')).not.toBeNull();
    expect(precheckCompose('x:\n  - a: 1\n    b: 2\n  - a: 3\n')).toBeNull();
  });
});

describe('tmpfsPathProblem (sidecar image volumes)', () => {
  it.each(['/data/db', '/data/configdb/', '/var/lib/postgresql/data'])('accepts %s', (p) =>
    expect(tmpfsPathProblem(p)).toBeNull(),
  );
  it.each(['/tmp', '/tmp/x', '/', '/etc', '/proc/1', '/dev/shm', '/scratch', 'data', '/a/../etc'])(
    'refuses %s, so bootTarget reports the sidecar unsupported instead of throwing',
    (p) => expect(tmpfsPathProblem(p)).not.toBeNull(),
  );
});
