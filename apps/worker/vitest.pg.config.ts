import { defineConfig } from 'vitest/config';

// `pnpm test:pg`: end-to-end tests against a throwaway Postgres container the tests start and
// remove themselves. Needs AFFIDAVIT_TEST_POSTGRES_PASSWORD (any fresh random value) and Docker.
if (!process.env.AFFIDAVIT_TEST_POSTGRES_PASSWORD) {
  console.warn(
    '\n[@affidavit/worker test:pg] ALL SUITES SKIPPED: AFFIDAVIT_TEST_POSTGRES_PASSWORD is not set. ' +
      'Set it in your shell to a fresh random value; the tests start their own Postgres container.\n',
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
