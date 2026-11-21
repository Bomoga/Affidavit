// Hand-written witness family (Lane 2, Phase 1) for corpus label nodegoat-idor-allocations-userid:
// GET /allocations/:userId takes the user id from the URL, not the session, so any logged-in user
// reads another user's allocations. Run by the witness runner (docs/lanes/lane2/witness-protocol.md).
//
// Each parameter is one (attacker, victim) pair of NodeGoat's seeded accounts
// (artifacts/db-reset.js). The witness logs in as the attacker and passes only when the page shows
// the victim's allocations and not the attacker's own. On the safe variant (user id from the
// session) the page shows the attacker's own allocations, so every parameter fails.
import { expect } from 'vitest';
import { witness } from '@affidavit/witness';

interface Account {
  userName: string;
  password: string;
  name: string;
}

interface Params {
  pair: { attacker: Account; victim: { userId: number; name: string } };
}

witness<Params>(async ({ pair: { attacker, victim } }, { target }) => {
  expect(target).not.toBeNull();
  const base = target!.url;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      userName: attacker.userName,
      password: attacker.password,
    }).toString(),
  });
  // A successful login redirects; a failed one renders the login page again with 200.
  expect(login.status).toBe(302);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  expect(cookie).toContain('connect.sid=');

  const res = await fetch(`${base}/allocations/${victim.userId}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(`Asset Allocations for ${victim.name}`);
  expect(html).not.toContain(`Asset Allocations for ${attacker.name}`);
});
