// `pnpm demo`: starts the fixture-driven demo stack. Wiring only, no business logic.
//
//   Postgres (docker/compose.yaml, project "affidavit-demo", volume removed on exit)
//   -> roles, migrations, tenant (scripts/demo-db-setup.ts, @affidavit/db functions)
//   -> worker (apps/worker, every stage AFFIDAVIT_*_IMPL=fake)
//   -> `affidavit scan` (apps/cli, fake intake: the recorded NodeGoat case file)
//   -> web UI dev server (apps/web, recorded fixtures through the fake SSE source)
//
// Without Docker it falls back to an in-memory replay (scripts/demo-memory.ts) and says so.
// Flags: --memory (skip Docker), --no-web, --once (tear down after the scan), --target <text>.
// Passwords are random per run, held in memory, handed to children by env, and never printed.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const COMPOSE = ['compose', '-f', join(root, 'docker', 'compose.yaml'), '-p', 'affidavit-demo'];
const TENANT = 'tenant-demo';
const WEB_PORT = 5173;
const WEB_TITLE = '<title>Affidavit case files</title>';
export const WEB_CASES = ['nodegoat-sqli-001', 'escalated-001'];

const say = (line) => console.log(`[demo] ${line}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function prefixed(stream, tag, sink) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const l of lines) sink(tag ? `${tag} ${l}` : l);
  });
  stream.on('end', () => buf && sink(tag ? `${tag} ${buf}` : buf));
}

function docker(args, env, quiet = true) {
  const r = spawnSync('docker', args, {
    cwd: root,
    env: env ?? process.env,
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function dockerAvailable() {
  return docker(['version', '--format', '{{.Server.Version}}']).ok;
}

/** Runs a node script under tsx, collects its stdout lines, and echoes them as they arrive. */
function runTsx(cwd, script, args, env, tag = '') {
  return new Promise((resolve) => {
    const lines = [];
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sink = (l) => {
      lines.push(l);
      console.log(l);
    };
    prefixed(child.stdout, tag, sink);
    prefixed(child.stderr, tag, sink);
    child.on('close', (code) => resolve({ code: code ?? 1, lines }));
  });
}

// `compose down` still interpolates the file, so it needs some POSTGRES_PASSWORD; it is not used.
const DOWN_ENV = { ...process.env, POSTGRES_PASSWORD: 'unused-for-down' };

function composeDown() {
  const r = docker([...COMPOSE, 'down', '-v', '--remove-orphans'], DOWN_ENV);
  if (!r.ok) say(`warning: docker compose down failed: ${r.out.split('\n').at(-1)}`);
  return r.ok;
}

async function startPostgres(adminPw) {
  // A leftover volume would keep an old admin password, so always start from a clean project.
  if (!composeDown())
    return { ok: false, why: 'could not remove a leftover affidavit-demo project' };
  const env = { ...process.env, POSTGRES_PASSWORD: adminPw };
  say('starting Postgres from docker/compose.yaml (project affidavit-demo, 127.0.0.1:5432)');
  const up = docker([...COMPOSE, 'up', '-d', 'postgres'], env);
  if (!up.ok) {
    return { ok: false, why: up.out.split('\n').slice(-3).join(' | ') };
  }
  for (let i = 0; i < 120; i++) {
    const r = docker(
      [...COMPOSE, 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-U', 'affidavit'],
      env,
    );
    if (r.ok) return { ok: true };
    await wait(500);
  }
  return { ok: false, why: 'Postgres did not become ready in 60s' };
}

function stopPostgres() {
  say('removing the demo Postgres container and its volume');
  composeDown();
}

function startWorker(appUrl, workerUrl) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(root, 'apps', 'worker'),
    env: {
      ...process.env,
      AFFIDAVIT_APP_DATABASE_URL: appUrl,
      AFFIDAVIT_WORKER_DATABASE_URL: workerUrl,
      AFFIDAVIT_INTAKE_IMPL: 'fake',
      AFFIDAVIT_TRIAL_IMPL: 'fake',
      AFFIDAVIT_JUDGE_IMPL: 'fake',
      AFFIDAVIT_POLL_INTERVAL_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixed(child.stdout, '', (l) => console.log(`  ${l}`));
  prefixed(child.stderr, '', (l) => console.log(`  ${l}`));
  return child;
}

/** True when nothing answers on the port and we can bind it ourselves. */
async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return false; // something answered
  } catch {
    // nothing answered; make sure we can bind it
  }
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function startWeb() {
  let port = 0;
  for (let p = WEB_PORT; p < WEB_PORT + 20; p++) {
    if (await portFree(p)) {
      port = p;
      break;
    }
  }
  if (port === 0)
    return { ok: false, origin: '', log: [`no free port in ${WEB_PORT} to ${WEB_PORT + 19}`] };
  if (port !== WEB_PORT) say(`port ${WEB_PORT} is in use by something else; using ${port}`);
  const origin = `http://127.0.0.1:${port}`;
  const vite = join(root, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: join(root, 'apps', 'web'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const log = [];
  prefixed(child.stdout, '', (l) => log.push(l));
  prefixed(child.stderr, '', (l) => log.push(l));
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${origin}/`);
      // Only our app counts: another dev server on the same port must not look like success.
      if (res.ok && (await res.text()).includes(WEB_TITLE)) return { child, ok: true, origin, log };
    } catch {
      // not listening yet
    }
    await wait(500);
  }
  return { child, ok: false, origin, log };
}

function kill(child) {
  if (child && child.exitCode === null) child.kill();
}

/**
 * Starts the demo. Returns what happened plus a `teardown` that stops every process it started
 * and removes the demo container. Never throws for an expected failure; it reports it.
 */
export async function runDemo({ memory = false, web = true, target = 'OWASP/NodeGoat' } = {}) {
  const started = { worker: undefined, web: undefined, postgres: false };
  const result = { mode: 'memory', fallbackReason: '', scan: { code: 1, lines: [] }, caseId: '' };
  result.status = undefined;
  result.web = { ok: false, origin: '', log: [] };

  if (!memory) {
    if (!dockerAvailable()) {
      result.fallbackReason = 'Docker is not available';
    } else {
      const pw = () => randomBytes(18).toString('hex');
      const adminPw = pw();
      const pg = await startPostgres(adminPw);
      started.postgres = true;
      if (!pg.ok) {
        result.fallbackReason = `Postgres did not start (${pg.why})`;
        stopPostgres();
        started.postgres = false;
      } else {
        const url = (u, p) => `postgres://${u}:${p}@127.0.0.1:5432/affidavit`;
        const ownerPw = pw();
        const appPw = pw();
        const workerPw = pw();
        const appUrl = url('affidavit_app', appPw);
        const workerUrl = url('affidavit_worker', workerPw);
        const setup = await runTsx(root, 'scripts/demo-db-setup.ts', [], {
          ...process.env,
          DEMO_ADMIN_URL: url('affidavit', adminPw),
          DEMO_OWNER_URL: url('affidavit_owner', ownerPw),
          DEMO_OWNER_PW: ownerPw,
          DEMO_APP_PW: appPw,
          DEMO_WORKER_PW: workerPw,
          DEMO_TENANT: TENANT,
        });
        if (setup.code !== 0) {
          result.fallbackReason = 'database setup failed';
        } else {
          result.mode = 'docker';
          say('starting the worker (intake, trial and judge all fake)');
          started.worker = startWorker(appUrl, workerUrl);
          const cliEnv = {
            ...process.env,
            AFFIDAVIT_APP_DATABASE_URL: appUrl,
            AFFIDAVIT_TENANT_ID: TENANT,
            AFFIDAVIT_INTAKE_IMPL: 'fake',
          };
          const cli = join(root, 'apps', 'cli');
          say(`affidavit scan ${target}`);
          result.scan = await runTsx(
            cli,
            'src/main.ts',
            ['scan', target, '--timeout', '60'],
            cliEnv,
          );
          const m = result.scan.lines.map((l) => /^case (\S+) enqueued/.exec(l)).find(Boolean);
          result.caseId = m ? m[1] : '';
          if (result.caseId) {
            say(`affidavit status ${result.caseId}`);
            result.status = await runTsx(
              cli,
              'src/main.ts',
              ['status', result.caseId, '--tail', '3'],
              cliEnv,
            );
          }
        }
      }
    }
    if (result.mode !== 'docker') {
      say(`FALLBACK to the in-memory replay: ${result.fallbackReason}`);
    }
  }

  if (result.mode === 'memory') {
    say(`in-memory replay of affidavit scan ${target}`);
    result.scan = await runTsx(root, 'scripts/demo-memory.ts', [target], process.env);
  }

  if (web) {
    say('starting the web UI dev server');
    const w = await startWeb();
    started.web = w.child;
    result.web = { ok: w.ok, origin: w.origin, log: w.log };
    if (w.ok) {
      say('web UI ready (recorded fixtures through the fake SSE source):');
      say(`  ${w.origin}/`);
      for (const c of WEB_CASES) say(`  ${w.origin}/cases/${c}`);
    } else {
      say('web UI did not start; last log lines:');
      for (const l of w.log.slice(-10)) say(`  ${l}`);
    }
  }

  const teardown = async () => {
    kill(started.web);
    kill(started.worker);
    await wait(300);
    if (started.postgres) stopPostgres();
  };
  return { ...result, teardown };
}

async function main() {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--target');
  const opts = {
    memory: argv.includes('--memory'),
    web: !argv.includes('--no-web'),
    target: ti >= 0 && argv[ti + 1] ? argv[ti + 1] : 'OWASP/NodeGoat',
  };
  const once = argv.includes('--once');
  say(
    'Fixture-driven demo. Every stage is a FAKE; no real port (discovery, Judge, trial) is wired.',
  );
  const r = await runDemo(opts);
  say(`mode ${r.mode}; scan exit code ${r.scan.code}`);
  let stopping = false;
  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    await r.teardown();
    process.exit(code);
  };
  if (once || !opts.web) {
    await stop(r.scan.code);
    return;
  }
  say('Press Ctrl+C to stop everything.');
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
