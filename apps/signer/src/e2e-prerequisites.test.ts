import { describe, expect, it } from 'vitest';
import { E2ePrerequisiteError, e2ePrerequisites } from './e2e-prerequisites.js';

const FULL = {
  AFFIDAVIT_SANDBOX_HOST: '1',
  AFFIDAVIT_NODEGOAT_DIR: '/src/nodegoat',
  AFFIDAVIT_NODEGOAT_SAFE_DIR: '/src/nodegoat-safe',
  AFFIDAVIT_NODEGOAT_BUNDLE: '/bundles/nodegoat.tar',
  AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT: '/bundles',
};

describe('e2ePrerequisites', () => {
  it('skips off a sandbox host, whatever else is set', () => {
    expect(e2ePrerequisites({}, false)).toMatchObject({ run: false });
    expect(e2ePrerequisites({ ...FULL, AFFIDAVIT_SANDBOX_HOST: undefined }, true)).toMatchObject({
      run: false,
      skipReason: expect.stringMatching(/not a sandbox host/) as unknown,
    });
    expect(e2ePrerequisites({ ...FULL, AFFIDAVIT_SANDBOX_HOST: '0' }, true).run).toBe(false);
  });

  it('runs on a sandbox host with everything present', () => {
    expect(e2ePrerequisites(FULL, true)).toEqual({
      run: true,
      setup: {
        vulnerableDir: '/src/nodegoat',
        safeDir: '/src/nodegoat-safe',
        bundlePath: '/bundles/nodegoat.tar',
        bundleStore: '/bundles',
      },
    });
  });

  it.each([
    ['AFFIDAVIT_NODEGOAT_DIR'],
    ['AFFIDAVIT_NODEGOAT_SAFE_DIR'],
    ['AFFIDAVIT_NODEGOAT_BUNDLE'],
    ['AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT'],
  ])('throws naming %s on a sandbox host instead of skipping', (name) => {
    for (const env of [
      { ...FULL, [name]: undefined },
      { ...FULL, [name]: '  ' },
    ]) {
      expect(() => e2ePrerequisites(env, true)).toThrow(E2ePrerequisiteError);
      expect(() => e2ePrerequisites(env, true)).toThrow(new RegExp(`${name} .* is not set`));
    }
  });

  it('throws naming cosign, and lists every missing prerequisite at once', () => {
    expect(() => e2ePrerequisites(FULL, false)).toThrow(/cosign is not installed/);
    let message = '';
    try {
      e2ePrerequisites({ AFFIDAVIT_SANDBOX_HOST: '1' }, false);
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of [
      'AFFIDAVIT_NODEGOAT_DIR',
      'AFFIDAVIT_NODEGOAT_SAFE_DIR',
      'AFFIDAVIT_NODEGOAT_BUNDLE',
      'AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT',
      'cosign',
    ]) {
      expect(message).toContain(name);
    }
  });
});
