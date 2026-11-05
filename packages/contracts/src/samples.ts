/**
 * Valid sample objects, as plain JSON, one per registered schema. Used by the round-trip tests and
 * by the fakes and fixtures in packages/testing. Witness code here is a placeholder, never an attack.
 */
const h = (c: string): string => c.repeat(64);
const commit = 'a'.repeat(40);

const candidate = {
  schemaVersion: 1,
  id: 'cand-sqli-001',
  tool: 'semgrep',
  ruleId: 'affidavit.injection.sql-concat',
  cls: 'injection',
  file: 'app/data/allocations-dao.js',
  range: { startLine: 70, endLine: 74 },
  reachability: 'reachable',
  score: 0.92,
  scoreInputs: { reachability: 1, sinkType: 0.9, noAuthOnPath: 1, toolAgreement: 0.5 },
  toolAgreement: 1,
};

const bootHints = {
  kind: 'compose',
  path: 'docker-compose.yml',
  service: 'web',
  ports: [4000],
  healthRoute: '/login',
  healthTimeoutMs: 60000,
  stubs: [],
  env: { NODE_ENV: 'synthetic' },
};

const caseFile = {
  schemaVersion: 1,
  id: 'case-nodegoat-sqli-001',
  tenantId: 'tenant-dev',
  target: { repo: 'repo-nodegoat', commit, variant: 'vulnerable' },
  candidate,
  slices: [
    {
      file: 'app/data/allocations-dao.js',
      range: { startLine: 60, endLine: 80 },
      code: '/* slice recorded from run [id] */',
      strippedComments: true,
      untrusted: true,
    },
  ],
  route: {
    method: 'GET',
    path: '/allocations/:userId',
    handlerFile: 'app/routes/allocations.js',
    middleware: ['isLoggedIn'],
    authRequired: true,
  },
  bootHints,
  redactions: [
    {
      file: 'config/env.js',
      startLine: 4,
      endLine: 4,
      kind: 'generic-api-key',
      placeholder: '[REDACTED:1]',
    },
  ],
  escalationFloor: 0.7,
  safeVariant: { repo: 'repo-nodegoat', commit: 'b'.repeat(40), variant: 'safe' },
};

const witness = {
  schemaVersion: 1,
  id: 'witness-sqli-001',
  caseId: 'case-nodegoat-sqli-001',
  cls: 'injection',
  template: '/* witness body recorded from run [id] */',
  params: [{ name: 'threshold', values: [1, 2, 3] }],
  author: 'defense',
  sha256: h('1'),
};

const run = {
  variant: 'vulnerable',
  attempt: 1,
  exitCode: 0,
  passed: true,
  durationMs: 812,
  stdoutSha256: h('2'),
  stderrSha256: h('3'),
};

const exhibitResult = {
  schemaVersion: 1,
  exhibitId: 'exhibit-witness-001',
  admissible: true,
  runs: [run, { ...run, attempt: 2 }, { ...run, attempt: 3 }],
  vulnPass: true,
  safeVariantFail: true,
  egressAttempts: 0,
  familyResults: [
    { paramIndex: 0, passed: true },
    { paramIndex: 1, passed: true },
    { paramIndex: 2, passed: true },
  ],
  passed: true,
  durationMs: 2600,
};

const ballot = {
  schemaVersion: 1,
  jurorId: 'juror-security',
  model: 'model-id-placeholder',
  mandate: 'security',
  inputVariant: 'raw-results-only',
  confidence: 0.8,
  citedExhibits: ['exhibit-witness-001'],
  question: 'severity',
  vote: 'high',
};

const escalation = {
  schemaVersion: 1,
  caseId: 'case-nodegoat-sqli-001',
  reason: 'no-admissible-witness-above-floor',
  detail: 'second Defense attempt produced no admissible witness',
};

const verdict = {
  schemaVersion: 1,
  caseId: 'case-nodegoat-sqli-001',
  outcome: 'proven-fixed',
  severity: 'high',
  exhibits: ['exhibit-witness-001', 'exhibit-patch-001'],
  ballots: [ballot],
  summary: 'Summary generated from the structured verdict.',
  promptVersions: { defense: 'v1', remedy: 'v1' },
  modelIds: { defense: 'model-id-placeholder', remedy: 'model-id-placeholder' },
  cost: [{ stage: 'defense', inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 0, attempt: 1 }],
};

export const samples: Readonly<Record<string, unknown>> = {
  TargetRef: caseFile.target,
  BootHints: bootHints,
  Candidate: candidate,
  Slice: caseFile.slices[0],
  RouteInfo: caseFile.route,
  CaseFile: caseFile,
  Dismissal: {
    schemaVersion: 1,
    candidateId: 'cand-sqli-002',
    reason: 'unreachable',
    detail: 'no route reaches the sink',
  },
  Witness: witness,
  Exhibit: {
    schemaVersion: 1,
    id: 'exhibit-patch-001',
    caseId: 'case-nodegoat-sqli-001',
    author: 'remedy',
    code: '/* patch recorded from run [id] */',
    sha256: h('4'),
    kind: 'patch',
    diff: '--- a/app/data/allocations-dao.js\n+++ b/app/data/allocations-dao.js\n',
    filesTouched: ['app/data/allocations-dao.js'],
    linesChanged: 3,
  },
  RunRecord: run,
  ExhibitResult: exhibitResult,
  VerifyResult: {
    schemaVersion: 1,
    patchExhibitId: 'exhibit-patch-001',
    familyFlipped: true,
    suitePassed: true,
    rescanClean: true,
    counterexamples: [{ exhibitId: 'exhibit-counter-001', survived: false }],
  },
  BundleManifest: {
    schemaVersion: 1,
    caseId: 'case-nodegoat-sqli-001',
    createdAt: '2026-11-05T12:00:00.000Z',
    targetDigests: { vulnerable: `sha256:${h('5')}`, safe: `sha256:${h('6')}` },
    exhibits: [{ id: 'exhibit-witness-001', sha256: h('1'), path: 'exhibits/witness-001.json' }],
    results: ['exhibit-witness-001'],
    verdictSha256: h('7'),
    toolVersions: { semgrep: '[tool-version]' },
  },
  Attestation: {
    schemaVersion: 1,
    statement: {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'bundle', digest: { sha256: h('8') } }],
      predicateType: 'https://affidavit.dev/verdict/v1',
      predicate: { caseId: 'case-nodegoat-sqli-001' },
    },
    signature: 'test-signature',
    keyId: 'test-key',
  },
  Ballot: ballot,
  Verdict: verdict,
  Escalation: escalation,
  TrialEvent: {
    schemaVersion: 1,
    caseId: 'case-nodegoat-sqli-001',
    seq: 0,
    stage: 'intake',
    at: '2026-11-05T12:00:00.000Z',
    actor: 'stenographer',
    type: 'stage-entered',
    payload: {},
  },
  CreateCaseRequest: { repoUrl: 'https://example.test/nodegoat.git', commit },
  CreateCaseResponse: { schemaVersion: 1, caseId: 'case-nodegoat-sqli-001', stage: 'intake' },
  GetCaseResponse: { schemaVersion: 1, caseId: 'case-nodegoat-sqli-001', stage: 'intake' },
  GetBundleResponse: {
    schemaVersion: 1,
    sha256: h('9'),
    url: 'https://bundles.example.test/signed',
    expiresAt: '2026-11-05T12:15:00.000Z',
  },
  GithubWebhookRequest: { event: 'pull_request', deliveryId: 'delivery-1', payload: {} },
};
