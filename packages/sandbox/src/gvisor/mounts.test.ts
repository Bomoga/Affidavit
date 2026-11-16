import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateMounts } from './mounts.js';

const base = mkdtempSync(join(tmpdir(), 'affidavit-mounts-'));
const workspace = join(base, 'workspace');
const repo = join(workspace, 'repo');
const outside = join(base, 'outside');
mkdirSync(repo, { recursive: true });
mkdirSync(outside);
symlinkSync(outside, join(workspace, 'escape'));

afterAll(() => rmSync(base, { recursive: true, force: true }));

const m = (hostPath: string, containerPath = '/src', readOnly = true) => ({
  hostPath,
  containerPath,
  readOnly,
});

describe('validateMounts', () => {
  it('accepts a directory inside an allowed root', () => {
    expect(validateMounts([m(repo)], [workspace])).toEqual([m(repo)]);
  });

  it.each([
    ['the filesystem root', '/'],
    ['the Docker socket directory', '/var/run'],
    ['/run', '/run'],
    ['a sibling outside the workspace', outside],
  ])('rejects %s', (_label, hostPath) => {
    expect(() => validateMounts([m(hostPath)], [workspace])).toThrow();
  });

  it('rejects a .. path that resolves outside the workspace', () => {
    expect(() => validateMounts([m(join(workspace, '..', 'outside'))], [workspace])).toThrow(
      /outside the allowed roots/,
    );
  });

  it('rejects a symlink inside the workspace that points outside it', () => {
    expect(() => validateMounts([m(join(workspace, 'escape'))], [workspace])).toThrow(
      /outside the allowed roots/,
    );
  });

  it('does not treat a name prefix as containment', () => {
    const lookalike = `${workspace}-evil`;
    mkdirSync(lookalike);
    expect(() => validateMounts([m(lookalike)], [workspace])).toThrow(/outside the allowed roots/);
  });

  it.each([
    ['a colon (extra -v options)', `${repo}:/host`],
    ['a comma (extra --mount options)', `${repo},destination=/etc`],
    ['a newline', `${repo}\n`],
  ])('rejects a host path with %s', (_label, hostPath) => {
    expect(() => validateMounts([m(hostPath)], [workspace])).toThrow(/not allowed/);
  });

  it('rejects relative paths', () => {
    expect(() => validateMounts([m('repo')], [workspace])).toThrow(/absolute/);
    expect(() => validateMounts([m(repo, 'src')], [workspace])).toThrow(/absolute/);
  });

  it.each(['/', '/proc', '/proc/1', '/sys/fs', '/dev', '/scratch', '/tmp/x', '/etc'])(
    'rejects the reserved container path %s',
    (target) => {
      expect(() => validateMounts([m(repo, target)], [workspace])).toThrow(/reserved/);
    },
  );

  it('normalises the container path before checking it', () => {
    expect(() => validateMounts([m(repo, '/src/../proc')], [workspace])).toThrow(/reserved/);
  });

  it('refuses the filesystem root as an allowed root', () => {
    expect(() => validateMounts([m(repo)], ['/'])).toThrow(/filesystem root/);
  });

  it('rejects a path that does not exist', () => {
    expect(() => validateMounts([m(join(workspace, 'missing'))], [workspace])).toThrow();
  });
});
