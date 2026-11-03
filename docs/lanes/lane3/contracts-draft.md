# Lane 3 contracts draft (proposal, not merged)

Status: draft for Adrian's review. Follows the change protocol in implementation-plan section 3.4.
Scope: the Trial objects and the ports Lane 3 consumes or provides. Lane 1 and Lane 2 objects are left to the lead's v1.0 and are only referenced here by name.

This is a proposal in prose and Zod-shaped sketches. It is not compiled: Zod is not installed yet (P0-02), and `packages/contracts` is lead-owned, so nothing here touches that package. When approved, the sketches move into `packages/contracts/src/` unchanged apart from imports.

## 1. Open items from section 3.2, with proposals

### 1.1 Stage list

Keep the plan's list. It matches the trial state machine and the order the orchestrator runs:

`intake, map, arraign, defense, prosecution, remedy, verify, jury, verdict, dismissed, escalated`

`dismissed`, `escalated`, and `verdict` are terminal. Legal transitions (the `CaseStore` fake must enforce them):

| From | To |
| --- | --- |
| intake | map |
| map | arraign |
| arraign | defense, dismissed |
| defense | prosecution, dismissed, escalated |
| prosecution | remedy, dismissed, escalated |
| remedy | verify, escalated |
| verify | remedy (appeal, max 2), jury, verdict, escalated |
| jury | verdict, escalated |

Notes:
- `defense` to `dismissed` is legal only below the escalation floor (F3). Above the floor the only exits are `prosecution` or `escalated`. The store should reject the illegal case, not just the orchestrator.
- `verify` to `jury` is only reached when the Judge reports the family flipped and every counterexample failed.
- For the Nov 15 gate the jury is skipped: `verify` to `verdict`. The store must allow that edge when jury is disabled by config.

### 1.2 Severity scale

```ts
Severity = z.enum(['low', 'medium', 'high', 'critical']);
```

"Critical requires unanimity" in plan.md needs a named top value, so four levels is the minimum. Adrian to confirm the names.

### 1.3 TrialEventType list

```ts
TrialEventType = z.enum([
  'stage-entered',
  'stage-exited',
  'exhibit-submitted',
  'exhibit-result',        // Judge result, the only source of pass or fail
  'exhibit-inadmissible',  // schema failure or Judge rejection, with rule
  'objection',             // Prosecution exhibit against a claim
  'appeal',                // Remedy returned with a counterexample
  'ballot-cast',
  'cost-charged',          // budget charged before a retry
  'budget-exhausted',
  'escalated',
  'dismissed',
  'verdict-written',
]);
```

`payload` stays a per-type discriminated union so the web UI and API can parse it without guessing. Each `TrialEvent` carries `seq`, assigned by the store, so SSE can resume from the last `seq` (L3-10).

## 2. Objects Lane 3 produces

### 2.1 Ballot: make mechanical questions impossible by construction

The plan lists `vote` without a type. Proposal: a discriminated union on `question`, so a ballot can only carry a judgment vote, and "did the test pass" has no representation at all.

```ts
const BallotBase = z.object({
  schemaVersion: z.literal(1),
  jurorId: z.string(),
  model: z.string(),
  mandate: z.enum(['security', 'maintainability', 'blast-radius']),
  inputVariant: z.string(),                 // F4: which ordering or raw-results-only view
  confidence: z.number().min(0).max(1),
  citedExhibits: z.array(ExhibitId).min(1), // a ballot with no cited exhibit is invalid
});

Ballot = z.discriminatedUnion('question', [
  BallotBase.extend({ question: z.literal('severity'),            vote: Severity }),
  BallotBase.extend({ question: z.literal('fix-minimality'),      vote: z.enum(['minimal', 'acceptable', 'excessive']) }),
  BallotBase.extend({ question: z.literal('merge-risk'),          vote: z.enum(['low', 'medium', 'high']) }),
  BallotBase.extend({ question: z.literal('evidence-sufficiency'), vote: z.enum(['sufficient', 'insufficient']) }),
]);
```

Change from the plan: `citedExhibits` has `min(1)` and `vote` is typed per question. Both are additive in spirit but tighten a loose field, so treat as a v1.0 decision, not a later change.

### 2.2 Escalation, StageCost, TrialEvent

As in section 3.2 of the implementation plan, with `Escalation.reason` unchanged:
`no-admissible-witness-above-floor | split-jury | budget-exhausted`.

