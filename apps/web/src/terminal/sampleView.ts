import type { CaseStage, Role, TargetVariant, TrialEventType } from '@affidavit/contracts';
import type {
  Bubble,
  CostRow,
  DiffLine,
  RunCell,
  StageCell,
  TapeRow,
  TerminalView,
  Tone,
} from './types.js';

// Hand-built terminal views for tests and visual work. These are not recorded trials: every
// number here is sample data for layout, and none of it may be quoted as a result.

const STAGE_ORDER: CaseStage[] = [
  'intake',
  'map',
  'arraign',
  'defense',
  'prosecution',
  'remedy',
  'verify',
  'jury',
  'verdict',
  'dismissed',
  'escalated',
];

function stages(
  active: CaseStage,
  done: readonly CaseStage[],
  charged: Partial<Record<CaseStage, { attempts: number; wallMs: number }>> = {},
): StageCell[] {
  return STAGE_ORDER.map((stage) => {
    const state = stage === active ? 'active' : done.includes(stage) ? 'done' : 'pending';
    const cell: StageCell = { stage, state, attempts: charged[stage]?.attempts ?? 0 };
    const wallMs = charged[stage]?.wallMs;
    if (wallMs !== undefined) cell.wallMs = wallMs;
    const next = done.includes(stage) ? STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1] : undefined;
    if (next !== undefined && (done.includes(next) || next === active)) cell.exitedTo = next;
    return cell;
  });
}

function sha(seed: string): string {
  return (seed.repeat(64) + '0'.repeat(64)).slice(0, 64);
}

function runs(variant: TargetVariant, passed: boolean, baseMs: number): RunCell[] {
  return [1, 2, 3].map((attempt) => ({
    variant,
    attempt,
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: baseMs + attempt * 17,
    stdoutSha256: sha(`${variant.length}${attempt}a`),
    stderrSha256: sha(`${attempt}${variant.length}e`),
  }));
}

function tape(
  rows: readonly [CaseStage, Role, TrialEventType, string, Tone?][],
  startSeq = 0,
): TapeRow[] {
  return rows.map(([stage, actor, type, text, tone], i) => ({
    seq: startSeq + i,
    at: `2026-11-05T12:00:${String(i).padStart(2, '0')}.${String((i * 137) % 1000).padStart(3, '0')}Z`,
    stage,
    actor,
    type,
    text,
    tone: tone ?? 'neutral',
  }));
}

const W = 'exhibit-witness-001';
const CX = 'exhibit-counterexample-001';
const P = 'exhibit-patch-001';

const DIFF_LINES: DiffLine[] = [
  { kind: 'file', text: 'app/data/user-dao.js' },
  { kind: 'hunk', text: '@@ -41,9 +41,11 @@ function UserDAO(db) {' },
  {
    kind: 'ctx',
    oldNo: 41,
    newNo: 41,
    text: '  this.getUserByUserName = (userName, callback) => {',
  },
  { kind: 'ctx', oldNo: 42, newNo: 42, text: '    const users = db.collection("users");' },
  { kind: 'del', oldNo: 43, text: '    const query = "SELECT * FROM users WHERE name = \'" +' },
  { kind: 'del', oldNo: 44, text: '      userName + "\'";' },
  { kind: 'del', oldNo: 45, text: '    users.query(query, callback);' },
  { kind: 'add', newNo: 43, text: '    if (typeof userName !== "string") {' },
  { kind: 'add', newNo: 44, text: '      return callback(new Error("invalid user name"));' },
  { kind: 'add', newNo: 45, text: '    }' },
  { kind: 'add', newNo: 46, text: '    const query = "SELECT * FROM users WHERE name = ?";' },
  { kind: 'add', newNo: 47, text: '    users.query(query, [userName], callback);' },
  { kind: 'ctx', oldNo: 46, newNo: 48, text: '  };' },
  { kind: 'ctx', oldNo: 47, newNo: 49, text: '' },
  { kind: 'file', text: 'test/data/user-dao.test.js' },
  { kind: 'hunk', text: '@@ -12,3 +12,7 @@ describe("UserDAO", () => {' },
  { kind: 'ctx', oldNo: 12, newNo: 12, text: '  it("finds a user by name", async () => {' },
  { kind: 'del', oldNo: 13, text: '    expect(await find("ada")).toBeTruthy();' },
  { kind: 'add', newNo: 13, text: '    expect(await find("ada")).toMatchObject({ name: "ada" });' },
  { kind: 'add', newNo: 14, text: '  });' },
  { kind: 'add', newNo: 15, text: '  it("treats a quote in the name as data", async () => {' },
  { kind: 'add', newNo: 16, text: "    expect(await find(\"x' OR '1'='1\")).toBeNull();" },
  { kind: 'ctx', oldNo: 14, newNo: 17, text: '  });' },
];

