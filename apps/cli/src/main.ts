import { run } from './commands.js';

/** Process entry point: `node --import tsx src/main.ts <command>`. */
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

run(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  signal: controller.signal,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('error: unexpected failure');
    process.exitCode = 1;
  });
