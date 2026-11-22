/**
 * Prerequisites of the Lane 2 end to end test (e2e.integration.test.ts), checked before it runs.
 * Test support only, not exported from the package.
 *
 * Off a sandbox host (no `AFFIDAVIT_SANDBOX_HOST=1`, as in plain CI) the test is skipped with
 * the reason in its title. On a sandbox host a missing prerequisite is an error naming it: the
 * `test:e2e` and `test:sandbox-host` scripts set `AFFIDAVIT_SANDBOX_HOST=1` themselves, so a skip
 * there would exit 0 with nothing checked and read as a pass.
 */

export interface E2eSetup {
  vulnerableDir: string;
  safeDir: string;
  bundlePath: string;
  bundleStore: string;
}

export type E2ePrerequisites = { run: true; setup: E2eSetup } | { run: false; skipReason: string };

export class E2ePrerequisiteError extends Error {
  override name = 'E2ePrerequisiteError';
}

const VARS = [
  ['vulnerableDir', 'AFFIDAVIT_NODEGOAT_DIR', 'the vulnerable NodeGoat tree'],
  ['safeDir', 'AFFIDAVIT_NODEGOAT_SAFE_DIR', 'the safe NodeGoat tree'],
  ['bundlePath', 'AFFIDAVIT_NODEGOAT_BUNDLE', 'the NodeGoat dependency bundle'],
  ['bundleStore', 'AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT', 'the dependency bundle store'],
] as const;

/**
 * Decides whether the end to end test runs. Throws `E2ePrerequisiteError`, listing every missing
 * prerequisite, when `AFFIDAVIT_SANDBOX_HOST=1` and something is missing.
 */
export function e2ePrerequisites(
  env: Readonly<Record<string, string | undefined>>,
  hasCosign: boolean,
): E2ePrerequisites {
  if (env.AFFIDAVIT_SANDBOX_HOST !== '1') {
    return { run: false, skipReason: 'not a sandbox host (AFFIDAVIT_SANDBOX_HOST is not 1)' };
  }
  const missing: string[] = [];
  const setup: Partial<Record<keyof E2eSetup, string>> = {};
  for (const [key, name, what] of VARS) {
    const value = env[name];
    if (value === undefined || value.trim() === '') missing.push(`${name} (${what}) is not set`);
    else setup[key] = value;
  }
  if (!hasCosign) missing.push('cosign is not installed (bash docker/sandbox/install-cosign.sh)');
  if (missing.length > 0) {
    throw new E2ePrerequisiteError(
      `AFFIDAVIT_SANDBOX_HOST=1 but the Lane 2 end to end test cannot run: ${missing.join('; ')}. ` +
        'See docs/lanes/lane2/real-judge-host.md, step 9. Unset AFFIDAVIT_SANDBOX_HOST to skip it.',
    );
  }
  return { run: true, setup: setup as E2eSetup };
}
