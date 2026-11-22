import { describe, expect, it } from 'vitest';
import { DOCKER_ENV_VARS, dockerEnv } from './docker-env.js';

describe('dockerEnv (CR-12)', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/w',
    DOCKER_HOST: 'unix:///run/docker.sock',
    XDG_RUNTIME_DIR: '',
    ANTHROPIC_API_KEY: 'canary-key',
    AFFIDAVIT_WORKER_DATABASE_URL: 'postgres://u:canary@db/x',
    AFFIDAVIT_REPO_SOURCES: 'canary',
  };

  it('keeps only what the Docker CLI reads, without empty values', () => {
    expect(dockerEnv({}, source)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/w',
      DOCKER_HOST: 'unix:///run/docker.sock',
    });
    expect(JSON.stringify(dockerEnv({}, source))).not.toMatch(/canary/);
  });

  it('adds fixed settings', () => {
    expect(dockerEnv({ DOCKER_BUILDKIT: '1' }, source).DOCKER_BUILDKIT).toBe('1');
  });

  it('reads this process by default and names no secret', () => {
    expect(
      Object.keys(dockerEnv()).every((k) => (DOCKER_ENV_VARS as readonly string[]).includes(k)),
    ).toBe(true);
  });
});
