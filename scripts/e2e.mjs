// `pnpm e2e`: the fake-backed end-to-end check (implementation-plan section 8).
//
// What it checks: Postgres from docker/compose.yaml, the worker with every stage fake, the real
// CLI `scan` and `status` against it, and the web UI dev server serving the fixture-backed app.
// What it does NOT check: any gate criterion. No real port is wired (discovery, Judge, sandbox,
// evidence, signer, trial agents), so a pass here proves wiring, not a verdict.
//
// Without Docker it fails, because the in-memory replay moves no case. Set
// AFFIDAVIT_E2E_ALLOW_MEMORY=1 to accept the in-memory replay instead (reported as such).
import { runDemo, WEB_CASES } from './demo.mjs';

const NOTICE =
  'NOTICE: real ports are not wired. Every stage is a fake. This run does not test the walking-skeleton gate criteria.';
const failures = [];
const check = (ok, what) => {
  console.log(`[e2e] ${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

console.log(`[e2e] ${NOTICE}`);
const allowMemory = process.env.AFFIDAVIT_E2E_ALLOW_MEMORY === '1';
const r = await runDemo({ memory: false, web: true });

try {
  if (r.mode === 'docker') {
    check(true, 'Postgres from docker/compose.yaml started and was provisioned');
  } else {
    check(allowMemory, `docker path ran (fell back to in-memory: ${r.fallbackReason || 'forced'})`);
  }

  const out = r.scan.lines.join('\n');
  check(r.scan.code === 0, `affidavit scan exited 0 (got ${r.scan.code})`);
  check(/FAKE INTAKE/.test(out), 'scan labelled its intake as fake');
  for (const stage of ['defense', 'prosecution', 'remedy', 'verify']) {
    check(
      new RegExp(`\\s${stage}\\s+\\S+\\s+stage-entered`).test(out),
      `scan streamed stage ${stage}`,
    );
  }
  check(/verdict-written/.test(out), 'scan streamed a verdict-written event');

  if (r.mode === 'docker') {
    const st = (r.status?.lines ?? []).join('\n');
    check(r.status?.code === 0, 'affidavit status exited 0');
    check(/state finished \(verdict-written\)/.test(st), 'status reads the finished case back');
  }

  check(
    r.web.ok,
    `web UI dev server answered with the Affidavit app at ${r.web.origin || '(none)'}/`,
  );
  if (r.web.ok) {
    const origin = r.web.origin;
    const html = await (await fetch(`${origin}/cases/${WEB_CASES[0]}`)).text();
    check(html.includes('<div id="root">'), 'web UI serves the app shell for a case route');
    const data = await fetch(`${origin}/src/app/data.ts`);
    const body = await data.text();
    check(
      data.ok && WEB_CASES.every((c) => body.includes(`${c}.events.json`)),
      'web UI compiles the fixture loader with both recorded cases',
    );
  }
} finally {
  await r.teardown();
}

console.log(`[e2e] mode ${r.mode}`);
console.log(`[e2e] ${NOTICE}`);
if (failures.length > 0) {
  console.log(`[e2e] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('[e2e] all fake-backed checks passed');
process.exit(0);
