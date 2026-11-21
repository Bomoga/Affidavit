import { defineConfig } from 'vitest/config';

// `pnpm test:pg`: Postgres integration tests. Needs AFFIDAVIT_TEST_DATABASE_URL; each suite
// skips itself with an explicit reason when it is unset. Suites share one server, so run serially.
if (!process.env.AFFIDAVIT_TEST_DATABASE_URL) {
  console.warn(
    '\n[@affidavit/db test:pg] ALL SUITES SKIPPED: AFFIDAVIT_TEST_DATABASE_URL is not set. ' +
      'Point it at the superuser URL of a throwaway Postgres server ' +
      '(docker compose -f docker/compose.yaml up -d postgres). CI does not run these tests yet.\n',
  );
}

export default defineConfig({
  test: {
    include: ['src/**/*.pg.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
