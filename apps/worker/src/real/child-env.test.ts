import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SECRET_VARS, childEnv, sealSecrets } from './child-env.js';
import { makeHostProbe } from './prereqs.js';

const CANARY = 'AFFIDAVIT_CANARY_MUST_NOT_REACH_A_CHILD';
const dir = mkdtempSync(join(tmpdir(), 'affidavit-child-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the Docker CLI: prints the names of the variables it was given as "runtimes". */
const stub = join(dir, 'docker-stub.cjs');
writeFileSync(
  stub,
  'process.stdout.write(JSON.stringify(Object.fromEntries(Object.keys(process.env).map((k) => [k.toUpperCase(), {}]))));\n',
);

describe('child process environment', () => {
  it('childEnv keeps only what the Docker CLI needs', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/w',
      DOCKER_HOST: 'unix:///run/docker.sock',
      XDG_RUNTIME_DIR: '/run/user/1000',
      ANTHROPIC_API_KEY: 'k',
      AFFIDAVIT_APP_DATABASE_URL: 'postgres://u:p@h/d',
      AFFIDAVIT_WORKER_DATABASE_URL: 'postgres://u:p@h/d',
      AFFIDAVIT_REPO_SOURCES: '{}',
      [CANARY]: 'x',
    };
    expect(childEnv(source, 'linux')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/w',
      DOCKER_HOST: 'unix:///run/docker.sock',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    expect(
      childEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t' }, 'win32'),
    ).toEqual({ PATH: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\t' });
  });

  it('the docker probe child never sees a secret or a canary from the worker environment', async () => {
    const saved = Object.fromEntries([CANARY, ...SECRET_VARS].map((k) => [k, process.env[k]]));
    try {
      for (const k of [CANARY, ...SECRET_VARS]) process.env[k] = 'canary-value';
      const probe = makeHostProbe({ docker: [process.execPath, stub] });
      const seen = await probe.dockerRuntimes();
      expect(seen).not.toBeNull();
      expect(seen).toContain('PATH');
      for (const k of [CANARY, ...SECRET_VARS]) expect(seen).not.toContain(k);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('sealSecrets moves secrets out of process.env, so an inheriting child cannot see them', () => {
    const target: NodeJS.ProcessEnv = { ...process.env };
    for (const k of SECRET_VARS) target[k] = 'secret-value';
    const snapshot = sealSecrets(target);
    for (const k of SECRET_VARS) {
      expect(snapshot[k]).toBe('secret-value');
      expect(target[k]).toBeUndefined();
    }
    expect(Object.isFrozen(snapshot)).toBe(true);
    // A child spawned the way other lanes' runners spawn (inheriting the given environment).
    const out = execFileSync(process.execPath, [stub], { env: target, encoding: 'utf8' });
    const names = Object.keys(JSON.parse(out) as Record<string, unknown>);
    for (const k of SECRET_VARS) expect(names).not.toContain(k);
  });
});