const VERIFIED_COST: CostRow[] = [
  { stage: 'arraign', attempt: 1, inputTokens: 4210, outputTokens: 380, usd: 0.0181, wallMs: 3120 },
  {
    stage: 'defense',
    attempt: 1,
    inputTokens: 18340,
    outputTokens: 2210,
    usd: 0.0882,
    wallMs: 21480,
  },
  {
    stage: 'prosecution',
    attempt: 1,
    inputTokens: 15120,
    outputTokens: 1764,
    usd: 0.0718,
    wallMs: 17210,
  },
  {
    stage: 'remedy',
    attempt: 1,
    inputTokens: 21980,
    outputTokens: 3105,
    usd: 0.1125,
    wallMs: 26890,
  },
  { stage: 'verify', attempt: 1, inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 41230 },
  { stage: 'jury', attempt: 1, inputTokens: 27450, outputTokens: 1290, usd: 0.1017, wallMs: 12760 },
];

function totals(rows: readonly CostRow[]) {
  return rows.reduce(
    (t, r) => ({
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      usd: t.usd + r.usd,
      wallMs: t.wallMs + r.wallMs,
    }),
    { inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 0 },
  );
}

const VERIFIED_BUBBLES: Bubble[] = [
  {
    id: 'b-arraign',
    agent: 'stenographer',
    anchor: 'stages',
    tone: 'neutral',
    title: 'Arraigned above the floor',
    body: 'The candidate scored above the escalation floor, so it cannot be dismissed without an admissible witness or a human look.',
    cites: [],
    seq: 4,
  },
  {
    id: 'b-witness',
    agent: 'defense',
    anchor: 'evidence',
    tone: 'neutral',
    title: 'Witness filed',
    body: 'Defense submitted a witness test for the Judge to run. Defense never runs code itself.',
    cites: [W],
    seq: 6,
  },
  {
    id: 'b-admit',
    agent: 'judge',
    anchor: 'evidence',
    tone: 'pos',
    title: 'Witness admitted',
    body: 'Passed 3 of 3 on the vulnerable code and failed on the known-safe variant. The proof is differential.',
    cites: [W],
    seq: 7,
  },
  {
    id: 'b-objection',
    agent: 'prosecution',
    anchor: 'arguments',
    tone: 'warn',
    title: 'Objection to the witness',
    body: 'Prosecution argues the witness only covers one input shape.',
    quote:
      'The witness pins a single quote payload. A numeric id path reaches the same sink and is not exercised.',
    cites: [W],
    seq: 9,
  },
  {
    id: 'b-counter',
    agent: 'prosecution',
    anchor: 'arguments',
    tone: 'neg',
    title: 'Counterexample filed',
    body: 'A second input that reaches the same query. The Judge admitted it, so the patch must defeat it too.',
    cites: [CX],
    seq: 10,
  },
  {
    id: 'b-patch',
    agent: 'remedy',
    anchor: 'diff',
    tone: 'neutral',
    title: 'Patch submitted',
    body: 'Two files touched. The query is parameterized and the input type is checked before use.',
    cites: [P],
    seq: 13,
  },
  {
    id: 'b-verify',
    agent: 'judge',
    anchor: 'verify',
    tone: 'pos',
    title: 'Patch check passed',
    body: 'The witness family flipped to fail, the suite passed, the rescan is clean and the counterexample no longer works.',
    cites: [P, W, CX],
    seq: 15,
  },
  {
    id: 'b-juror-sec',
    agent: 'juror',
    agentDetail: 'security',
    anchor: 'jury',
    tone: 'neutral',
    title: 'Voted high on severity',
    body: 'Cites the admitted witness and the counterexample.',
    cites: [W, CX],
    seq: 17,
  },
  {
    id: 'b-juror-maint',
    agent: 'juror',
    agentDetail: 'maintainability',
    anchor: 'jury',
    tone: 'neutral',
    title: 'Voted minimal on fix minimality',
    body: 'Cites the patch exhibit.',
    cites: [P],
    seq: 18,
  },
  {
    id: 'b-juror-blast',
    agent: 'juror',
    agentDetail: 'blast-radius',
    anchor: 'jury',
    tone: 'neutral',
    title: 'Voted low on merge risk',
    body: 'Cites the patch exhibit and the Judge check.',
    cites: [P],
    seq: 19,
  },
  {
    id: 'b-verdict',
    agent: 'stenographer',
    anchor: 'verdict',
    tone: 'pos',
    title: 'Verdict written: proven and fixed',
    body: 'Written from the structured record. The VERIFIED stamp rests on the Judge check, not on this text.',
    cites: [W, P],
    seq: 21,
  },
];

