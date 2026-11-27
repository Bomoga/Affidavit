// `pnpm gate <events.json> [facts]`: judges a finished case against the walking-skeleton gate
// (docs/implementation-plan.md section 8). It runs nothing: it reads the case's event stream and
// the facts you pass, and prints PASS, FAIL or NOT RUN for each criterion. A fact you leave out is
// NOT RUN, and the gate is met only when every check is PASS.
//
//   pnpm gate case-events.json --candidate-tool semgrep --impl intake=real,trial=real,judge=real \
//     --bundle-verified yes --replay-matched yes --replay-second-machine yes --containment yes
//
// `case-events.json` is a JSON array of TrialEvent (for example the events the API returns for a
// case). Exit codes: 0 gate met, 1 gate not met, 2 bad usage or an unreadable stream.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { TrialEvent } from '../packages/contracts/src/index.ts';
import { evaluateGate, formatGateReport, type GateFacts } from '../packages/testing/src/index.ts';

const USAGE =
  'usage: pnpm gate <events.json> [--candidate-tool <tool>] [--impl intake=real,trial=real,judge=real]\n' +
  '       [--bundle-verified yes|no] [--replay-matched yes|no] [--replay-second-machine yes|no]\n' +
  '       [--containment yes|no]';

function yesNo(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'yes') return true;
  if (value === 'no') return false;
  throw new Error(`--${name} must be yes or no`);
}

function impls(value: string | undefined): GateFacts['implementations'] {
  if (value === undefined) return undefined;
  const out: Record<string, 'real' | 'fake'> = {};
  for (const part of value.split(',')) {
    const [k, v] = part.split('=');
    if (!['intake', 'trial', 'judge'].includes(k ?? '') || (v !== 'real' && v !== 'fake')) {
      throw new Error('--impl must look like intake=real,trial=real,judge=real');
    }
    out[k as string] = v;
  }
  if (out.intake === undefined || out.trial === undefined || out.judge === undefined) {
    throw new Error('--impl must name intake, trial and judge');
  }
  return { intake: out.intake, trial: out.trial, judge: out.judge };
}

function main(): number {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        'candidate-tool': { type: 'string' },
        impl: { type: 'string' },
        'bundle-verified': { type: 'string' },
        'replay-matched': { type: 'string' },
        'replay-second-machine': { type: 'string' },
        containment: { type: 'string' },
      },
    });
    const file = positionals[0];
    if (file === undefined || positionals.length > 1) {
      console.error(USAGE);
      return 2;
    }
    const events = TrialEvent.array().parse(JSON.parse(readFileSync(file, 'utf8')));
    const facts: GateFacts = {};
    if (values['candidate-tool'] !== undefined) facts.candidateTool = values['candidate-tool'];
    const implementations = impls(values.impl);
    if (implementations !== undefined) facts.implementations = implementations;
    const bundle = yesNo('bundle-verified', values['bundle-verified']);
    if (bundle !== undefined) facts.bundleVerified = bundle;
    const matched = yesNo('replay-matched', values['replay-matched']);
    if (matched !== undefined) facts.replayMatched = matched;
    const second = yesNo('replay-second-machine', values['replay-second-machine']);
    if (second !== undefined) facts.replayOnSecondMachine = second;
    const containment = yesNo('containment', values.containment);
    if (containment !== undefined) facts.containmentGreen = containment;

    const report = evaluateGate(events, facts);
    console.log(formatGateReport(report));
    return report.passed ? 0 : 1;
  } catch (err) {
    console.error(`gate: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
}

process.exit(main());
