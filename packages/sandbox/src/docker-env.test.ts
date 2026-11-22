import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_ENV_VARS,
  WINDOWS_DOCKER_ENV_VARS,
  dockerEnv,
  dockerEnvVars,
} from './docker-env.js';

describe('dockerEnv (CR-12)', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/w',
    DOCKER_HOST: 'unix:///run/docker.sock',
    XDG_RUNTIME_DIR: '',
    ANTHROPIC_API_KEY: 'canary-key',
    AFFIDAVIT_WORKER_DATABASE_URL: 'postgres://u:canary@db/x',
    AFFIDAVIT_REPO_SOURCES: 'canary',
    SystemRoot: 'C:\\Windows',
  };

  it('keeps only what the Docker CLI reads, without empty values', () => {
    expect(dockerEnv({}, source, 'linux')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/w',
      DOCKER_HOST: 'unix:///run/docker.sock',
    });
    expect(JSON.stringify(dockerEnv({}, source, 'linux'))).not.toMatch(/canary/);
  });

  it('adds fixed settings', () => {
    expect(dockerEnv({ DOCKER_BUILDKIT: '1' }, source, 'linux').DOCKER_BUILDKIT).toBe('1');
  });

  it('on Windows also passes what a process and the Docker CLI need, by any case', () => {
    const win = {
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\t',
      TMP: 'C:\\t',
      PATHEXT: '.EXE',
      USERPROFILE: 'C:\\Users\\w',
      APPDATA: 'C:\\Users\\w\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\w\\AppData\\Local',
      ProgramData: 'C:\\ProgramData',
      ProgramFiles: 'C:\\Program Files',
      ANTHROPIC_API_KEY: 'canary-key',
      AFFIDAVIT_APP_DATABASE_URL: 'postgres://u:canary@db/x',
    };
    expect(dockerEnv({}, win, 'win32')).toEqual({
      PATH: 'C:\\bin',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\t',
      TMP: 'C:\\t',
      PATHEXT: '.EXE',
      USERPROFILE: 'C:\\Users\\w',
      APPDATA: 'C:\\Users\\w\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\w\\AppData\\Local',
      PROGRAMDATA: 'C:\\ProgramData',
      PROGRAMFILES: 'C:\\Program Files',
    });
    // The Windows names are not passed elsewhere.
    expect(dockerEnv({}, source, 'linux')).not.toHaveProperty('SYSTEMROOT');
  });

  it('reads this process by default and names no secret', () => {
    expect(Object.keys(dockerEnv()).every((k) => dockerEnvVars().includes(k))).toBe(true);
    for (const name of dockerEnvVars('win32')) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|DATABASE|URL|SOURCES/);
    }
  });
});

/**
 * One source of truth: the worker's `childEnv` (apps/worker, Lane 1) starts `docker` too. Until it
 * imports these lists (asked under CR-12 in docs/lanes/lane1/contract-requests.md), its lists must
 * be covered by ours, and its Windows list may lack only the names below. Read as text: the worker
 * is not a dependency of this package.
 */
describe("the worker's childEnv allowlist agrees with dockerEnv", () => {
  const file = fileURLToPath(
    new URL('../../../apps/worker/src/real/child-env.ts', import.meta.url),
  );
  const text = readFileSync(file, 'utf8');
  const list = (name: string): string[] | null => {
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(text);
    if (m === null) return null;
    return [...(m[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((x) => x[1] ?? '');
  };
  /** In ours, not yet in the worker's Windows list (Lane 1 to adopt). */
  const NOT_YET_IN_WORKER = [
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
  ];
  const adopted = /from '@affidavit\/sandbox'/.test(text) && /DOCKER_ENV_VARS/.test(text);

  it('has the same Docker list and a covered Windows list', () => {
    if (adopted) return; // the worker imports the lists from here: nothing to compare
    const docker = list('DOCKER_VARS');
    const windows = list('WINDOWS_VARS');
    expect(docker, 'DOCKER_VARS in child-env.ts').not.toBeNull();
    expect(windows, 'WINDOWS_VARS in child-env.ts').not.toBeNull();
    expect(docker).toEqual([...DOCKER_ENV_VARS]);
    expect([...new Set([...(windows ?? []), ...NOT_YET_IN_WORKER])].sort()).toEqual(
      [...WINDOWS_DOCKER_ENV_VARS].sort(),
    );
  });
});
