# Hand-written NodeGoat witnesses (L2-10, part 1)

Phase 1 witnesses are hand-written by the Lane 2 owner (implementation-plan section 6). These are
the first ones run against a real target: OWASP NodeGoat built and booted with the L2-04 boot
recipes, not a stub. Sources are in `packages/judge/witnesses/`, in the L2-05 format
(`witness-protocol.md`).

| Witness                                        | Corpus label                                        | Class     | Family                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `nodegoat-idor-allocations.witness.ts`         | `nodegoat-idor-allocations-userid`                  | idor      | 3 (attacker, victim) pairs of seeded accounts: user1 reads user2, user2 reads user1, user1 reads admin |
| `nodegoat-nosqli-allocations-where.witness.ts` | `nodegoat-nosqli-allocations-where` (the gate case) | injection | 3 `threshold` payloads that end the `$where` comparison and return other users' rows                   |

## How they prove the bug

**IDOR.** The witness logs in as the attacker (`POST /login`, a 302 means success) and requests
`/allocations/<victim id>` with that session. It passes only when the page shows "Asset Allocations
for <victim>" and not the attacker's own name. On the safe variant the route takes the user id from
the session (NodeGoat's own fix, commented out in `app/routes/allocations.js`), so the page shows
the attacker's own allocations and every parameter fails.

**NoSQL injection.** Logged in as user1, the witness requests user1's own allocations with an
injected `threshold` and passes only when another user's allocations come back. On the safe variant
(NodeGoat's own fix, `parseInt` on the threshold) the query stays scoped to user1.

Both witnesses use only NodeGoat's seeded synthetic accounts (`artifacts/db-reset.js`) and talk
only to `target`; the jail gives them no other route.

## Safe variants

The corpus (L1-08) has a safe variant for the injection label only. For IDOR, the test builds one
the same way the L2-04 boot tests build theirs: a copy of the checkout with NodeGoat's documented
fix applied in place. Adding it to the corpus as a patch (`safe-allocations-session-userid`) is
L1-13 work for Lane 1; the replacement text is in `nodegoat.integration.test.ts`.

## Wiring the boot recipes to the Judge

`packages/judge/src/jail/booted.ts`:

- `bootVariant(srcDir, hints, { workRoot })` runs the split build, creates a case network, boots
  the target with its sidecars and waits for health. It returns the endpoint the witness jail joins,
  the image ID (usable as `TargetRef.imageDigest`, so evidence bundles pin it) and the pinned
  sidecar images. It throws `TargetBootError` (`build` or `boot`, `unsupported` or `failed`) when
  the target cannot boot, after removing the network.
- `BootedTargets` is a `TargetProvider` over booted variants. A variant that was not booted throws,
  so a witness never runs without its target (which would fail and look like evidence).

Booting from a case file's pinned digest (rather than from source) and the real `PatchWorkbench`
for verifyPatch build on this and are the next step.

## Evidence

`pnpm --filter @affidavit/judge test:sandbox-host` with `AFFIDAVIT_NODEGOAT_DIR` set to the L1-08
checkout (`node packages/corpus/scripts/fetch-pinned.mjs nodegoat`), on the owner's workstation,
2026-11-17, runsc release-20261109.0. The test builds and boots three NodeGoat variants
(vulnerable, IDOR-safe, injection-safe), each with its pinned `mongo` sidecar, then:

1. The IDOR family is admitted on the differential rule: all three parameters pass on vulnerable in
   3 of 3 runs, every safe run fails, no egress.
2. A weak IDOR witness that only checks that the page loads is rejected by `differential`: it
   passes on both variants, which is exactly what the rule is for.
3. The injection family (the gate case) is admitted on the differential rule, all three parameters.

The whole judge sandbox-host suite passed 34 of 34, with no containers or networks left.

## Not done yet

- **`nodegoat-idor-benefits-userid`.** No witness yet. It changes state (`POST /benefits`), so the
  witness would need to restore it or run on a fresh target per attempt.
- **IDOR case files.** Lane 1's discovery has to emit an IDOR `CaseFile` (L1-13). The test builds
  one from the gate case file with `cls: 'idor'`.
- **Juice Shop and DVNA** (the rest of L2-10) wait on L1-14.
