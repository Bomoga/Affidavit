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
import { afterAll, describe, expect, it } from 'vitest';
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
  const base = mkdtempSync(join(tmpdir(), 'affidavit-runner-it-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
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
});
