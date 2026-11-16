import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBE_IMAGE } from '../containment/probes.js';
import { DEFAULT_TRACE_ROOT, RUN_LABEL } from './args.js';
import { GvisorRunner, GvisorToolRunner } from './runner.js';

// Needs a sandbox host: Docker with the runsc-affidavit runtime (see docs/lanes/lane2/sandbox-runner.md).
// Run with `pnpm --filter @affidavit/sandbox test:sandbox-host`. Skipped in plain `pnpm test`, which
// runs on machines and CI runners without gVisor (recorded in docs/lanes/lane2/PROGRESS.md).
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';

const leftovers = (): string =>
  execFileSync('docker', ['ps', '--all', '--quiet', '--filter', `label=${RUN_LABEL}`], {
    encoding: 'utf8',
  }).trim();

describe.runIf(onSandboxHost)('gVisor runner on a sandbox host', { timeout: 120_000 }, () => {
  // Created in beforeAll, not in the describe body: Vitest runs the body even when the suite is
  // skipped, and then never runs afterAll, which leaked one directory per plain `pnpm test`.
  let base = '';
  let workspace = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'affidavit-runner-it-'));
    workspace = join(base, 'workspace');
    mkdirSync(workspace);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('runs a script inside gVisor and tears everything down', async () => {
    const before = readdirSync(DEFAULT_TRACE_ROOT).length;
    const r = await new GvisorRunner().run({
      script: 'import os from "node:os"; console.log("kernel", os.release());',
      args: {},
      timeoutMs: 30_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/kernel .*gvisor/);
    expect(leftovers()).toBe('');
    expect(readdirSync(DEFAULT_TRACE_ROOT).length).toBe(before);
  });

  it('records an egress attempt and a refused write', async () => {
    const r = await new GvisorRunner().run({
      script: `
        import net from 'node:net';
        import { writeFile } from 'node:fs/promises';
        await new Promise((done) => net.connect(443, '1.1.1.1').on('error', done));
        await writeFile('/etc/affidavit', 'x').catch(() => {});
      `,
      args: {},
      timeoutMs: 30_000,
    });
    expect(r.observations.egressAttempts).toBeGreaterThan(0);
    expect(r.observations.deniedWrites).toBeGreaterThan(0);
  });

  it('refuses to judge a run whose process renamed itself to hide a connect', async () => {
    const before = readdirSync(DEFAULT_TRACE_ROOT).length;
    await expect(
      new GvisorRunner().run({
        script: `
          import net from 'node:net';
          process.title = 'a b';
          await new Promise((done) => net.connect(443, '9.9.9.9').on('error', done));
        `,
        args: {},
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/tampered/);
    expect(leftovers()).toBe('');
    expect(readdirSync(DEFAULT_TRACE_ROOT).length).toBe(before);
  });

  it('kills a run whose trace passes its cap, deletes the trace, and refuses to judge it', async () => {
    const before = readdirSync(DEFAULT_TRACE_ROOT).length;
    const started = Date.now();
    await expect(
      new GvisorRunner({ maxTraceBytes: 4 * 1024 * 1024 }).run({
        script: `import fs from 'node:fs';
          for (;;) { try { fs.openSync('/nope'); } catch {} }`,
        args: {},
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/size cap/);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(leftovers()).toBe('');
    expect(readdirSync(DEFAULT_TRACE_ROOT).length).toBe(before);
  });

  it('kills a run at its timeout and leaves nothing behind', async () => {
    const started = Date.now();
    const r = await new GvisorRunner().run({
      script: 'setInterval(() => {}, 1000);',
      args: {},
      timeoutMs: 3_000,
    });
    expect(r.observations.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000 + 15_000);
    expect(leftovers()).toBe('');
  });

  it('runs a Lane 1 tool with a read-only source and a writable output mount', async () => {
    const src = join(workspace, 'repo');
    const out = join(workspace, 'out');
    mkdirSync(src, { recursive: true });
    mkdirSync(out);
    chmodSync(out, 0o777); // the jail runs as nobody
    writeFileSync(join(src, 'app.js'), 'const q = "SELECT " + id;');

    const tools = new GvisorToolRunner({ outputDir: out, allowedRoots: [workspace] });
    const traces = readdirSync(DEFAULT_TRACE_ROOT).length;
    const result = await tools.run(
      PROBE_IMAGE,
      [
        'node',
        '-e',
        `const fs = require('fs');
         fs.writeFileSync('/out/result.json', JSON.stringify({ size: fs.readFileSync('/src/app.js').length }));
         try { fs.writeFileSync('/src/tamper', 'x'); process.exit(3); } catch {}`,
      ],
      [
        { hostPath: src, containerPath: '/src', readOnly: true },
        { hostPath: out, containerPath: '/out', readOnly: false },
      ],
    );
    expect(result).toEqual({ exitCode: 0, outputPath: out });
    expect(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))).toEqual({ size: 25 });
    expect(existsSync(join(src, 'tamper'))).toBe(false);
    expect(leftovers()).toBe('');
    expect(readdirSync(DEFAULT_TRACE_ROOT).length).toBe(traces); // tools run untraced
  });

  it('refuses a mount outside the workspace before starting anything', async () => {
    const tools = new GvisorToolRunner({ outputDir: base, allowedRoots: [workspace] });
    await expect(
      tools.run(PROBE_IMAGE, ['true'], [{ hostPath: '/run', containerPath: '/x', readOnly: true }]),
    ).rejects.toThrow(/outside the allowed roots/);
  });

  it('refuses an image that declares a VOLUME before starting anything', async () => {
    const tag = 'affidavit-it-volume-image:latest';
    const ctx = join(base, 'volume-image');
    mkdirSync(ctx);
    writeFileSync(join(ctx, 'Dockerfile'), `FROM ${PROBE_IMAGE}\nVOLUME /data\n`);
    execFileSync('docker', ['build', '--quiet', '--tag', tag, ctx], { encoding: 'utf8' });
    const volumesBefore = execFileSync('docker', ['volume', 'ls', '--quiet'], { encoding: 'utf8' });
    try {
      const tools = new GvisorToolRunner({ outputDir: base, allowedRoots: [workspace] });
      await expect(tools.run(tag, ['true'], [])).rejects.toThrow(/declares volumes/);
      expect(leftovers()).toBe('');
      expect(execFileSync('docker', ['volume', 'ls', '--quiet'], { encoding: 'utf8' })).toBe(
        volumesBefore,
      );
    } finally {
      execFileSync('docker', ['image', 'rm', '--force', tag]);
    }
  });
});
