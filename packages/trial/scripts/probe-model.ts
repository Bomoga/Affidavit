// Diagnostic probe for the real model port (L3-17, L3-18). HUMAN-RUN ONLY, by the lead, on their
// own key. Makes a few tiny live calls and prints the provider's raw error text (key redacted)
// for each failure. See docs/lanes/lane3/model-port.md, "Probing a provider error".
//
// Usage, from the repo root, with ANTHROPIC_API_KEY exported in the shell (never on the command
// line):
//   node --import tsx packages/trial/scripts/probe-model.ts [--max-usd 0.5] [--filler-kb 16] [--no-fetch]
//     [--fixture-case fixtures/casefiles/<file>.json] [--only-fixture]
// or: pnpm --filter @affidavit/trial probe:model -- [flags]
//
// The default ladder (P1 to P6) is synthetic only. `--fixture-case` adds P7, which replays the
// worker's Defense turn on a checked-in fixture case file; nothing else is ever accepted as input.
import {
  BANNER,
  DEFAULT_FILLER_KB,
  DEFAULT_MAX_USD,
  DEFAULT_RESERVE_USD,
  FIXTURE_BANNER,
  FixtureCaseError,
  ProbeKeyError,
  buildFixtureLadder,
  buildLadder,
  formatResult,
  formatSummary,
  loadFixtureCase,
  probeModelTable,
  readProbeKey,
  runLadder,
  workerTurnFrom,
  type ProbeSpec,
} from '../src/model/probe.js';
import { describeThrown } from '../src/model/redact.js';
import { sdkTransport } from '../src/model/transport.js';

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return v;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flagValue(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`--${name} needs a number`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<number> {
  const known = new Set([
    '--max-usd',
    '--filler-kb',
    '--no-fetch',
    '--fixture-case',
    '--only-fixture',
  ]);
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i] ?? '';
    if (a.startsWith('--') && !known.has(a)) {
      console.error(`unknown flag ${a}; known: ${[...known].join(', ')}`);
      return 2;
    }
  }
  const maxUsd = numberFlag('max-usd', DEFAULT_MAX_USD);
  const fillerKb = numberFlag('filler-kb', DEFAULT_FILLER_KB);
  const fixturePath = flagValue('fixture-case');
  const onlyFixture = process.argv.includes('--only-fixture');
  if (onlyFixture && fixturePath === undefined) {
    console.error('--only-fixture needs --fixture-case');
    return 2;
  }

  // The fixture is checked before anything is printed or sent, so a refused path costs nothing.
  let fixture: ReturnType<typeof loadFixtureCase> | undefined;
  if (fixturePath !== undefined) {
    try {
      fixture = loadFixtureCase(fixturePath);
    } catch (err) {
      if (err instanceof FixtureCaseError) {
        console.error(`refused: ${err.message}`);
        return 2;
      }
      throw err;
    }
  }

  console.log(BANNER);
  if (fixture !== undefined) {
    console.log('');
    console.log(FIXTURE_BANNER);
  }
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
    `USD cap $${maxUsd.toFixed(2)}, per-probe reserve and SDK maxBudgetUsd $${DEFAULT_RESERVE_USD.toFixed(2)} (P7: the worker turn maxUsd). Caps, not estimates.`,
  );

  const ladder: ProbeSpec[] = onlyFixture
    ? []
    : buildLadder(table, { fillerKb, fetch: !process.argv.includes('--no-fetch') });
  if (fixture !== undefined) {
    const { turn, notes } = workerTurnFrom(process.env);
    for (const n of notes) console.log(n);
    console.log(
      `P7 fixture ${fixture.relPath}; worker turn: maxTurns ${turn.maxTurns}, maxInputTokens ${turn.budget.maxInputTokens}, maxOutputTokens ${turn.budget.maxOutputTokens}, maxUsd ${turn.budget.maxUsd}`,
    );
    ladder.push(...buildFixtureLadder(table, fixture, turn, DEFAULT_RESERVE_USD));
  }
  console.log('');

  const run = await runLadder(
    ladder,
    { transport: sdkTransport, fetch: globalThis.fetch, env: () => process.env, modelTable: table },
    {
      maxUsd,
      allowFixtureInput: fixture !== undefined,
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
