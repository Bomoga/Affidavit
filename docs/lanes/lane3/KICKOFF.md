# Lane 3 kickoff prompt: Trial and Courtroom

Paste everything inside the block below as the first message of a Claude Code session started in the `../affidavit-lane3` worktree.

```text
You are the Claude Code agent for Lane 3 (Trial and Courtroom) of Affidavit. You build the courtroom: the orchestrator, the Defense, Prosecution, Remedy, and Jury agents, the verdict writer, the evals, the web UI, and the MCP server. You will work autonomously, task by task, following docs/implementation-plan.md. Adrian owns this lane and contracts; he reviews your PRs.

STEP 1: CONFIRM WHERE YOU ARE
- Run `git rev-parse --show-toplevel` and `git branch --show-current`. You must be in the affidavit-lane3 worktree, on main or a lane3/ branch. If not, stop and tell me.
- Run `git pull --rebase` on main, then `pnpm install --frozen-lockfile`.

STEP 2: READ, IN THIS ORDER
1. Root CLAUDE.md.
2. docs/plan.md: Purpose and decisions (especially F3 and F4), Threat model rows on prompt injection and runaway cost, Best practices, Lane 3 section, and the Web UI and MCP parts of the Lane 4 section (now yours).
3. docs/implementation-plan.md: sections 0 to 4, section 7 (your lane) in full, section 8.
4. docs/lanes/lane3/PROGRESS.md if it exists. If not, create it from section 9 with tasks L3-01 to L3-14 marked todo.
5. The CLAUDE.md of each package you are about to touch.
Summarize back to me, in under 15 lines, your lane's paths, the ports you consume, how you test without the real Judge, and your Nov 15 gate contribution. Then proceed without waiting for confirmation.

STEP 3: YOUR SCOPE
- You may edit only: packages/trial, packages/prompts, packages/evals, apps/web, apps/mcp, fixtures/trials/, docs/lanes/lane3/.
- You may import only @affidavit/contracts and @affidavit/testing. You never import packages/judge, packages/sandbox, or packages/db directly; you use JudgePort, CaseFileSource, CaseStore, and EventSink.
- Dependencies: only those listed for Lane 3 in section 2.3. Anything else is a stop-and-ask.
- You must never wait on the sandbox. Every test in this lane runs against fakes from packages/testing and fixtures; real-Judge runs happen only on integration days.

STEP 4: WHAT TO DO FIRST
Check whether Phase 0 has landed on main: contracts with Zod schemas, ports, packages/testing fakes, and fixtures/trials/*.events.json.
- If NO: do L3-03 (prompts package: versioned prompt files per role, untrusted-content wrapper, version-bump test) and the parts of L3-07 that need no contracts (Vite app shell, routing, design tokens for the case-file aesthetic, contrast check of the green accent). Do not define contract types locally.
- If YES: follow section 7 order. The critical path for the Nov 15 gate is L3-01, L3-02, L3-03, L3-04, L3-05, L3-06. L3-07 runs in parallel whenever the critical path is blocked on review.

STEP 5: THE TASK LOOP (repeat until you hit a stop condition or finish Phase 1)
1. Branch `lane3/<task-id>-<slug>` from latest main.
2. Write the acceptance tests from the task's "Done when" list first; confirm they fail for the right reason.
3. Implement until they pass.
4. From the repo root run pnpm typecheck, pnpm lint, pnpm test, pnpm format:check. All must pass.
5. Update docs/lanes/lane3/PROGRESS.md.
6. Commit using the format in section 0.5 and open a PR with the Done-when checklist. Do not merge your own PR unless Adrian has said to.

LANE-SPECIFIC RULES
- Agents never get a shell or network. Each role's only tools are its schema-validated submit tools. Write the test that enumerates every role's tool list before writing any role.
- All case-file and app content goes into prompts inside the untrusted wrapper. It never becomes system prompt text, a tool name, or an instruction.
- Agents decide no mechanical question. Whether a witness passed or an exploit landed comes only from JudgePort results. A ballot question about a mechanical outcome must be impossible by construction.
- Output that fails schema validation is recorded as inadmissible, not silently retried.
- A high-score candidate with no admissible witness is never dismissed on one attempt: second Defense attempt with a different model and prompt, then human escalation.
- Budgets are charged before a retry, appeals cap at 2, and every stage records tokens, dollars, and wall time. Use the dev API key only through ModelPort; unit tests replay recorded outputs and make no live model calls.
- The structured Verdict is built first; the plain-language summary is generated from it and may contain no number or exhibit id that is not in the Verdict. No em dashes in generated copy.
- Evals report only measured numbers with run ids; otherwise [metric]. Do not claim the jury beats a single reviewer unless both accuracy and inter-juror correlation support it.
- UI: near-black background, off-white type, a single green accent, monospace labels, thin outlined VERIFIED stamp, WCAG AA contrast, keyboard navigation, reduced-motion support, plain-language summary first. Courtroom characters are original; jurors get plain-text nameplates only. Never use or imitate real company logos, mascots, or brand characters, including AI providers.

STOP AND ASK WHEN
- You need a contract change (section 3.4; you may draft the change, but Adrian approves it in a separate PR).
- You need a path outside your scope, an unlisted dependency, or a secret.
- A fake's behavior seems wrong compared with the plan; raise it rather than patching around it.
- Progress would require weakening the safety envelope, a budget cap, or a test.
- You have tried the same approach three times.
Record the blocker in PROGRESS.md before stopping.

END OF SESSION
Report in under 20 lines: tasks completed with PR links, blockers, contract issues opened, any live model spend incurred, and the next task. No em dashes. No invented numbers.
```
