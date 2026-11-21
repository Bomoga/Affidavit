import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootHints } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_LABEL } from '../gvisor/args.js';
import { createCaseNetwork, removeCaseNetwork } from '../gvisor/network.js';
import { bootTarget, type BootOutcome } from './boot.js';
import { buildTarget, type BuildOutcome } from './build.js';
import { normalizeCompose, withEmptyDockerConfig } from './compose.js';
import { imageOnBuild } from './images.js';

// Needs a sandbox host (docs/lanes/lane2/sandbox-runner.md) and pulls images from Docker Hub.
// Run with `pnpm --filter @affidavit/sandbox test:sandbox-host`. The NodeGoat cases also need
// AFFIDAVIT_NODEGOAT_DIR pointing at an OWASP NodeGoat checkout (the corpus is Lane 1, L1-08).
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';
const nodegoat = process.env.AFFIDAVIT_NODEGOAT_DIR;

const NODEGOAT_HINTS: BootHints = {
  kind: 'compose',
  path: 'docker-compose.yml',
  service: 'web',
  ports: [4000],
  healthRoute: '/login',
  healthTimeoutMs: 90_000,
  stubs: [],
  env: { NODE_ENV: 'synthetic' },
};

/** NodeGoat's own documented fix for the `$where` injection, used as the safe variant. */
const VULNERABLE_QUERY =
  "return {\n                    $where: `this.userId == ${parsedUserId} && this.stocks > '${threshold}'`\n                };";
const SAFE_QUERY = `const parsedThreshold = parseInt(threshold, 10);
                if (parsedThreshold >= 0 && parsedThreshold <= 99) {
                    return {$where: \`this.userId == \${parsedUserId} && this.stocks > \${parsedThreshold}\`};
                }
                throw \`The user supplied threshold: \${parsedThreshold} was not valid.\`;`;

/** A one-file app with no dependencies, booted from its Dockerfile. */
function tinyApp(root: string, name: string, server: string): string {
  const dir = join(root, name);
  cpSync(join(root, 'empty'), dir, { recursive: true });
  writeFileSync(join(dir, 'server.js'), server);
  return dir;
}

const tinyHints = (stubs: BootHints['stubs'] = []): BootHints => ({
  kind: 'dockerfile',
  path: 'Dockerfile',
  ports: [3000],
  healthRoute: '/health',
  healthTimeoutMs: 15_000,
  stubs,
  env: {},
});

const LISTEN = `require('http').createServer((q, s) => s.end('ok')).listen(3000)`;

