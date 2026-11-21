import { ConfigError, loadApiConfig } from './config.js';
import { startServer } from './server.js';

/** Starts the API from the environment. Errors name variables, never values. */
export async function main(env: Readonly<Record<string, string | undefined>>): Promise<void> {
  let config;
  try {
    config = loadApiConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
  const app = await startServer(config);
  const stop = () => {
    void app.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const isEntry = process.argv[1] !== undefined && /[\\/]main\.ts$/.test(process.argv[1]);
if (isEntry) {
  main(process.env).catch((err: unknown) => {
    // Never print the error object: a driver error can carry a connection string.
    console.error(err instanceof ConfigError ? err.message : 'the API failed to start');
    process.exitCode = 1;
  });
}
