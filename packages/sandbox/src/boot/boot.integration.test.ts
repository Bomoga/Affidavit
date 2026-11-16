import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootHints } from '@affidavit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_LABEL } from '../gvisor/args.js';
import { createCaseNetwork, removeCaseNetwork } from '../gvisor/network.js';
import { runJailed } from '../gvisor/runner.js';
import { bootTarget, type BootOutcome } from './boot.js';
import { buildTarget, type BuildOutcome } from './build.js';
import {
  FETCH_IMAGE,
  PROXY_PORT,
  createFetchEnv,
  removeFetchEnv,
  resolveRegistry,
  type FetchEnv,
} from './fetch.js';
import { imageOnBuild, pullPinned } from './images.js';

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
    it.each(['vulnerable', 'safe'] as const)(
      'builds and boots the %s variant healthy, and returns its digest',
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
        expect(build.ok && build.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(boot).toMatchObject({ status: 'healthy', url: 'http://target:4000' });
        expect(boot?.status === 'healthy' && boot.sidecarImages.mongo).toMatch(
          /^mongo@sha256:[0-9a-f]{64}$/,
        );
      },
    );
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

/** Exits 0 and prints CONNECTED if a TCP connection opens, else prints why and exits 3. */
const connectProbe = (host: string, port: number): string =>
  `const s = require('net').connect(${port}, ${JSON.stringify(host)});
s.setTimeout(5000);
s.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
s.on('error', (e) => { console.log(e.code); process.exit(3); });
s.on('timeout', () => { console.log('TIMEOUT'); process.exit(3); });`;

/** Sends `CONNECT target` to the proxy and prints the status line. */
const connectVia = (proxy: string, target: string): string =>
  `const s = require('net').connect(${PROXY_PORT}, ${JSON.stringify(proxy)}, () =>
  s.write('CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n'));
s.setTimeout(10000);
s.once('data', (d) => { console.log(String(d).split('\\r\\n')[0]); process.exit(0); });
s.on('error', (e) => { console.log(e.code); process.exit(3); });
s.on('timeout', () => { console.log('TIMEOUT'); process.exit(3); });`;

describe.runIf(onSandboxHost)(
  'the fetch step network on a sandbox host',
  { timeout: 300_000 },
  () => {
    let env: FetchEnv | undefined;
    const fetchEnv = (): FetchEnv => env as FetchEnv;
    const probe = async (code: string) =>
      runJailed(
        {
          image: FETCH_IMAGE,
          command: ['node', '-e', code],
          mounts: [],
          timeoutMs: 60_000,
          fetch: fetchEnv().fetch,
        },
        { trace: false },
      );
    const gateway = (net: string): string =>
      execFileSync(
        'docker',
        ['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', net],
        { encoding: 'utf8' },
      ).trim();

    beforeAll(async () => {
      await pullPinned(FETCH_IMAGE);
      env = await createFetchEnv(await resolveRegistry());
    });
    afterAll(async () => {
      if (env !== undefined) await removeFetchEnv(env);
      const left = execFileSync(
        'docker',
        ['network', 'ls', '--quiet', '--filter', `label=${RUN_LABEL}`],
        { encoding: 'utf8' },
      );
      expect(left.trim()).toBe('');
    });

    it.each([
      ['a public IP literal', '1.1.1.1', 443],
      ['a documentation address', '203.0.113.10', 443],
      ['cloud metadata', '169.254.169.254', 80],
    ])('cannot connect directly to %s from the fetch step', async (_, host, port) => {
      const run = await probe(connectProbe(host, port));
      expect(run.stdout).not.toContain('CONNECTED');
      expect(run.exitCode).not.toBe(0);
    });

    it('cannot connect to the bridge gateway of its own network or of the default bridge', async () => {
      for (const gw of [gateway(fetchEnv().net.name), gateway('bridge')]) {
        expect(gw).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        for (const port of [22, 80, 2375, 3128]) {
          const run = await probe(connectProbe(gw, port));
          expect(run.stdout, `${gw}:${port}`).not.toContain('CONNECTED');
        }
      }
    });

    it('reaches the registry through the proxy, and the proxy refuses anything else', async () => {
      const proxy = fetchEnv().fetch.proxy.host;
      expect((await probe(connectVia(proxy, 'registry.npmjs.org:443'))).stdout).toMatch(/ 200 /);
      for (const target of ['example.com:443', '1.1.1.1:443', 'registry.npmjs.org:80']) {
        expect((await probe(connectVia(proxy, target))).stdout, target).toMatch(/ 403 /);
      }
    });
  },
);

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
