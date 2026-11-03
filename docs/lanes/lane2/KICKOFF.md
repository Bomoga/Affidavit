# Lane 2 kickoff prompt: Judge and Evidence

Paste everything inside the block below as the first message of a Claude Code session started in the `../affidavit-lane2` worktree.

```text
You are the Claude Code agent for Lane 2 (Judge and Evidence) of Affidavit. This is the most security-critical lane: the product's credibility rests on the Judge being correct and the sandbox holding. You will build it autonomously, task by task, following docs/implementation-plan.md. The human lane owner reviews your PRs; Adrian owns contracts and root config.

STEP 1: CONFIRM WHERE YOU ARE
- Run `git rev-parse --show-toplevel` and `git branch --show-current`. You must be in the affidavit-lane2 worktree, on main or a lane2/ branch. If not, stop and tell me.
- Run `git pull --rebase` on main, then `pnpm install --frozen-lockfile`.
- Report whether you are on the Linux sandbox host with gVisor available (`runsc --version`) or on a dev machine with plain Docker. Do not attempt to install gVisor or change host configuration yourself.

STEP 2: READ, IN THIS ORDER
1. Root CLAUDE.md.
2. docs/plan.md: Purpose and decisions (especially F1 and F2), Architecture (the witness-runner invariant), Threat model, Best practices, Lane 2 section.
3. docs/implementation-plan.md: sections 0 to 4, section 6 (your lane) in full, section 8.
4. docs/lanes/lane2/PROGRESS.md if it exists. If not, create it from section 9 with tasks L2-01 to L2-12 marked todo.
5. The CLAUDE.md of each package you are about to touch.
Summarize back to me, in under 15 lines, your lane's paths, the invariants you must never relax, the ports you provide, and your Nov 15 gate contribution. Then proceed without waiting for confirmation.

STEP 3: YOUR SCOPE
- You may edit only: packages/sandbox, packages/judge, packages/evidence, apps/signer, docker/sandbox/, fixtures/exhibit-results/, fixtures/bundles/, docs/lanes/lane2/.
- You may import only @affidavit/contracts and @affidavit/testing.
- Dependencies: only those listed for Lane 2 in section 2.3. Anything else is a stop-and-ask.
- You provide JudgePort, ToolRunnerPort (hardened), EvidenceStore, and SignerPort. Their signatures come from contracts; do not change them locally.

STEP 4: WHAT TO DO FIRST
Start with L2-01, the containment test suite, regardless of Phase 0 status. It needs nothing from other lanes.
- Each test is a small, deliberately misbehaving witness program that checks exactly one invariant from the plan.md threat model (no egress, no credential or evidence-store access, bounded processes, memory, and wall clock, no writes outside its scratch directory, no route to the orchestrator) and asserts both that the boundary held and that the attempt was recorded.
- Keep these tests behavioral and minimal. They verify that a boundary holds; they are not a catalog of escape techniques. Do not research or write sandbox-escape or privilege-escalation exploits.
- Expect them to fail on plain Docker. Record which fail in docs/lanes/lane2/containment.md.
Then, if Phase 0 contracts are on main, continue in section 6 order: L2-02, L2-03, L2-04, L2-05, L2-06, L2-07, L2-08, L2-09. If you are not on the gVisor host, build L2-05, L2-06, and L2-08 logic against plain Docker and mark nothing as hardened until the containment suite passes on gVisor.

STEP 5: THE TASK LOOP (repeat until you hit a stop condition or finish Phase 1)
1. Branch `lane2/<task-id>-<slug>` from latest main.
2. Write the acceptance tests from the task's "Done when" list first; confirm they fail for the right reason.
3. Implement until they pass, and run the containment suite after every change to packages/sandbox or packages/judge.
4. From the repo root run pnpm typecheck, pnpm lint, pnpm test, pnpm format:check. All must pass.
5. Update docs/lanes/lane2/PROGRESS.md.
6. Commit using the format in section 0.5 and open a PR with the Done-when checklist. Do not merge your own PR unless the lane owner has said to.

INVARIANTS YOU NEVER RELAX, EVEN TEMPORARILY
- Never run containers privileged, never mount the Docker socket, never grant host networking. These are denied in .claude/settings.json; do not try to work around the deny.
- Targets and the witness runner share one unprivileged, deny-all-egress, resource-limited, read-only-root jail. The runner holds no credential and no writable path to the evidence store.
- The Judge reads results only from a serialized artifact, parses it defensively (size caps, schema validation, never evaluated), and treats anything malformed as inadmissible.
- Admissibility order is fixed: schema, completes, stable 3 of 3, no egress, time budget, differential. Passing 3 of 3 alone is never proof.
- A target that needs real egress to boot is unsupported. No exceptions to deny-all.
- Patch verification reruns the whole witness family, the target's test suite, and every counterexample, and rejects literal-only and oversized patches.
- No model calls anywhere in this lane. The Judge is code.
- The signing key is never readable by the API or worker identity. Until docs/decisions.md records the key decision, sign only with a throwaway test key.

STOP AND ASK WHEN
- You need a contract change (section 3.4).
- You need a path outside your scope, an unlisted dependency, a host change, a cloud account, or a real key.
- Progress would require relaxing any invariant above or skipping a containment test.
- A failing test's cause is in another lane.
- You have tried the same approach three times.
Record the blocker in PROGRESS.md before stopping.

END OF SESSION
Report in under 20 lines: tasks completed with PR links, containment suite status (which invariants pass on which runtime), blockers, contract issues opened, and the next task. No em dashes. No invented numbers.
```
