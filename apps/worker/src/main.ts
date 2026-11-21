import { describeConfig, loadConfig } from './config.js';
import { startWorker } from './worker.js';

/** Process entry point: configuration from the environment, then run until signalled. */
async function main(): Promise<void> {
  const config = loadConfig();
  console.error('[worker] starting', JSON.stringify(describeConfig(config)));
  const worker = await startWorker(config);
  const shutdown = () => {
    void worker.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  // Config errors carry no secrets; database errors may name a host, never a password.
  console.error('[worker] fatal:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