export const SAMPLE_VERIFIED: TerminalView = {
  caseId: 'case-nodegoat-sqli-001',
  status: 'verified',
  verified: true,
  awaitingVerification: false,
  eventCount: 22,
  lastSeq: 21,
  stages: stages(
    'verdict',
    ['intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify', 'jury'],
    {
      arraign: { attempts: 1, wallMs: 3120 },
      defense: { attempts: 1, wallMs: 21480 },
      prosecution: { attempts: 1, wallMs: 17210 },
      remedy: { attempts: 1, wallMs: 26890 },
      verify: { attempts: 1, wallMs: 41230 },
      jury: { attempts: 1, wallMs: 12760 },
    },
  ),
  evidence: [
    {
      id: W,
      kind: 'witness',
      author: 'defense',
      state: 'admitted',
      runs: [...runs('vulnerable', true, 400), ...runs('safe', false, 380)],
      vulnPass: true,
      safeVariantFail: true,
      egressAttempts: 0,
      family: [true, true, true, true, true],
      durationMs: 2418,
    },
    {
      id: CX,
      kind: 'counterexample',
      author: 'prosecution',
      state: 'admitted',
      runs: [
        ...runs('vulnerable', true, 420),
        ...runs('safe', false, 390),
        ...runs('patched', false, 410),
      ],
      vulnPass: true,
      safeVariantFail: true,
      egressAttempts: 0,
      family: [true, true, true],
      durationMs: 3672,
    },
    {
      id: P,
      kind: 'patch',
      author: 'remedy',
      state: 'admitted',
      runs: runs('patched', false, 395),
      durationMs: 1236,
    },
  ],
  verify: [
    {
      seq: 15,
      patchExhibitId: P,
      counts: true,
      accepted: true,
      checks: [
        { check: 'family-flipped', ok: true },
        { check: 'suite-passed', ok: true },
        { check: 'rescan-clean', ok: true },
        { check: 'counterexamples', ok: true },
      ],
      counterexamples: [{ exhibitId: CX, survived: false }],
    },
  ],
  diff: {
    exhibitId: P,
    filesTouched: ['app/data/user-dao.js', 'test/data/user-dao.test.js'],
    linesChanged: 13,
    added: 9,
    removed: 4,
    lines: DIFF_LINES,
  },
  cost: {
    rows: VERIFIED_COST,
    total: totals(VERIFIED_COST),
    remaining: { inputTokens: 112900, outputTokens: 21251, usd: 1.6077, exhausted: false },
  },
  ballots: [
    {
      seq: 17,
      jurorId: 'juror-security-1',
      mandate: 'security',
      model: 'sample-model-a',
      question: 'severity',
      vote: 'high',
      confidence: 0.86,
      citedExhibits: [W, CX],
      inputVariant: 'ordering-a',
    },
    {
      seq: 18,
      jurorId: 'juror-maintainability-1',
      mandate: 'maintainability',
      model: 'sample-model-b',
      question: 'fix-minimality',
      vote: 'minimal',
      confidence: 0.74,
      citedExhibits: [P],
      inputVariant: 'ordering-b',
    },
    {
      seq: 19,
      jurorId: 'juror-blast-radius-1',
      mandate: 'blast-radius',
      model: 'sample-model-c',
      question: 'merge-risk',
      vote: 'low',
      confidence: 0.69,
      citedExhibits: [P],
      inputVariant: 'raw-results-only',
    },
  ],
  tape: tape([
    ['intake', 'stenographer', 'stage-entered', 'Entered intake'],
    ['intake', 'stenographer', 'stage-exited', 'Left intake for map'],
    ['map', 'stenographer', 'stage-entered', 'Entered map'],
    ['map', 'stenographer', 'stage-exited', 'Left map for arraign'],
    ['arraign', 'stenographer', 'stage-entered', 'Entered arraign'],
    ['defense', 'stenographer', 'stage-entered', 'Entered defense'],
    ['defense', 'defense', 'exhibit-submitted', `Witness ${W} submitted`],
    ['defense', 'judge', 'exhibit-result', `Judge admitted ${W}`, 'pos'],
    ['prosecution', 'stenographer', 'stage-entered', 'Entered prosecution'],
    ['prosecution', 'prosecution', 'objection', `Objection raised against ${W}`, 'warn'],
    ['prosecution', 'prosecution', 'exhibit-submitted', `Counterexample ${CX} submitted`],
    ['prosecution', 'judge', 'exhibit-result', `Judge admitted ${CX}`, 'pos'],
    ['remedy', 'stenographer', 'stage-entered', 'Entered remedy'],
    ['remedy', 'remedy', 'exhibit-submitted', `Patch ${P} submitted`],
    ['verify', 'stenographer', 'stage-entered', 'Entered verify'],
    ['verify', 'judge', 'verify-result', `Judge accepted ${P}`, 'pos'],
    ['jury', 'stenographer', 'stage-entered', 'Entered jury'],
    ['jury', 'juror', 'ballot-cast', 'Ballot cast on severity: high'],
    ['jury', 'juror', 'ballot-cast', 'Ballot cast on fix-minimality: minimal'],
    ['jury', 'juror', 'ballot-cast', 'Ballot cast on merge-risk: low'],
    ['verdict', 'stenographer', 'stage-entered', 'Entered verdict'],
    ['verdict', 'stenographer', 'verdict-written', 'Verdict written: proven-fixed', 'pos'],
  ]),
  bubbles: VERIFIED_BUBBLES,
  verdict: {
    outcome: 'proven-fixed',
    severity: 'high',
    bundleSha256: sha('9f3c1ab47e'),
    models: [
      { prompt: 'defense', model: 'sample-model-a', version: 'v3' },
      { prompt: 'prosecution', model: 'sample-model-b', version: 'v2' },
      { prompt: 'remedy', model: 'sample-model-a', version: 'v4' },
      { prompt: 'juror-security', model: 'sample-model-a', version: 'v1' },
      { prompt: 'juror-maintainability', model: 'sample-model-b', version: 'v1' },
      { prompt: 'juror-blast-radius', model: 'sample-model-c', version: 'v1' },
    ],
    jurorCorrelation: 0.31,
    exhibits: [W, CX, P],
  },
};

