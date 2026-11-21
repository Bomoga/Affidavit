import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EGRESS_ALLOWLIST, findEgress } from './egress-guard.js';

// Nothing under src/ may reach the network or run a package manager or fetch tool on the host.
// The one networked step is the human-run scripts/build-dependency-bundle.ts, outside src/.
// The jailed install (`bundleInstallCommand`) is a command string run under gVisor with
// `--network none`, not a host child_process call, so it is not a finding.

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'testkit.ts') {
      out.push(p);
    }
  }
  return out;
}

describe('egress guard over src/', () => {
  it('finds no network import, fetch, or host package-manager or fetch-tool spawn', () => {
    const findings = sourceFiles(SRC).flatMap((f) =>
      findEgress(relative(SRC, f).split('\\').join('/'), readFileSync(f, 'utf8')),
    );
    expect(findings).toEqual([]);
  });

  it('every allowlist entry is still needed (no stale exceptions)', () => {
    for (const a of EGRESS_ALLOWLIST) {
      const text = readFileSync(join(SRC, a.file), 'utf8');
      expect(
        findEgress(a.file, text, []).some((f) => f.what === a.what),
        a.file,
      ).toBe(true);
    }
  });
});

describe('egress guard self-test: each snippet must be caught', () => {
  const caught: [string, string][] = [
    [
      'fetch of a resolved URL',
      `export async function f(p: { resolved: string }) { return fetch(p.resolved); }`,
    ],
    ['globalThis.fetch', `void globalThis.fetch('https://registry.npmjs.org/');`],
    ['XMLHttpRequest', `const x = new XMLHttpRequest();`],
    ['WebSocket', `const w = new WebSocket('wss://x');`],
    ['node:http', `import http from 'node:http';`],
    ['https', `import * as https from 'https';`],
    ['node:http2', `import { connect } from 'node:http2';`],
    ['node:net', `import net from 'node:net';`],
    ['node:tls', `import tls from 'node:tls';`],
    ['node:dgram', `import dgram from 'node:dgram';`],
    ['node:dns', `import dns from 'node:dns';`],
    ['node:dns/promises', `import dns from 'node:dns/promises';`],
    ['undici', `import { request } from 'undici';`],
    ['require of https', `const h = require('node:https');`],
    ['dynamic import of net', `const n = await import('node:net');`],
    ['re-export of tls', `export { connect } from 'node:tls';`],
    [
      'execFile npm install',
      `import { execFile } from 'node:child_process'; execFile('npm', ['install']);`,
    ],
    ['spawn pnpm', `import { spawn } from 'child_process'; spawn('pnpm', ['i']);`],
    ['exec yarn', `import { exec } from 'node:child_process'; exec('yarn install');`],
    [
      'execFileSync node-gyp',
      `import { execFileSync } from 'node:child_process'; execFileSync('node-gyp', ['rebuild']);`,
    ],
    [
      'curl',
      `import { execFile } from 'node:child_process'; execFile('curl', ['-O', 'https://x']);`,
    ],
    ['wget', `import { spawnSync } from 'node:child_process'; spawnSync('wget', ['https://x']);`],
    [
      'git clone',
      `import { execFile } from 'node:child_process'; execFile('git', ['clone', 'https://x']);`,
    ],
    [
      'absolute npm path',
      `import { execFile } from 'node:child_process'; execFile('/usr/bin/npm', ['ci']);`,
    ],
    [
      'promisified alias',
      `import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; const run = promisify(execFile); await run('npm', ['install']);`,
    ],
    ['namespace import', `import * as cp from 'node:child_process'; cp.spawn('npm', ['ci']);`],
    [
      'const string command',
      `import { execFile } from 'node:child_process'; const tool = 'npm'; execFile(tool, []);`,
    ],
    [
      'spaced cache add through node',
      `import { execFile } from 'node:child_process'; execFile(process.execPath, [cli, 'cache' ,'add', url]);`,
    ],
    [
      'shell running npm',
      `import { execFile } from 'node:child_process'; execFile('sh', ['-c', 'npm install']);`,
    ],
    ['unresolvable command', `import { execFile } from 'node:child_process'; execFile(bin, args);`],
  ];
  it.each(caught)('catches %s', (_label, code) => {
    expect(findEgress('snippet.ts', code, [])).not.toEqual([]);
  });

  const allowed: [string, string][] = [
    ['type-only net import', `import type { AddressInfo } from 'node:net';`],
    [
      'docker',
      `import { execFile } from 'node:child_process'; execFile('docker', ['build', '--network', 'none']);`,
    ],
    ['fetch inside a script string', 'const S = `await fetch(url)`;'],
    [
      'a jailed command array',
      `export const c = ['sh', '-c', 'npm ci --offline --ignore-scripts'];`,
    ],
    ['a method named fetch on another object', `cache.fetch('x');`],
  ];
  it.each(allowed)('allows %s', (_label, code) => {
    expect(findEgress('snippet.ts', code, [])).toEqual([]);
  });

  it('an allowlist entry only covers its own file and finding', () => {
    const code = `import http from 'node:http';`;
    const allow = [{ file: 'a.ts', what: 'import node:http', reason: 'listener' }];
    expect(findEgress('a.ts', code, allow)).toEqual([]);
    expect(findEgress('b.ts', code, allow)).not.toEqual([]);
  });
});