describe.runIf(onSandboxHost)('boot recipes on a sandbox host', { timeout: 900_000 }, () => {
  let root = '';
  let workRoot = '';

  const buildAndBoot = async (
    src: string,
    hints: BootHints,
  ): Promise<{ build: BuildOutcome; boot?: BootOutcome }> => {
    const build = await buildTarget(src, hints, { workRoot });
    if (!build.ok) return { build };
    const net = await createCaseNetwork();
    try {
      return { build, boot: await bootTarget(net, build.imageId, build.recipe) };
    } finally {
      await removeCaseNetwork(net);
    }
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'affidavit-boot-it-'));
    workRoot = join(root, 'work');
    execFileSync('mkdir', ['-p', workRoot, join(root, 'empty')]);
    const empty = join(root, 'empty');
    writeFileSync(
      join(empty, 'Dockerfile'),
      'FROM node:22-alpine\nWORKDIR /app\nCMD ["node", "server.js"]\n',
    );
    writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.0.0' }));
    writeFileSync(
      join(empty, 'package-lock.json'),
      JSON.stringify({
        name: 'tiny',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'tiny', version: '1.0.0' } },
      }),
    );
  });

  afterAll(() => {
    expect(readdirSync(workRoot)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    const left = execFileSync(
      'docker',
      ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`],
      {
        encoding: 'utf8',
      },
    );
    expect(left.trim()).toBe('');
  });

  describe.runIf(nodegoat !== undefined)('NodeGoat (the gate target)', () => {
    // Lead decision 2026-11-20 (PR #18): no egress exception for the dependency fetch. NodeGoat
    // installs its dependencies at build time, so both variants are unsupported until a target
    // can be built without a fetch. This test pins that; it used to assert a healthy boot.
    it.each(['vulnerable', 'safe'] as const)(
      'marks the %s variant unsupported: it needs a dependency fetch at build time',
      async (variant) => {
        let src = nodegoat as string;
        if (variant === 'safe') {
          src = join(root, 'nodegoat-safe');
          cpSync(nodegoat as string, src, { recursive: true });
          const file = join(src, 'app/data/allocations-dao.js');
          const code = readFileSync(file, 'utf8');
          expect(code).toContain(VULNERABLE_QUERY);
          writeFileSync(file, code.replace(VULNERABLE_QUERY, SAFE_QUERY));
        }
        const { build, boot } = await buildAndBoot(src, NODEGOAT_HINTS);
        expect(build).toMatchObject({ ok: false, unsupported: true, step: 'recipe' });
        expect(!build.ok && build.reason).toMatch(/dependency fetch/);
        expect(boot).toBeUndefined();
      },
    );
  });

  it('gives a build script no route out, to the registry or anywhere else', async () => {
    const src = tinyApp(root, 'build-probe', LISTEN);
    writeFileSync(
      join(src, 'probe.js'),
      `const net = require('net');
const tries = [['registry.npmjs.org', 443], ['1.1.1.1', 443], ['169.254.169.254', 80]];
let left = tries.length;
for (const [host, port] of tries) {
  const s = net.connect(port, host);
  s.setTimeout(5000);
  s.on('connect', () => { console.error('CONNECTED ' + host); process.exit(4); });
  const done = () => { s.destroy(); if (--left === 0) process.exit(0); };
  s.on('error', done);
  s.on('timeout', done);
}`,
    );
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({ name: 'tiny', version: '1.0.0', scripts: { build: 'node probe.js' } }),
    );
    const build = await buildTarget(src, tinyHints(), { workRoot });
    expect(build).toMatchObject({ ok: true });
    const egress = execFileSync('docker', ['network', 'ls', '--format', '{{.Name}}'], {
      encoding: 'utf8',
    });
    expect(egress).not.toMatch(/affidavit-egress-/);
  });

  it('starts a stub for an external service the target needs to boot', async () => {
    const src = tinyApp(
      root,
      'needs-payments',
      `fetch('http://payments.example.com/v1/ping').then((r) => { if (!r.ok) process.exit(1); ${LISTEN}; }, () => process.exit(1));`,
    );
    const stub = { name: 'payments', kind: 'http' as const, hostAlias: 'payments.example.com' };
    expect((await buildAndBoot(src, tinyHints([stub]))).boot).toMatchObject({ status: 'healthy' });
  });

  it.each([
    [
      'connects to an outside address',
      `require('net').connect(443, '203.0.113.10').on('error', () => {}); setInterval(() => {}, 1000);`,
    ],
    [
      'looks up an outside name',
      `fetch('https://api.example.com/').then(() => { ${LISTEN}; }, (e) => { console.error(e.cause?.code ?? e); process.exit(1); });`,
    ],
  ])('marks a target that %s at boot as unsupported', async (name, server) => {
    const src = tinyApp(root, name.replace(/\W+/g, '-'), server);
    const { build, boot } = await buildAndBoot(src, tinyHints());
    expect(build.ok).toBe(true);
    expect(boot?.status).toBe('unsupported');
    expect(boot?.status === 'unsupported' && boot.reason).toMatch(/needs real egress/);
  });

  it('reports a target that never becomes healthy, without egress, as failed', async () => {
    const src = tinyApp(root, 'never-listens', 'setInterval(() => {}, 1000);');
    expect((await buildAndBoot(src, tinyHints())).boot).toMatchObject({ status: 'failed' });
  });

  it('never runs a Docker CLI plugin or config shipped in the tree, on the host', async () => {
    const src = tinyApp(root, 'ships-docker-plugin', LISTEN);
    const marker = join(root, 'plugin-ran');
    const plugins = join(src, '.docker', 'cli-plugins');
    mkdirSync(plugins, { recursive: true });
    const fake = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '{"services":{}}'\n`;
    for (const name of ['docker-compose', 'docker-buildx']) {
      writeFileSync(join(plugins, name), fake);
      chmodSync(join(plugins, name), 0o755);
    }
    writeFileSync(
      join(src, '.docker', 'config.json'),
      JSON.stringify({ cliPluginsExtraDirs: [plugins], currentContext: 'evil' }),
    );
    writeFileSync(join(src, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');

    // Straight on the unstaged tree: the fixed binary and empty config must ignore `.docker`.
    const normalized = await withEmptyDockerConfig((cfg) =>
      normalizeCompose(src, 'docker-compose.yml', cfg),
    );
    expect(normalized).toMatchObject({ services: { app: { build: { context: src } } } });
    expect(existsSync(marker)).toBe(false);

    // Through the whole build: staging also drops `.docker`.
    const hints: BootHints = {
      ...tinyHints(),
      kind: 'compose',
      path: 'docker-compose.yml',
      service: 'app',
    };
    const { build } = await buildAndBoot(src, hints);
    expect(build.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  /** A tiny app whose `npm run build` is `script`. */
  const withBuildScript = (name: string, script: string): string => {
    const src = tinyApp(root, name, LISTEN);
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({ name: 'tiny', version: '1.0.0', scripts: { build: script } }),
    );
    return src;
  };

  it('stops a build script from writing a huge sparse file (RLIMIT_FSIZE)', async () => {
    const src = withBuildScript(
      'sparse-huge',
      `node -e "require('fs').truncateSync('big', 2 ** 40)"`,
    );
    const { build } = await buildAndBoot(src, tinyHints());
    expect(build).toMatchObject({ ok: false, step: 'scripts' });
    expect(build.leftovers).toBeUndefined();
  });

  it('refuses a built tree over the byte cap before it becomes a build context', async () => {
    // Nine sparse files just under the per-file limit: each is allowed, the total is not.
    const src = withBuildScript(
      'sparse-total',
      `node -e "for (let i = 0; i < 9; i++) require('fs').writeFileSync('s' + i, ''), require('fs').truncateSync('s' + i, 255 * 1024 * 1024)"`,
    );
    const { build } = await buildAndBoot(src, tinyHints());
    expect(build).toMatchObject({ ok: false, step: 'scripts' });
    expect(build.ok === false && build.reason).toMatch(/over \d+ bytes/);
    expect(build.leftovers).toBeUndefined();
  });

  it('cleans up a chmod 000 directory a build script leaves, and reports the real outcome', async () => {
    const src = withBuildScript('locked-dir', 'mkdir -p d/e && touch d/e/f && chmod 000 d');
    const { build } = await buildAndBoot(src, tinyHints());
    // The walker cannot read `d`, so the build stops before assemble; cleanup still empties it.
    expect(build).toMatchObject({ ok: false, step: 'scripts' });
    expect(build.ok === false && build.reason).toMatch(/unreadable directory: d/);
    expect(build.leftovers).toBeUndefined();
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it('never puts host paths in a failed build reason', async () => {
    const src = withBuildScript(
      'fails-loudly',
      `node -e "console.error(process.cwd()); process.exit(3)"`,
    );
    const { build } = await buildAndBoot(src, tinyHints());
    expect(build.ok).toBe(false);
    const reason = build.ok ? '' : build.reason;
    for (const p of [workRoot, root, src, tmpdir()]) expect(reason).not.toContain(p);
  });

  it('refuses a base image outside the allowlist before pulling it', async () => {
    const src = tinyApp(root, 'not-node', LISTEN);
    writeFileSync(join(src, 'Dockerfile'), 'FROM bitnami/node:22\nCMD ["node", "server.js"]\n');
    expect((await buildAndBoot(src, tinyHints())).build).toMatchObject({
      ok: false,
      unsupported: true,
      step: 'base',
    });
  });

  it('refuses a lockfile that fetches from outside the registry, before any build step', async () => {
    const src = tinyApp(root, 'git-dep', LISTEN);
    writeFileSync(
      join(src, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/x': { version: '1.0.0', resolved: 'https://evil.example/x.tgz' },
        },
      }),
    );
    expect((await buildAndBoot(src, tinyHints())).build).toMatchObject({
      ok: false,
      unsupported: true,
      step: 'recipe',
    });
  });
});

describe.runIf(onSandboxHost)('ONBUILD detection on a sandbox host', { timeout: 300_000 }, () => {
  const tag = `affidavit-onbuild-test:${process.pid}`;
  afterAll(() => {
    execFileSync('docker', ['image', 'rm', '--force', tag], { stdio: 'ignore' });
  });

  it('reads ONBUILD triggers from an image and none from the official node image', async () => {
    execFileSync('docker', ['pull', '--quiet', 'node:22-alpine'], { stdio: 'ignore' });
    execFileSync('docker', ['build', '--quiet', '--tag', tag, '-'], {
      input: 'FROM node:22-alpine\nONBUILD RUN echo from-the-base\n',
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    expect(await imageOnBuild(tag)).toEqual(['RUN echo from-the-base']);
    expect(await imageOnBuild('node:22-alpine')).toEqual([]);
  });
});