const MID_COST = VERIFIED_COST.slice(0, 3);

/** Mid-trial: Remedy has filed a patch, nothing is ruled on it, no content was served. */
export const SAMPLE_MID_TRIAL: TerminalView = {
  caseId: 'case-nodegoat-sqli-001',
  status: 'in-progress',
  verified: false,
  awaitingVerification: false,
  eventCount: 14,
  lastSeq: 13,
  stages: stages('remedy', ['intake', 'map', 'arraign', 'defense', 'prosecution'], {
    arraign: { attempts: 1, wallMs: 3120 },
    defense: { attempts: 1, wallMs: 21480 },
    prosecution: { attempts: 1, wallMs: 17210 },
  }),
  evidence: [
    ...SAMPLE_VERIFIED.evidence.slice(0, 1),
    {
      id: CX,
      kind: 'counterexample',
      author: 'prosecution',
      state: 'admitted',
      runs: [...runs('vulnerable', true, 420), ...runs('safe', false, 390)],
      vulnPass: true,
      safeVariantFail: true,
      egressAttempts: 0,
      family: [true, true, true],
      durationMs: 2436,
    },
    { id: P, kind: 'patch', author: 'remedy', state: 'pending', runs: [] },
  ],
  verify: [],
  diff: undefined,
  cost: {
    rows: MID_COST,
    total: totals(MID_COST),
    remaining: { inputTokens: 162330, outputTokens: 25646, usd: 1.8219, exhausted: false },
  },
  ballots: [],
  tape: SAMPLE_VERIFIED.tape.slice(0, 14),
  bubbles: VERIFIED_BUBBLES.filter((b) => b.seq <= 13),
  verdict: undefined,
};