`StageCost` fields are `stage, inputTokens, outputTokens, usd, wallMs, attempt`. Proposal: `usd` is a non-negative number in whole US dollars with a documented rounding rule, and `attempt` starts at 1.

### 2.3 Verdict

```ts
Verdict = z.object({
  schemaVersion: z.literal(1),
  caseId: CaseId,
  outcome: z.enum(['proven-fixed', 'proven-unfixed', 'not-proven', 'dismissed', 'escalated']),
  severity: Severity.optional(),            // absent for dismissed and not-proven
  exhibits: z.array(ExhibitId),
  ballots: z.array(Ballot),
  jurorCorrelation: z.number().min(-1).max(1).optional(),
  summary: z.string(),                      // generated from the fields above, never the reverse
  bundleSha256: z.string().length(64).optional(),
  promptVersions: z.record(z.string(), z.string()),  // see issue A
  modelIds: z.record(z.string(), z.string()),        // see issue A
  cost: z.array(StageCost),
});
```

## 3. Ports

### 3.1 ModelPort (Lane 3 provides, Lane 3 consumes)

```ts
interface ModelPort {
  runTurn(req: {
    promptId: string;
    promptVersion: string;
    model: string;
    system: string;                 // static prompt text only
    user: string;                   // untrusted content, already wrapped
    tools: readonly SubmitToolName[];  // allowlist; no code or network tools exist in the type
    outputSchemaRef: string;
    maxTurns: number;
    budget: { maxInputTokens: number; maxOutputTokens: number; maxUsd: number };
  }): Promise<{
    outcome: 'submitted' | 'no-submission' | 'budget-exhausted' | 'turn-cap';
    submission?: unknown;           // validated by the caller against the contracts schema
    cost: StageCost;
  }>;
}

type SubmitToolName = 'submit_witness' | 'submit_counterexample' | 'submit_patch' | 'submit_ballot';
```

`SubmitToolName` being a closed union is what makes "no shell, no network" a type-level property, and L3-02's enumeration test asserts it at runtime too. The fake replays recorded outputs keyed by `(promptId, promptVersion, input hash)`.

### 3.2 JudgePort, CaseFileSource, CaseStore, EventSink

Lane 2 and Lane 1 own the exact shapes. Lane 3 needs these properties from them:

- `JudgePort.runWitness`, `verifyPatch`, `runCounterexample` return the contract results, and never throw for an inadmissible exhibit (it is a value, `admissible: false`, with `rejectedBy`).
- `CaseStore.transition(caseId, to)` rejects illegal transitions with a typed error, and `CaseStore.chargeBudget(caseId, StageCost)` is called before the retry it pays for. Return the remaining budget.
- `CaseStore.appendVerdict` is append-only.
- `EventSink.emit` is idempotent on `(caseId, seq)`.

## 4. Issues found while drafting (need a decision)

A. `Verdict.promptVersions` and `modelIds` are `Record<Role, string>` in the plan, but a role can have several prompts and models: Defense has a first and a second attempt (F3) on different models, and the jury has three jurors on different prompts. A role-keyed record cannot hold them. Proposal: key by prompt id (`defense`, `defense-second-attempt`, `juror-security`, and so on), which matches `packages/prompts`. This is breaking if v1.0 ships role-keyed, so decide before freeze.

B. `Witness` has no `sha256`, but the `JudgePort` fake is "scripted by fixture: maps `witness.sha256` to a recorded result". `Exhibit` has `sha256`. Proposal: the Judge and fake key on the exhibit that wraps the witness, or `Witness` gains `sha256`. Either way, state it in the contract.

C. `Verdict.severity` is required in the plan's list, but `dismissed`, `escalated`, and `not-proven` outcomes have no severity to give. Proposal: optional, as sketched above.

D. `Role` includes `judge` and `stenographer`, which never author prompts or submissions. That is fine for events (`actor`) but `Verdict` records should not claim a prompt version for them. Resolved by issue A.

E. Budgets: the plan puts per-case token and dollar budgets in Lane 3 but `StageCost` only records spend. Proposal: keep `Budget` as Lane 3 config, not a contract, unless Lane 1 needs to persist it. Say so in the changelog.

## 5. Fixtures this would change

- `fixtures/trials/nodegoat-sqli-001.events.json` and `escalated-001.events.json`: use the `TrialEventType` list and payload union above.
- `fixtures/exhibit-results/`: unaffected.
- All fixtures need `schemaVersion`.
