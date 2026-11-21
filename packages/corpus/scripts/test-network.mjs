// Runs the network-gated corpus tests (plain `pnpm test` skips them). Needs git and network access.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const vitest = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const result = spawnSync(process.execPath, [vitest, 'run', 'src/network.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, AFFIDAVIT_CORPUS_NETWORK: '1' },
});
process.exitCode = result.status ?? 1;