const FAILED_COST: CostRow[] = [
  ...VERIFIED_COST.slice(0, 1),
  {
    stage: 'defense',
    attempt: 1,
    inputTokens: 18340,
    outputTokens: 2210,
    usd: 0.0882,
    wallMs: 21480,
  },
  {
    stage: 'defense',
    attempt: 2,
    inputTokens: 19870,
    outputTokens: 2544,
    usd: 0.0977,
    wallMs: 24010,
  },
  ...VERIFIED_COST.slice(2, 5),
];

const W1 = 'exhibit-witness-001';
const W2 = 'exhibit-witness-002';

/** A trial that went badly: a rejected witness, a failed patch check and a check that does not count. */
export const SAMPLE_FAILED: TerminalView = {
  caseId: 'case-juice-shop-idor-004',
  status: 'unfixed',
  verified: false,
  awaitingVerification: false,
  eventCount: 24,
  lastSeq: 23,
  stages: stages(
    'verdict',
    ['intake', 'map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'],
    {
      arraign: { attempts: 1, wallMs: 3120 },
      defense: { attempts: 2, wallMs: 45490 },
      prosecution: { attempts: 1, wallMs: 17210 },
      remedy: { attempts: 1, wallMs: 26890 },
      verify: { attempts: 1, wallMs: 41230 },
    },
  ),
  evidence: [
    {
      id: W1,
      kind: 'witness',
      author: 'defense',
      state: 'rejected',
      rejectedBy: 'stable-3of3',
      runs: [
        ...runs('vulnerable', true, 400).map((r) =>
          r.attempt === 2 ? { ...r, passed: false, exitCode: 1 } : r,
        ),
        ...runs('safe', false, 380),
      ],
      vulnPass: false,
      safeVariantFail: true,
      egressAttempts: 0,
      family: [true, false, true],
      durationMs: 2391,
    },
    {
      id: W2,
      kind: 'witness',
      author: 'defense',
      state: 'admitted',
      runs: runs('vulnerable', true, 405),
      vulnPass: true,
      egressAttempts: 0,
      family: [true, true, true],
      durationMs: 1266,
    },
    {
      id: CX,
      kind: 'counterexample',
      author: 'prosecution',
      state: 'admitted',
      runs: [...runs('vulnerable', true, 420), ...runs('patched', true, 410)],
      vulnPass: true,
      egressAttempts: 0,
      durationMs: 2544,
    },
    {
      id: P,
      kind: 'patch',
      author: 'remedy',
      state: 'rejected',
      rejectedBy: 'counterexample-survives',
      runs: runs('patched', false, 395),
      durationMs: 1236,
    },
  ],
  verify: [
    {
      seq: 17,
      patchExhibitId: P,
      counts: true,
      accepted: false,
      checks: [
        { check: 'family-flipped', ok: true },
        { check: 'suite-passed', ok: true },
        { check: 'rescan-clean', ok: true },
        { check: 'counterexamples', ok: false },
      ],
      counterexamples: [{ exhibitId: CX, survived: true }],
      rejectedBy: 'counterexample-survives',
    },
    {
      seq: 23,
      patchExhibitId: P,
      counts: false,
      accepted: false,
      checks: [
        { check: 'family-flipped', ok: true },
        { check: 'suite-passed', ok: true },
        { check: 'rescan-clean', ok: true },
        { check: 'counterexamples', ok: true },
      ],
      counterexamples: [{ exhibitId: CX, survived: false }],
    },
  ],
  diff: {
    exhibitId: P,
    filesTouched: ['routes/basket.ts'],
    linesChanged: 3,
    added: 2,
    removed: 1,
    lines: [
      { kind: 'file', text: 'routes/basket.ts' },
      { kind: 'hunk', text: '@@ -18,5 +18,6 @@ export function retrieveBasket() {' },
      { kind: 'ctx', oldNo: 18, newNo: 18, text: '    const id = req.params.id;' },
      {
        kind: 'del',
        oldNo: 19,
        text: '    const basket = await BasketModel.findOne({ where: { id } });',
      },
      { kind: 'add', newNo: 19, text: '    const owner = security.authenticatedUsers.from(req);' },
      {
        kind: 'add',
        newNo: 20,
        text: '    const basket = await BasketModel.findOne({ where: { id } });',
      },
      { kind: 'ctx', oldNo: 20, newNo: 21, text: '    res.json(utils.queryResultToJson(basket));' },
    ],
  },
  cost: {
    rows: FAILED_COST,
    total: totals(FAILED_COST),
    remaining: { inputTokens: 0, outputTokens: 12480, usd: 0.4412, exhausted: true },
  },
  ballots: [],
  tape: tape([
    ['intake', 'stenographer', 'stage-entered', 'Entered intake'],
    ['map', 'stenographer', 'stage-entered', 'Entered map'],
    ['arraign', 'stenographer', 'stage-entered', 'Entered arraign'],
    ['defense', 'stenographer', 'stage-entered', 'Entered defense'],
    ['defense', 'defense', 'exhibit-submitted', `Witness ${W1} submitted`],
    ['defense', 'judge', 'exhibit-inadmissible', `Judge rejected ${W1}: stable-3of3`, 'neg'],
    ['defense', 'defense', 'exhibit-submitted', `Witness ${W2} submitted`],
    ['defense', 'judge', 'exhibit-result', `Judge admitted ${W2}`, 'pos'],
    ['prosecution', 'prosecution', 'exhibit-submitted', `Counterexample ${CX} submitted`],
    ['prosecution', 'judge', 'exhibit-result', `Judge admitted ${CX}`, 'pos'],
    ['remedy', 'remedy', 'exhibit-submitted', `Patch ${P} submitted`],
    ['verify', 'judge', 'verify-result', `Judge did not accept ${P}`, 'neg'],
    [
      'verify',
      'judge',
      'exhibit-inadmissible',
      `Judge rejected ${P}: counterexample-survives`,
      'neg',
    ],
    ['verify', 'stenographer', 'budget-exhausted', 'Budget exhausted', 'warn'],
    ['verdict', 'stenographer', 'verdict-written', 'Verdict written: proven-unfixed', 'neg'],
    ['verify', 'remedy', 'verify-result', `Check recorded for ${P} after the verdict`, 'warn'],
  ]),
  bubbles: [
    {
      id: 'f-reject',
      agent: 'judge',
      anchor: 'evidence',
      tone: 'neg',
      title: 'Witness rejected',
      body: 'The test did not give the same result on all three repeat runs.',
      cites: [W1],
      seq: 5,
    },
    {
      id: 'f-second',
      agent: 'defense',
      anchor: 'evidence',
      tone: 'neutral',
      title: 'Second attempt filed',
      body: 'A rejected witness on a high-score candidate is never dropped quietly. Defense tried again.',
      cites: [W2],
      seq: 6,
    },
    {
      id: 'f-nosafe',
      agent: 'judge',
      anchor: 'evidence',
      tone: 'warn',
      title: 'No safe variant to compare',
      body: 'Admitted on repeatable passes against the vulnerable code only. There is no known-safe variant in the corpus for this case.',
      cites: [W2],
      seq: 7,
    },
    {
      id: 'f-survives',
      agent: 'prosecution',
      anchor: 'arguments',
      tone: 'neg',
      title: 'Counterexample survives the patch',
      body: 'The counterexample still passes against the patched code.',
      quote: 'Basket 2 is still readable with the token for user 1 after the patch is applied.',
      cites: [CX, P],
      seq: 11,
    },
    {
      id: 'f-verify',
      agent: 'judge',
      anchor: 'verify',
      tone: 'neg',
      title: 'Patch check failed',
      body: 'A counterexample still worked against the patched code.',
      cites: [P, CX],
      seq: 11,
    },
    {
      id: 'f-late',
      agent: 'remedy',
      anchor: 'verify',
      tone: 'warn',
      title: 'Late check does not count',
      body: 'A passing check was recorded after the verdict by an actor other than the Judge. It changes nothing.',
      cites: [P],
      seq: 15,
    },
    {
      id: 'f-budget',
      agent: 'stenographer',
      anchor: 'cost',
      tone: 'warn',
      title: 'Budget exhausted',
      body: 'The input token budget ran out, so there was no appeal round.',
      cites: [],
      seq: 13,
    },
    {
      id: 'f-verdict',
      agent: 'stenographer',
      anchor: 'verdict',
      tone: 'neg',
      title: 'Verdict written: proven, not fixed',
      body: 'The flaw is proven by an admitted witness. No patch passed the Judge check.',
      cites: [W2],
      seq: 14,
    },
  ],
  verdict: {
    outcome: 'proven-unfixed',
    severity: 'medium',
    models: [
      { prompt: 'defense', model: 'sample-model-a', version: 'v3' },
      { prompt: 'defense-second-attempt', model: 'sample-model-b' },
      { prompt: 'prosecution', version: 'v2' },
      { prompt: 'remedy', model: 'sample-model-a', version: 'v4' },
    ],
    exhibits: [W2, CX],
  },
};

/** Nothing recorded yet. */
export const SAMPLE_EMPTY: TerminalView = {
  caseId: 'case-pending-000',
  status: 'in-progress',
  verified: false,
  awaitingVerification: false,
  eventCount: 0,
  lastSeq: 0,
  stages: stages('intake', []).map((s) => ({ ...s, state: 'pending' as const })),
  evidence: [],
  verify: [],
  diff: undefined,
  cost: { rows: [], total: { inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 0 } },
  ballots: [],
  tape: [],
  bubbles: [],
  verdict: undefined,
};

export const SAMPLES = {
  verified: SAMPLE_VERIFIED,
  'mid-trial': SAMPLE_MID_TRIAL,
  failed: SAMPLE_FAILED,
  empty: SAMPLE_EMPTY,
} as const;
