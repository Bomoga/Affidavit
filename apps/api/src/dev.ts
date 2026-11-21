import { ConfigError } from './config.js';
import { main } from './main.js';

/**
 * `pnpm --filter @affidavit/api dev`: loopback dev auth, the in-memory store with the two fixture
 * trials seeded, fake intake replaying the nodegoat fixture for new cases, and CORS for the Vite
 * dev server. Variables already set in the environment win; every refusal in loadApiConfig still
 * applies (for example a non-loopback AFFIDAVIT_API_HOST).
 */
const DEV_DEFAULTS: Record<string, string> = {
  AFFIDAVIT_AUTH: 'dev',
  AFFIDAVIT_API_HOST: '127.0.0.1',
  AFFIDAVIT_API_PORT: '3000',
  AFFIDAVIT_API_STORE: 'memory',
  AFFIDAVIT_INTAKE_IMPL: 'fake',
  AFFIDAVIT_WEB_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
};

const env = { ...DEV_DEFAULTS, ...process.env };
main(env)
  .then(() => {
    if (process.exitCode === undefined) {
      console.log(
        `affidavit api (dev auth, ${env.AFFIDAVIT_API_STORE} store) on http://${env.AFFIDAVIT_API_HOST}:${env.AFFIDAVIT_API_PORT}`,
      );
    }
  })
  .catch((err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : 'the API failed to start');
    process.exitCode = 1;
  });
