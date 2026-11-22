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
/** Typed values the allowed sanctioned snippets pass: declared, so not unresolved identifiers. */
const TYPED =
  'declare const img: string, n: string, ref: string, name: string, f: string, dir: string;';

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
      const judgeDir = join(SRC, '..', '..', 'judge', 'src');
      const path = a.file.startsWith('judge:')
        ? join(judgeDir, a.file.slice('judge:'.length))
        : join(SRC, a.file);
      const text = readFileSync(path, 'utf8');
      const within = (a as { within?: string }).within;
      expect(
        findEgress(a.file, text, []).some(
          (f) =>
            f.what === a.what &&
            (within === undefined || (f as { within?: string }).within === within),
        ),
        `${a.file}: ${a.what}`,
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
      `import { execFile } from 'node:child_process'; execFile('docker', ['run', 'node:22', 'npm', 'install'], { env: {} });`,
    ],
    [
      'docker on the host network',
      `import { execFile } from 'node:child_process'; execFile('docker', ['run', '--network', 'host', 'x'], { env: {} });`,
    ],
    [
      'docker args spread',
      `import { execFile } from 'node:child_process'; execFile('docker', ['run', ...more], { env: {} });`,
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
    ['docker pull', `spawn('docker', ['pull', 'x'], { env: {} });`],
    [
      'docker run with no --network none',
      `spawn('docker', ['run', 'alpine', 'nc', 'evil', '80'], { env: {} });`,
    ],
    ['docker create with no --network none', `spawn('docker', ['create', 'alpine'], { env: {} });`],
    ['docker build with no --network none', `spawn('docker', ['build', '.'], { env: {} });`],
    ['docker exec', `spawn('docker', ['exec', name, 'sh'], { env: {} });`],
    ['docker cp', `spawn('docker', ['cp', '/etc/passwd', 'c:/x'], { env: {} });`],
    ['docker push', `spawn('docker', ['push', 'x'], { env: {} });`],
    [
      'docker network create without --internal',
      `spawn('docker', ['network', 'create', 'n'], { env: {} });`,
    ],
    ['docker with a non-literal subcommand', `spawn('docker', [sub, 'x'], { env: {} });`],
    ['tar --to-command', `spawn('tar', ['-x', '-f', f, '--to-command=sh -c id'], { env: {} });`],
    ['tar -I', `spawn('tar', ['-I', 'sh -c id', '-x', '-f', f], { env: {} });`],
    [
      'tar --use-compress-program',
      `spawn('tar', ['--use-compress-program=x', '-xf', f], { env: {} });`,
    ],
    [
      'tar --checkpoint-action',
      `spawn('tar', ['--checkpoint-action=exec=id', '-xf', f], { env: {} });`,
    ],
    ['tar -T', `spawn('tar', ['-c', '-f', f, '-T', '/etc/list'], { env: {} });`],
    ['tar --files-from', `spawn('tar', ['-c', '-f', f, '--files-from=/etc/list'], { env: {} });`],
  ];
  it.each(sanctionedCaught)('catches %s in a sanctioned file', (_label, call) => {
    const code = `import { spawn } from 'node:child_process'; ${call}`;
    expect(findEgress('gvisor/runner.ts', code, [])).not.toEqual([]);
  });

  // CR-12: no child inherits the parent environment (worker secrets).
  it.each([
    ['no options', `spawn('docker', ['ps']);`, 'spawn without env'],
    ['options without env', `spawn('docker', ['ps'], { timeout: 5 });`, 'spawn without env'],
    ['options in a variable', `spawn('docker', ['ps'], o);`, 'spawn without env'],
    [
      'env from process.env',
      `spawn('docker', ['ps'], { env: process.env });`,
      'spawn env from process.env',
    ],
    [
      'env spreading process.env',
      `spawn('docker', ['ps'], { env: { ...process.env, A: '1' } });`,
      'spawn env from process.env',
    ],
    [
      'process.env by bracket',
      `spawn('docker', ['ps'], { env: { P: process['env'].PATH } });`,
      'spawn env from process.env',
    ],
    [
      'a spread after env',
      `spawn('docker', ['ps'], { env: {}, ...o });`,
      'spawn env overridable by a spread',
    ],
  ])('catches a spawn with %s', (_label, call, what) => {
    const code = `import { spawn } from 'node:child_process'; declare const o: object; ${call}`;
    expect(findEgress('gvisor/runner.ts', code, []).map((f) => f.what)).toContain(what);
  });

  it('allows env after a spread, and a shorthand env', () => {
    const code = `import { spawn } from 'node:child_process'; declare const o: object, env: Record<string, string>; spawn('docker', ['ps'], { ...o, env: {} }); spawn('docker', ['ps'], { env });`;
    expect(findEgress('gvisor/runner.ts', code, [])).toEqual([]);
  });

  it.each([
    [
      'docker run --network none',
      `spawn('docker', ['run', '--rm', '--network', 'none', img], { env: {} });`,
    ],
    ['docker run --network=none', `spawn('docker', ['run', '--network=none', img], { env: {} });`],
    [
      'docker network create --internal',
      `spawn('docker', ['network', 'create', '--internal', n], { env: {} });`,
    ],
    [
      'docker image inspect',
      `spawn('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { env: {} });`,
    ],
    ['docker rm', `spawn('docker', ['rm', '--force', '--volumes', name], { env: {} });`],
    [
      'tar extract',
      `spawn('tar', ['-x', '-f', f, '-C', dir, '--no-same-owner', '--no-same-permissions'], { env: {} });`,
    ],
  ])('allows %s in a sanctioned file', (_label, call) => {
    const code = `import { spawn } from 'node:child_process'; ${TYPED} ${call}`;
    expect(findEgress('gvisor/runner.ts', code, [])).toEqual([]);
  });

  it('child_process is a finding outside the sanctioned files, even calling docker', () => {
    const code = `import { execFile } from 'node:child_process'; execFile('docker', ['ps'], { env: {} });`;
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
      `import { execFile } from 'node:child_process'; execFile('docker', ['build', '--network', 'none'], { env: {} });`,
    ],
    [
      'promisified docker with typed values, in a sanctioned file',
      `import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; const exec = promisify(execFile); export async function rm(name: string) { await exec('docker', ['rm', '--force', name], { env: {} }).catch(() => undefined); }`,
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

/** Final delta review of #55: three claims the guard made and did not keep. */
describe('egress guard self-test: final delta review', () => {
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

  // (1) Destructuring or aliasing process, Reflect, module or require is a finding.
  const aliasing: [string, string][] = [
    ['destructured process.binding', `const { binding } = process; binding('tcp_wrap');`],
    ['destructured process.getBuiltinModule', `const { getBuiltinModule } = process;`],
    ['destructured process.dlopen', `const { dlopen } = process;`],
    ['process aliased', `const p = process; p.binding('tcp_wrap');`],
    ['process comma-wrapped', `(0, process).binding('tcp_wrap');`],
    ['process passed along', `use(process);`],
    ['destructured Reflect.get', `const { get } = Reflect; get(o, 'k');`],
    ['Reflect aliased', `const R = Reflect; R.get(o, 'k');`],
    ['module aliased', `const m = module; m.require('node:https');`],
    ['destructured module', `const { require: r } = module;`],
    ['destructured require', `const { resolve } = require;`],
  ];
  it.each(aliasing)('catches %s', (_label, code) => {
    expect(findEgress('snippet.ts', code, [])).not.toEqual([]);
    expect(findEgress('gvisor/runner.ts', code, [])).not.toEqual([]);
  });
  it.each([
    ['typeof process', `const hasProcess = typeof process !== 'undefined';`],
    ['typeof module', `const cjs = typeof module === 'object';`],
    ['process.env', `const h = process.env.HOME;`],
    ['process.argv', `const a = process.argv[2];`],
    ['Reflect.ownKeys', `const k = Reflect.ownKeys(o);`],
  ])('allows %s', (_label, code) => {
    expect(findEgress('snippet.ts', code, [])).toEqual([]);
  });

  // (2) dockerode is declared but unused: importing it anywhere is a finding.
  it.each([
    ['import', `import Docker from 'dockerode'; new Docker({ host: 'evil' });`],
    ['type and value import', `import Docker, { type ContainerCreateOptions } from 'dockerode';`],
    ['require', `const Docker = require('dockerode');`],
    ['import()', `const { default: Docker } = await import('dockerode');`],
    ['re-export', `export { default } from 'dockerode';`],
  ])('catches a dockerode %s', (_label, code) => {
    expect(findEgress('snippet.ts', code, [])).not.toEqual([]);
    expect(findEgress('gvisor/runner.ts', code, [])).not.toEqual([]);
  });

  // (3) A docker or tar argv is an inline array literal or a const array literal in the same file.
  const spawnIt = (body: string): string => `import { spawn } from 'node:child_process'; ${body}`;
  it.each([
    [
      'a const array on the host network',
      `const args = ['run', '--network', 'host', 'x']; spawn('docker', args, { env: {} });`,
    ],
    ['a parameter', `export function f(args: string[]) { spawn('docker', args, { env: {} }); }`],
    [
      'a let array',
      `let args = ['run', '--network', 'none', 'x']; spawn('docker', args, { env: {} });`,
    ],
    ['a const of unknown origin', `const args = make(); spawn('docker', args, { env: {} });`],
    ['an undeclared name', `spawn('docker', args, { env: {} });`],
    [
      'a spread of a const array on the host network',
      `const NET = ['--network', 'host']; spawn('docker', ['run', ...NET, 'x'], { env: {} });`,
    ],
    [
      'a const array pulling an image',
      `const ARGS = ['pull', 'evil/image']; spawn('docker', ARGS, { env: {} });`,
    ],
    [
      'a shadowed name: the inner const is checked',
      `const args = ['ps']; export function f() { const args = ['run', '--network', 'host', 'x']; spawn('docker', args, { env: {} }); }`,
    ],
    ['a tar const array', `const T = ['-x', '--to-command=sh']; spawn('tar', T, { env: {} });`],
  ])('catches %s', (_label, body) => {
    expect(findEgress('gvisor/runner.ts', spawnIt(body), [])).not.toEqual([]);
  });
  it.each([
    [
      'a const array',
      `const ARGS = ['ps', '--quiet'] as const; spawn('docker', ARGS, { env: {} });`,
    ],
    [
      'a spread of a const array',
      `const NET = ['--network', 'none']; spawn('docker', ['run', ...NET, img], { env: {} });`,
    ],
    [
      'nested const arrays',
      `const NET = ['--rm', '--network', 'none']; const ARGS = ['run', ...NET, img]; spawn('docker', ARGS, { env: {} });`,
    ],
  ])('allows %s', (_label, body) => {
    expect(findEgress('gvisor/runner.ts', spawnIt(`${TYPED} ${body}`), [])).toEqual([]);
  });

  it('a reviewed exception covers one call site, not every finding with its label', () => {
    expect(findEgress('boot/images.ts', read('boot/images.ts'))).toEqual([]);
    const extra = `export async function more(r: string) { await exec('docker', ['pull', '--quiet', r], { env: {} }); }`;
    expect(findEgress('boot/images.ts', `${read('boot/images.ts')}\n${extra}`)).not.toEqual([]);
    const twice = read('boot/images.ts').replace(
      "await exec('docker', ['pull', '--quiet', ref], { timeout: 600_000, env: dockerEnv() });\n  const { stdout }",
      "await exec('docker', ['pull', '--quiet', ref], { timeout: 600_000, env: dockerEnv() });\n  await exec('docker', ['pull', '--quiet', ref], { env: {} });\n  const { stdout }",
    );
    expect(twice).not.toBe(read('boot/images.ts'));
    expect(findEgress('boot/images.ts', twice)).not.toEqual([]);
  });

  it('a variable named args in runner.ts is checked, not waved through by name', () => {
    expect(findEgress('gvisor/runner.ts', read('gvisor/runner.ts'))).toEqual([]);
    const host = `export function more() { const args = ['run', '--network', 'host', 'x']; spawn('docker', args, { env: {} }); }`;
    expect(findEgress('gvisor/runner.ts', `${read('gvisor/runner.ts')}\n${host}`)).not.toEqual([]);
    const param = `export function more(args: string[]) { spawn('docker', args, { env: {} }); }`;
    expect(findEgress('gvisor/runner.ts', `${read('gvisor/runner.ts')}\n${param}`)).not.toEqual([]);
  });

  it('names every exception that has network on purpose, with reasons', () => {
    const byDesign = EGRESS_ALLOWLIST.filter(
      (a) => (a as { networkByDesign?: boolean }).networkByDesign === true,
    );
    expect(byDesign.map((a) => [a.file, (a as { name?: string }).name])).toEqual([
      ['boot/images.ts', 'pinImage pulls from Docker Hub'],
      ['boot/images.ts', 'pullPinned pulls from Docker Hub'],
      ['containment/plain-docker.ts', 'plain-Docker baseline on the default bridge'],
      ['judge:jail/workbench.ts', 'patch-apply image built on the host with network'],
      ['judge:jail/harness.ts', 'witness-runner image built on the host with network'],
    ]);
    for (const a of byDesign) expect(a.reason.length).toBeGreaterThan(60);
  });
});

/** Last round of #55: `.require`, argv constants and mutation, and packages/judge/src. */
describe('egress guard self-test: last round', () => {
  type Root = { prefix: string; dir: string };
  const roots = (): readonly Root[] =>
    (guard as { GUARD_ROOTS?: readonly Root[] }).GUARD_ROOTS ?? [];
  const spawnIt = (body: string): string => `import { spawn } from 'node:child_process'; ${body}`;
  const whats = (file: string, code: string): string[] =>
    findEgress(file, code, []).map((f) => f.what);

  // (a) any `.require` member access.
  it.each([
    ['snippet.cjs', `module.require('node:http');`],
    ['snippet.cjs', `process.mainModule.require('node:http');`],
    ['snippet.ts', `const r = x.require; r('node:http');`],
    ['snippet.ts', `x['require']('node:http');`],
  ])('catches .require in %s: %s', (file, code) => {
    expect(whats(file, code)).toContain('use .require');
  });

  // (b) argv constants are resolved, mutation is a finding, an unresolved element is a finding.
  it.each([
    [
      'a push onto an argv array',
      `const a = ['run', '--network', 'none', 'x']; a.push('--network=host'); spawn('docker', a, { env: {} });`,
      'args mutation a.push',
    ],
    [
      'an index assignment into an argv array',
      `const a = ['run', '--network', 'none', 'x']; a[2] = 'host'; spawn('docker', a, { env: {} });`,
      'args mutation a[...] =',
    ],
    [
      'unshift onto a spread source',
      `const NET = ['--network', 'none']; NET.unshift('--privileged'); spawn('docker', ['run', ...NET, 'x'], { env: {} });`,
      'args mutation NET.unshift',
    ],
    [
      'splice on an argv array',
      `const a = ['run', '--network', 'none', 'x']; a.splice(2, 1, 'host'); spawn('docker', a, { env: {} });`,
      'args mutation a.splice',
    ],
    [
      'a const string flag as an element',
      `const NET = '--network=host'; spawn('docker', ['run', NET, 'x'], { env: {} });`,
      'args --network host',
    ],
    [
      'a const string tar flag',
      `export function x(f: string) { const T = '--to-command=sh'; spawn('tar', ['-x', '-f', f, T], { env: {} }); }`,
      'tar flag --to-command',
    ],
    [
      'a const string subcommand',
      `const SUB = 'pull'; spawn('docker', [SUB, 'evil/image'], { env: {} });`,
      'docker pull',
    ],
    [
      'an unresolved identifier element',
      `spawn('docker', ['rm', '--force', who], { env: {} });`,
      'args unresolved identifier who',
    ],
    [
      'a spread of a non-const',
      `let NET = ['--network', 'none']; spawn('docker', ['run', ...NET, 'x'], { env: {} });`,
      'args spread ...NET',
    ],
  ])('catches %s', (_label, body, what) => {
    expect(whats('gvisor/runner.ts', spawnIt(body))).toContain(what);
  });
  it.each([
    [
      'a const string value',
      `export function f(img: string) { const NONE = 'none'; spawn('docker', ['run', '--network', NONE, img], { env: {} }); }`,
    ],
    [
      'a parameter element',
      `export function f(who: string) { spawn('docker', ['rm', '--force', who], { env: {} }); }`,
    ],
    [
      'reading an argv array',
      `const a = ['ps', '--quiet']; const n = a.length; spawn('docker', a, { env: {} });`,
    ],
  ])('allows %s', (_label, body) => {
    expect(whats('gvisor/runner.ts', spawnIt(body))).toEqual([]);
  });

  // (c) packages/judge/src is scanned too.
  it('scans packages/judge/src as well as packages/sandbox/src', () => {
    const r = roots();
    expect(r.map((x) => x.prefix)).toEqual(['', 'judge:']);
    const judge = r.find((x) => x.prefix === 'judge:');
    expect(judge).toBeDefined();
    const files = sourceFiles(judge?.dir ?? '');
    expect(files.length).toBeGreaterThan(10);
    const findings = files.flatMap((f) =>
      findEgress(
        `judge:${relative(judge?.dir ?? '', f)
          .split('\\')
          .join('/')}`,
        readFileSync(f, 'utf8'),
      ),
    );
    expect(findings).toEqual([]);
  });
  it('finds the judge host builds without the allowlist', () => {
    const judge = roots().find((x) => x.prefix === 'judge:');
    const at = (rel: string): string[] =>
      whats(`judge:${rel}`, readFileSync(join(judge?.dir ?? '', rel), 'utf8'));
    expect(at('jail/workbench.ts')).toContain('docker build without --network none');
    expect(at('jail/harness.ts')).toContain('docker build without --network none');
  });
  it('judge files use their own package.json and sanctioned list', () => {
    expect(
      whats('judge:snippet.ts', `import { trace } from '@opentelemetry/api'; void trace;`),
    ).toEqual([]);
    expect(
      whats('snippet.ts', `import { trace } from '@opentelemetry/api'; void trace;`),
    ).not.toEqual([]);
    const ps = `import { execFile } from 'node:child_process'; execFile('docker', ['ps'], { env: {} });`;
    expect(whats('judge:jail/harness.ts', ps)).toEqual([]);
    expect(whats('judge:patch/diff.ts', ps)).not.toEqual([]);
  });
});
