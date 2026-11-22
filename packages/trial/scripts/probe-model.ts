// Diagnostic probe for the real model port (L3-17). HUMAN-RUN ONLY, by the lead, on their own
// key. Makes a few tiny live calls with fixed synthetic text and prints the provider's raw
// error text (key redacted) for each failure. See docs/lanes/lane3/model-port.md, "Probing a
// provider error".
//
// Usage, from the repo root, with ANTHROPIC_API_KEY exported in the shell (never on the command
// line):
//   node --import tsx packages/trial/scripts/probe-model.ts [--max-usd 0.5] [--filler-kb 16] [--no-fetch]
// or: pnpm --filter @affidavit/trial probe:model -- [flags]
import {
  BANNER,
  DEFAULT_FILLER_KB,
  DEFAULT_MAX_USD,
  DEFAULT_RESERVE_USD,
  ProbeKeyError,
  buildLadder,
  formatResult,
  formatSummary,
  probeModelTable,
  readProbeKey,
  runLadder,
} from '../src/model/probe.js';
import { describeThrown } from '../src/model/redact.js';
import { sdkTransport } from '../src/model/transport.js';

function numberFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n)) {
    console.error(`--${name} needs a number`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<number> {
  const known = new Set(['--max-usd', '--filler-kb', '--no-fetch']);
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i] ?? '';
    if (a.startsWith('--') && !known.has(a)) {
      console.error(`unknown flag ${a}; known: ${[...known].join(', ')}`);
      return 2;
    }
  }
  const maxUsd = numberFlag('max-usd', DEFAULT_MAX_USD);
  const fillerKb = numberFlag('filler-kb', DEFAULT_FILLER_KB);

  console.log(BANNER);
  console.log('');
  try {
    readProbeKey(process.env);
  } catch (err) {
    if (err instanceof ProbeKeyError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const { table, note } = probeModelTable(process.env);
  if (note !== undefined) console.log(note);
  console.log(
    `Model table: ${Object.entries(table)
      .map(([p, m]) => `${p}=${m}`)
      .join(', ')}`,
  );
  console.log(
    `USD cap $${maxUsd.toFixed(2)}, per-probe reserve and SDK maxBudgetUsd $${DEFAULT_RESERVE_USD.toFixed(2)}. Caps, not estimates.`,
  );
  console.log('');

  const ladder = buildLadder(table, { fillerKb, fetch: !process.argv.includes('--no-fetch') });
  const run = await runLadder(
    ladder,
    { transport: sdkTransport, fetch: globalThis.fetch, env: () => process.env, modelTable: table },
    {
      maxUsd,
      onResult: (r) => {
        console.log(formatResult(r));
        console.log('');
      },
    },
  );
  console.log(formatSummary(run, maxUsd));
  return run.results.every((r) => r.status === 'PASS') ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // A bug in the probe itself. Redacted, so the key can never be printed.
    console.error(`probe crashed: ${describeThrown(err, [process.env.ANTHROPIC_API_KEY])}`);
    process.exit(2);
  },
);
