import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as guard from './egress-guard.js';
import { EGRESS_ALLOWLIST, findEgress } from './egress-guard.js';

// A LINT, not a security boundary: it raises the cost of a mistake (or of slipping a network call
// past review) in this package's host code. The runtime boundary is gVisor with `--network none`
// and no egress for anything the Judge or an agent runs; the bundle build is a human-run host step
// (scripts/build-dependency-bundle.ts, outside src/). The jailed install (`bundleInstallCommand`)
// is a command string run under gVisor, not a host child_process call, so it is not a finding.

const SRC = fileURLToPath(new URL('..', import.meta.url));

// Read through the namespace so this file still loads (and fails test by test) against a guard
// that does not export it yet.
const sourceFiles = (dir: string): string[] =>
  (guard as { guardedSourceFiles?: (d: string) => string[] }).guardedSourceFiles?.(dir) ?? [];

describe('egress guard over src/', () => {
  it('scans every JS and TS source kind, and skips tests and test helpers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'affidavit-guard-'));
    try {
      mkdirSync(join(dir, 'sub'));
      const names = [
        'a.ts',
        'b.tsx',
        'c.mts',
        'd.cts',
        'e.js',
        'sub/f.mjs',
        'sub/g.cjs',
        'k.jsx',
        'h.test.ts',
        'i.test.mjs',
        'testkit.ts',
        'testutil.js',
        'notes.md',
        'data.json',
      ];
      for (const n of names) writeFileSync(join(dir, n), '');
      const found = sourceFiles(dir)
        .map((f) => relative(dir, f).split('\\').join('/'))
        .sort();
      expect(found).toEqual([
        'a.ts',
        'b.tsx',
        'c.mts',
        'd.cts',
        'e.js',
        'k.jsx',
        'sub/f.mjs',
        'sub/g.cjs',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('src/ has sources to scan', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(20);
  });

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
  /** Review of #55 (9af2a8e): evasions the first guard missed. */
  const evasions: [string, string][] = [
    ['import() of a concatenated name', `const m = await import('node:' + 'https');`],
    ['import() of a template-built name', 'const m = await import(`node:${"https"}`);'],
    [
      'createRequire',
      `import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r('node:https');`,
    ],
    ['bracket access globalThis fetch', `globalThis['fetch'](u);`],
    ['aliased globalThis.fetch', `const f = globalThis.fetch; f(u);`],
    ['fetch.call', `fetch.call(null, u);`],
    [
      'destructured from a namespace',
      `import * as cp from 'node:child_process'; const { execFile } = cp; execFile('npm', ['i']);`,
    ],
    [
      'bracket access on a namespace',
      `import * as cp from 'node:child_process'; cp['execFile']('npm', ['i']);`,
    ],
    ['require().execFile', `require('node:child_process').execFile('npm', ['i']);`],
    [
      'destructured dynamic import',
      `const { spawn } = await import('node:child_process'); spawn('npm', ['i']);`,
    ],
    [
      '/usr/bin/env npm',
      `import { execFile } from 'node:child_process'; execFile('/usr/bin/env', ['npm', 'install']);`,
    ],
    [
      'shell with an args variable',
      `import { execFile } from 'node:child_process'; execFile('sh', argsVar);`,
    ],
    [
      'docker run npm install',
      `import { execFile } from 'node:child_process'; execFile('docker', ['run', 'node:22', 'npm', 'install']);`,
    ],
    [
      'docker on the host network',
      `import { execFile } from 'node:child_process'; execFile('docker', ['run', '--network', 'host', 'x']);`,
    ],
    [
      'docker args spread',
      `import { execFile } from 'node:child_process'; execFile('docker', ['run', ...more]);`,
    ],
    [
      'an aliased spawn function',
      `import { execFile } from 'node:child_process'; const e = execFile; e('npm', ['i']);`,
    ],
    ['EventSource', `const s = new EventSource(u);`],
    ['destructured fetch', `const { fetch: f } = globalThis; f(u);`],
    ['computed global key', `globalThis[name](u);`],
    ['node:module', `import { builtinModules } from 'node:module';`],
  ];
  /** Delta review of #55 (339dc35): evasions of the denylist guard; the allowlist design catches them. */
  const delta: [string, string][] = [
    ['aliased globalThis', `const g = globalThis; g.fetch(u);`],
    ['comma-wrapped globalThis', `(0, globalThis).fetch(u);`],
    ['Reflect.get on globalThis', `Reflect.get(globalThis, 'fe' + 'tch')(u);`],
    ['Reflect.apply', `Reflect.apply(f, null, [u]);`],
    ['process.getBuiltinModule', `const h = process.getBuiltinModule('node:https');`],
    ['eval', `eval('fet' + 'ch(u)');`],
    ['Function constructor', `const f = Function('return fetch')();`],
    ['new Function', `const f = new Function('u', 'return fetch(u)');`],
    ['node:vm', `import vm from 'node:vm';`],
    ['node:worker_threads', `import { Worker } from 'node:worker_threads';`],
    ['node:inspector', `import inspector from 'node:inspector';`],
    ['process.binding', `const tcp = process.binding('tcp_wrap');`],
    ['process.dlopen', `process.dlopen(m, '/tmp/x.node');`],
    ['computed process access', `process['bin' + 'ding']('tcp_wrap');`],
    ['an undeclared npm package', `import leftPad from 'left-pad';`],
    ['a builtin outside the allowlist, bare', `import cluster from 'cluster';`],
    ['self', `self.postMessage(u);`],
  ];
  // Each is caught in an ordinary file and in a file that may import child_process.
  it.each([...caught, ...evasions, ...delta])('catches %s', (_label, code) => {
    expect(findEgress('snippet.ts', code, [])).not.toEqual([]);
    expect(findEgress('gvisor/runner.ts', code, [])).not.toEqual([]);
  });

  it.each([
    ['snippet.js', `const h = require('https'); h.get(u);`],
    ['snippet.mjs', `await fetch(u);`],
    ['snippet.cjs', `require('node:child_process').execFile('npm', ['i']);`],
    ['snippet.tsx', `const x = fetch(u);`],
    ['snippet.jsx', `const x = fetch(u);`],
  ])('catches network code in %s', (file, code) => {
    expect(findEgress(file, code, [])).not.toEqual([]);
  });

  const sanctionedCaught: [string, string][] = [
    ['docker pull', `spawn('docker', ['pull', 'x']);`],
    [
      'docker run with no --network none',
      `spawn('docker', ['run', 'alpine', 'nc', 'evil', '80']);`,
    ],
    ['docker create with no --network none', `spawn('docker', ['create', 'alpine']);`],
    ['docker build with no --network none', `spawn('docker', ['build', '.']);`],
    ['docker exec', `spawn('docker', ['exec', name, 'sh']);`],
    ['docker cp', `spawn('docker', ['cp', '/etc/passwd', 'c:/x']);`],
    ['docker push', `spawn('docker', ['push', 'x']);`],
    ['docker network create without --internal', `spawn('docker', ['network', 'create', 'n']);`],
    ['docker with a non-literal subcommand', `spawn('docker', [sub, 'x']);`],
    ['tar --to-command', `spawn('tar', ['-x', '-f', f, '--to-command=sh -c id']);`],
    ['tar -I', `spawn('tar', ['-I', 'sh -c id', '-x', '-f', f]);`],
    ['tar --use-compress-program', `spawn('tar', ['--use-compress-program=x', '-xf', f]);`],
    ['tar --checkpoint-action', `spawn('tar', ['--checkpoint-action=exec=id', '-xf', f]);`],
    ['tar -T', `spawn('tar', ['-c', '-f', f, '-T', '/etc/list']);`],
    ['tar --files-from', `spawn('tar', ['-c', '-f', f, '--files-from=/etc/list']);`],
  ];
  it.each(sanctionedCaught)('catches %s in a sanctioned file', (_label, call) => {
    const code = `import { spawn } from 'node:child_process'; ${call}`;
    expect(findEgress('gvisor/runner.ts', code, [])).not.toEqual([]);
  });

  it.each([
    ['docker run --network none', `spawn('docker', ['run', '--rm', '--network', 'none', img]);`],
    ['docker run --network=none', `spawn('docker', ['run', '--network=none', img]);`],
    [
      'docker network create --internal',
      `spawn('docker', ['network', 'create', '--internal', n]);`,
    ],
    ['docker image inspect', `spawn('docker', ['image', 'inspect', '--format', '{{.Id}}', ref]);`],
    ['docker rm', `spawn('docker', ['rm', '--force', '--volumes', name]);`],
    [
      'tar extract',
      `spawn('tar', ['-x', '-f', f, '-C', dir, '--no-same-owner', '--no-same-permissions']);`,
    ],
  ])('allows %s in a sanctioned file', (_label, call) => {
    const code = `import { spawn } from 'node:child_process'; ${call}`;
    expect(findEgress('gvisor/runner.ts', code, [])).toEqual([]);
  });

  it('child_process is a finding outside the sanctioned files, even calling docker', () => {
    const code = `import { execFile } from 'node:child_process'; execFile('docker', ['ps']);`;
    expect(findEgress('bundle/open.ts', code, [])).not.toEqual([]);
    expect(findEgress('gvisor/runner.ts', code, [])).toEqual([]);
  });

  const allowed: [string, string][] = [
    ['type-only net import', `import type { AddressInfo } from 'node:net';`],
    ['fetch inside a script string', 'const S = `await fetch(url)`;'],
    [
      'a jailed command array',
      `export const c = ['sh', '-c', 'npm ci --offline --ignore-scripts'];`,
    ],
    ['a method named fetch on another object', `cache.fetch('x');`],
    ['a typeof check on globalThis', `const hasWindow = typeof window !== 'undefined';`],
    ['a declared dependency', `import tar from 'tar-stream';`],
    ['a type-only import of a dev tool', `import type ts from 'typescript';`],
    [
      'an allowlisted builtin',
      `import { createHash } from 'node:crypto'; import zlib from 'zlib';`,
    ],
    ['a relative import', `import { x } from './x.js';`],
    ['a property named self', `const o = { self: 1 }; o.self;`],
  ];
  it.each(allowed)('allows %s', (_label, code) => {
    expect(findEgress('snippet.ts', code, [])).toEqual([]);
  });

  it.each([
    [
      'docker with --network none, in a sanctioned file',
      `import { execFile } from 'node:child_process'; execFile('docker', ['build', '--network', 'none']);`,
    ],
    [
      'promisified docker with typed values, in a sanctioned file',
      `import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; const exec = promisify(execFile); await exec('docker', ['rm', '--force', name]).catch(() => undefined);`,
    ],
  ])('allows %s', (_label, code) => {
    expect(findEgress('gvisor/runner.ts', code, [])).toEqual([]);
  });

  it('an allowlist entry only covers its own file and finding', () => {
    const code = `import http from 'node:http';`;
    const allow = [{ file: 'a.ts', what: 'import node:http', reason: 'listener' }];
    expect(findEgress('a.ts', code, allow)).toEqual([]);
    expect(findEgress('b.ts', code, allow)).not.toEqual([]);
  });
});
