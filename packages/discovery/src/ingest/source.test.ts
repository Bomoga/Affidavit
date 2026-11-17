import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanGitError, GIT_CONFIG, gitEnv, killTree, pinConfig } from './git.js';
import { ingestRepo, IngestInputError } from './index.js';
import { isBlockedAddress, planSource, unmapV4, type HostResolver } from './source.js';
import { cleanup, fakeGitleaks, request, tmpDir } from './testkit.js';

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanup);

const PUBLIC = '93.184.216.34';
const resolveTo =
  (...addrs: string[]): HostResolver =>
  () =>
    Promise.resolve(addrs);
const plan = (source: string, over: Partial<Parameters<typeof planSource>[1]> = {}) =>
  planSource(source, { allowLocal: false, resolve: resolveTo(PUBLIC), ...over });

describe('SSRF guard: literal hosts', () => {
  // Every one of these connected to a loopback listener (or passed the old string check).
  const bypasses = [
    'https://localhost./',
    'https://LOCALHOST/',
    'https://a.localhost/',
    'https://x.local./',
    'https://x.local/',
    'https://[::ffff:7f00:1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::]/',
    'https://[::1]/',
    'https://[::7f00:1]/',
    'https://[fe90::1]/',
    'https://[fe80::1]/',
    'https://[febf::1]/',
    'https://[fd00::1]/',
    'https://[64:ff9b::7f00:1]/',
    'https://[64:ff9b::a9fe:a9fe]/',
    'https://[2002:7f00:1::]/',
    'https://[ff02::1]/',
    'https://198.18.0.1/',
    'https://198.19.255.255/',
    'https://127.0.0.1/',
    'https://127.1/',
    'https://2130706433/',
    'https://0x7f.0.0.1/',
    'https://0.0.0.0/',
    'https://10.1.2.3/',
    'https://100.64.0.1/',
    'https://169.254.169.254/',
    'https://172.16.0.1/',
    'https://172.31.255.1/',
    'https://192.168.1.1/',
    'https://224.0.0.1/',
    'https://240.0.0.1/',
    'https://255.255.255.255/',
  ];
  it.each(bypasses)('refuses %s', async (url) => {
    // The resolver is never needed for a literal, and a resolver that said "public" cannot help.
    await expect(plan(url)).rejects.toBeInstanceOf(IngestInputError);
  });

  it('accepts a public literal and pins it', async () => {
    const p = await plan('https://93.184.216.34/a/b.git');
    expect(p).toMatchObject({
      kind: 'https',
      host: '93.184.216.34',
      port: 443,
      ip: '93.184.216.34',
    });
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('maps ::ffff:a.b.c.d in both spellings before checking', () => {
    expect(unmapV4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(unmapV4('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(unmapV4('2606:4700::1')).toBe('2606:4700::1');
  });
});

describe('SSRF guard: names, ports, schemes', () => {
  it('resolves and refuses when ANY address is blocked', async () => {
    for (const addrs of [
      ['127.0.0.1'], // localtest.me
      [PUBLIC, '10.0.0.5'],
      ['::ffff:7f00:1'],
      ['64:ff9b::7f00:1'],
      ['198.18.0.1'],
      [],
    ]) {
      await expect(
        plan('https://git.example.com/a.git', { resolve: resolveTo(...addrs) }),
      ).rejects.toBeInstanceOf(IngestInputError);
    }
    await expect(
      plan('https://git.example.com/a.git', { resolve: () => Promise.reject(new Error('nx')) }),
    ).rejects.toBeInstanceOf(IngestInputError);
  });

  it('pins the checked address and strips the trailing dot', async () => {
    const p = await plan('https://Git.Example.com./a.git', {
      resolve: resolveTo(PUBLIC, '8.8.8.8'),
    });
    expect(p).toMatchObject({ host: 'git.example.com', port: 443, ip: PUBLIC });
    expect(pinConfig(p)).toEqual([`http.curloptResolve=git.example.com:443:${PUBLIC}`]);
    const v6 = await plan('https://git.example.com/a.git', { resolve: resolveTo('2606:4700::1') });
    expect(pinConfig(v6)).toEqual(['http.curloptResolve=git.example.com:443:[2606:4700::1]']);
  });

  it('allows port 443 only unless the caller allows more', async () => {
    for (const url of [
      'https://git.example.com:8443/a',
      'https://git.example.com:22/a',
      'https://git.example.com:80/a',
    ]) {
      await expect(plan(url)).rejects.toBeInstanceOf(IngestInputError);
    }
    await expect(plan('https://git.example.com:443/a')).resolves.toMatchObject({ port: 443 });
    await expect(
      plan('https://git.example.com:8443/a', { allowedPorts: [8443] }),
    ).resolves.toMatchObject({
      port: 8443,
    });
    await expect(
      plan('https://git.example.com/a', { allowedPorts: [8443] }),
    ).rejects.toBeInstanceOf(IngestInputError);
  });

  it('refuses other schemes, credentials and option-looking values', async () => {
    for (const s of [
      'http://git.example.com/a',
      'git://git.example.com/a',
      'ssh://git@git.example.com/a',
      'https://u:p@git.example.com/a',
      'https://token@git.example.com/a',
      '--upload-pack=x',
      'ext::sh -c id',
      '',
    ]) {
      await expect(plan(s), s).rejects.toBeInstanceOf(IngestInputError);
    }
  });

  it('git is configured without redirects, proxies or credential helpers', () => {
    expect(GIT_CONFIG).toContain('http.followRedirects=false');
    expect(GIT_CONFIG).toContain('http.proxy=');
    expect(GIT_CONFIG).toContain('credential.helper=');
  });

  it('proxy variables are not passed to git unless the caller opts in', () => {
    const prev = process.env['HTTPS_PROXY'];
    process.env['HTTPS_PROXY'] = 'http://proxy.invalid:3128';
    process.env['ALL_PROXY'] = 'http://proxy.invalid:3128';
    try {
      const off = gitEnv('/h', false, false);
      expect(off['HTTPS_PROXY']).toBeUndefined();
      expect(off['ALL_PROXY']).toBeUndefined();
      expect(gitEnv('/h', false, true)['HTTPS_PROXY']).toBe('http://proxy.invalid:3128');
    } finally {
      if (prev === undefined) delete process.env['HTTPS_PROXY'];
      else process.env['HTTPS_PROXY'] = prev;
      delete process.env['ALL_PROXY'];
    }
  });
});

describe('SSRF guard: local sources', () => {
  it('rejects UNC paths and file URLs naming another host', async () => {
    const dir = tmpDir();
    for (const s of [
      '\\\\server\\share\\repo',
      '//server/share/repo',
      'file://server/share/repo',
      'file:////server/share',
    ]) {
      await expect(planSource(s, { allowLocal: true }), s).rejects.toBeInstanceOf(IngestInputError);
    }
    await expect(planSource(dir, { allowLocal: true })).resolves.toEqual({
      kind: 'local',
      path: dir,
    });
    await expect(planSource('/no/such/dir/x', { allowLocal: true })).rejects.toBeInstanceOf(
      IngestInputError,
    );
  });
});

describe('SSRF guard end to end: nothing connects', () => {
  let server: Server | undefined;
  afterAll(() => server?.close());

  it('a loopback listener sees no connection for any of the old bypasses', async () => {
    let connections = 0;
    server = createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const workRoot = tmpDir();
    const sha = 'a'.repeat(40);
    const cases: [string, string[]][] = [
      [`https://localhost.:${port}/a.git`, []],
      [`https://[::ffff:7f00:1]:${port}/a.git`, []],
      [`https://localtest.me:${port}/a.git`, ['127.0.0.1']], // public name, loopback answer
      [`https://x.local.:${port}/a.git`, []],
      [`https://198.18.0.1:${port}/a.git`, []],
      [`https://[::]:${port}/a.git`, []],
    ];
    for (const [source, answer] of cases) {
      await expect(
        ingestRepo(
          {
            runner: fakeGitleaks(),
            workRoot,
            allowedPorts: [port], // the port check is not what stops these
            resolveHost: resolveTo(...answer),
          },
          request({ source, commit: sha }),
        ),
        source,
      ).rejects.toBeInstanceOf(IngestInputError);
    }
    expect(connections).toBe(0);
  });
});

describe('process control', () => {
  it('killTree kills the child and what it started', async () => {
    const dir = tmpDir();
    const pidFile = join(dir, 'grandchild.pid');
    const script = join(dir, 'parent.js');
    writeFileSync(
      script,
      `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setInterval(() => {}, 1000);`,
    );
    const child = execFile(process.execPath, [script], {
      detached: process.platform !== 'win32',
    } as object);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 50));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(grandchild, 0)).not.toThrow();
    killTree(child);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(grandchild, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('git error text drops remote: lines and non-printable bytes', () => {
    const text = 'remote: Enter your token ghp_x\nfatal: bad\u0000thing \u001b[31m\nremote: more';
    const out = cleanGitError(text);
    expect(out).not.toContain('remote');
    expect(out).not.toContain('ghp_x');
    expect(out).toMatch(/^[\x20-\x7e]*$/);
    expect(out).toContain('fatal: bad?thing');
  });
});
