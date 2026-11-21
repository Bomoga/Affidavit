import { defineConfig } from 'vitest/config';

// `pnpm test`: unit and HTTP tests on the in-memory backend. Postgres suites run through `pnpm test:pg`.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.pg.test.ts', '**/node_modules/**'] },
});
