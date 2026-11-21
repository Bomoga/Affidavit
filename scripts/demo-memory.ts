// Demo fallback when Docker is not available: runs the real `affidavit scan` command code with an
// in-memory case port that replays the recorded fixture stream. No database and no worker run,
// so nothing here moves a case; it only shows how the CLI renders a recorded trial.
import { readFileSync } from 'node:fs';
import type { TrialEvent } from '../packages/contracts/src/index.ts';
import { run } from '../apps/cli/src/commands.ts';
import type { CasePort } from '../apps/cli/src/runtime.ts';

const target = process.argv[2] ?? 'OWASP/NodeGoat';
const fixtureUrl = new URL('../fixtures/trials/nodegoat-sqli-001.events.json', import.meta.url);
const recorded = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as TrialEvent[];

let caseId = '';
const port: CasePort = {
  startCase: (file) => {
    caseId = file.id;
    return Promise.resolve();
  },
  stage: () => Promise.resolve(recorded.at(-1)?.stage ?? 'intake'),
  events: (id, afterSeq) =>
    Promise.resolve(
      id === caseId
        ? recorded.filter((e) => e.seq > afterSeq).map((e) => ({ ...e, caseId: id }))
        : [],
    ),
  close: () => Promise.resolve(),
};

console.log('IN-MEMORY REPLAY: no database and no worker. The CLI renders the recorded fixture.');
const code = await run(['scan', target, '--timeout', '30', '--poll-ms', '50'], {
  env: {
    // loadCliConfig validates these before the injected port is used; nothing connects to it.
    AFFIDAVIT_APP_DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    AFFIDAVIT_TENANT_ID: 'tenant-demo',
    AFFIDAVIT_INTAKE_IMPL: 'fake',
  },
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  openPort: () => Promise.resolve(port),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
process.exitCode = code;
