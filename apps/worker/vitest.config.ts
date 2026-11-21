import { defineConfig } from 'vitest/config';

// `pnpm test`: pure unit tests only. The Postgres end-to-end tests run through `pnpm test:pg`.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.pg.test.ts', '**/node_modules/**'] },
});
