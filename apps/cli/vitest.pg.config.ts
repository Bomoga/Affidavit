import { defineConfig } from 'vitest/config';

// `pnpm test:pg`: end-to-end test against a throwaway Postgres container the test starts and
// removes itself. Needs AFFIDAVIT_TEST_POSTGRES_PASSWORD (any fresh random value) and Docker.
if (!process.env.AFFIDAVIT_TEST_POSTGRES_PASSWORD) {
  console.warn(
    '\n[@affidavit/cli test:pg] ALL SUITES SKIPPED: AFFIDAVIT_TEST_POSTGRES_PASSWORD is not set. ' +
      'Set it in your shell to a fresh random value; the test starts its own Postgres container.\n',
  );
}

export default defineConfig({
  test: {
    include: ['src/**/*.pg.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
