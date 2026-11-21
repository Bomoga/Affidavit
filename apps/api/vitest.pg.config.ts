import { defineConfig } from 'vitest/config';

// `pnpm test:pg`: the API against real Postgres through the affidavit_app role. Needs
// AFFIDAVIT_TEST_DATABASE_URL (superuser URL of a throwaway server); suites skip loudly without it.
if (!process.env.AFFIDAVIT_TEST_DATABASE_URL) {
  console.warn(
    '\n[@affidavit/api test:pg] ALL SUITES SKIPPED: AFFIDAVIT_TEST_DATABASE_URL is not set. ' +
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
