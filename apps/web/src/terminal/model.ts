import {
  CaseStage,
  MAX_APPEALS,
  PromptId,
  TERMINAL_STAGES,
  type Ballot,
  type Exhibit,
  type ExhibitResult,
  type PatchExhibit,
  type Role,
  type TrialEvent,
  type Verdict,
  type VerifyResult,
} from '@affidavit/contracts';
import { RULE_TEXT, REVIEW_REASON } from '../app/status.js';
import {
  buildCaseView,
  counterexamplesComplete,
  isAccepted,
  isJudgeVerify,
  recordedEvents,
  type CaseView,
} from '../model/caseView.js';
import { parseUnifiedDiff } from './diff.js';
import type {
  BallotRow,
  Bubble,
  CostRow,
  CostView,
  DiffView,
  EvidenceRow,
  RunCell,
  StageCell,
  TapeRow,
  Tone,
  TerminalView,
  VerdictView,
  VerifyRow,
} from './types.js';

/** Longest recorded quote a bubble carries, in characters. */
export const MAX_QUOTE_LENGTH = 280;
const MAX_FILES = 200;
const MAX_FILE_NAME = 500;

type Of<T extends TrialEvent['type']> = Extract<TrialEvent, { type: T }>;

// Static wording only. Nothing here is built from recorded free text.

const ROLE_NAME: Record<Role, string> = {
  defense: 'The Defense',
  prosecution: 'The Prosecution',
  remedy: 'Remedy',
  juror: 'A juror',
  judge: 'The Judge',
  stenographer: 'The stenographer',
};

const STAGE_NAME: Record<CaseStage, string> = {
  intake: 'intake',
  map: 'map',
  arraign: 'arraignment',
  defense: 'defense',
  prosecution: 'prosecution',
  remedy: 'remedy',
  verify: 'verify',
  jury: 'jury',
  verdict: 'verdict',
  dismissed: 'dismissed',
  escalated: 'escalated',
};

const STAGE_TITLE: Partial<Record<CaseStage, string>> = {
  intake: 'Intake finished',
  map: 'Map finished',
  arraign: 'Arraignment finished',
};

const STAGE_BODY: Partial<Record<CaseStage, string>> = {
  intake: 'The case file was taken in and recorded.',
  map: 'The routes and code slices for the candidate were mapped.',
  arraign: 'The candidate was arraigned and sent on for trial.',
};

const KIND_NAME: Record<EvidenceRow['kind'], string> = {
  witness: 'Witness',
  counterexample: 'Counterexample',
  patch: 'Patch',
};

const QUESTION_TITLE: Record<Ballot['question'], string> = {
  severity: 'Severity vote',
  'fix-minimality': 'Fix minimality vote',
  'merge-risk': 'Merge risk vote',
  'evidence-sufficiency': 'Evidence sufficiency vote',
};

const QUESTION_NAME: Record<Ballot['question'], string> = {
  severity: 'severity',
  'fix-minimality': 'how minimal the fix is',
  'merge-risk': 'the risk of merging the fix',
  'evidence-sufficiency': 'whether the evidence is sufficient',
};

const DISMISS_TEXT: Record<Of<'dismissed'>['payload']['dismissal']['reason'], string> = {
  unreachable: 'No route in the app reaches the flagged code.',
  'negative-control': 'The candidate matched a known-safe control, not a weakness.',
  'below-threshold': 'The candidate scored below the threshold for a trial.',
  'osv-no-path': 'The advisory has no path from the app to the affected code.',
  'no-admissible-witness-below-floor':
    'No admissible witness was produced and the candidate scored below the escalation floor.',
};

const OUTCOME_TITLE: Record<Verdict['outcome'], string> = {
  'proven-fixed': 'Verdict: proven and fixed',
  'proven-unfixed': 'Verdict: proven, not fixed',
  'not-proven': 'Verdict: not proven',
  dismissed: 'Verdict: dismissed',
  escalated: 'Verdict: escalated',
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Cuts recorded text to the quote cap by code point, so no character is split in half. */
function quote(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_QUOTE_LENGTH
    ? text
    : `${chars.slice(0, MAX_QUOTE_LENGTH - 1).join('')}…`;
}

function runCell(r: ExhibitResult['runs'][number]): RunCell {
  return {
    variant: r.variant,
    attempt: r.attempt,
    passed: r.passed,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    stdoutSha256: r.stdoutSha256,
    stderrSha256: r.stderrSha256,
  };
}

interface Context {
  events: TrialEvent[];
  view: CaseView;
  kindOf: Map<string, EvidenceRow['kind']>;
  /** Judge result events for each exhibit id, latest last. */
  results: Map<string, ExhibitResult>;
  verifyRows: Map<TrialEvent, VerifyRow>;
  patchContent: Map<string, PatchExhibit>;
}

function buildStages(events: readonly TrialEvent[], finished: boolean): StageCell[] {
  const seen = new Set<CaseStage>();
  const exited = new Map<CaseStage, CaseStage>();
  const costs = new Map<CaseStage, { attempts: Set<number>; wallMs: number }>();
  const reachedTerminal = new Set<CaseStage>();
  for (const e of events) {
    seen.add(e.stage);
    if (e.type === 'stage-exited') exited.set(e.stage, e.payload.to);
    if (e.type === 'cost-charged') {
      const c = e.payload.cost;
      const prev = costs.get(c.stage) ?? { attempts: new Set<number>(), wallMs: 0 };
      prev.attempts.add(c.attempt);
      prev.wallMs += c.wallMs;
      costs.set(c.stage, prev);
    }
    if (e.type === 'verdict-written') reachedTerminal.add('verdict');
    if (e.type === 'dismissed') reachedTerminal.add('dismissed');
    if (e.type === 'escalated' || e.type === 'budget-exhausted') reachedTerminal.add('escalated');
  }
  for (const s of seen) if (TERMINAL_STAGES.includes(s)) reachedTerminal.add(s);
  const last = events.at(-1);
  const latest = last?.stage;
  // Once the record holds a terminal event no stage is still running. A stage whose exit is the
  // latest event is done, and the next one has not started yet.
  const active =
    finished ||
    latest === undefined ||
    last?.type === 'stage-exited' ||
    TERMINAL_STAGES.includes(latest)
      ? undefined
      : latest;

  return CaseStage.options.map((stage): StageCell => {
    const cost = costs.get(stage);
    const to = exited.get(stage);
    let state: StageCell['state'] = 'pending';
    if (stage === active) state = 'active';
    else if (to !== undefined || reachedTerminal.has(stage)) state = 'done';
    // A stage the case ended in (an escalation or dismissal from inside it) is over, not pending.
    else if (finished && seen.has(stage)) state = 'done';
    return {
      stage,
      state,
      ...(to !== undefined ? { exitedTo: to } : {}),
      attempts: cost?.attempts.size ?? 0,
      ...(cost ? { wallMs: cost.wallMs } : {}),
    };
  });
}

function buildEvidence(ctx: Context): EvidenceRow[] {
  const author = new Map<string, Role>();
  for (const e of ctx.events) {
    if (e.type === 'exhibit-submitted') {
      if (!author.has(e.payload.exhibitId)) author.set(e.payload.exhibitId, e.actor);
    }
  }
  // An exhibit first seen in a Judge ruling has no submission on record. Its author falls back to
  // the actor of the first event that names it, which is what the record shows.
  for (const e of ctx.events) {
    const id =
      e.type === 'exhibit-result'
        ? e.payload.result.exhibitId
        : e.type === 'exhibit-inadmissible'
          ? e.payload.exhibitId
          : undefined;
    if (id !== undefined && !author.has(id)) author.set(id, e.actor);
  }
  return ctx.view.exhibits.map((x): EvidenceRow => {
    const r = ctx.results.get(x.id);
    const family = r?.familyResults
      ? [...r.familyResults].sort((a, b) => a.paramIndex - b.paramIndex).map((f) => f.passed)
      : undefined;
    return {
      id: x.id,
      kind: x.kind,
      author: author.get(x.id) ?? 'judge',
      state: !x.judged ? 'pending' : x.admitted ? 'admitted' : 'rejected',
      ...(x.rejectedBy !== undefined ? { rejectedBy: x.rejectedBy } : {}),
      // The same latest Judge result the case view copies its runs from.
      runs: r ? r.runs.map(runCell) : [],
      ...(r
        ? {
            vulnPass: r.vulnPass,
            ...(r.safeVariantFail !== undefined ? { safeVariantFail: r.safeVariantFail } : {}),
            egressAttempts: r.egressAttempts,
            ...(family ? { family } : {}),
            durationMs: r.durationMs,
          }
        : {}),
    };
  });
}

function buildVerify(
  events: readonly TrialEvent[],
  kindOf: ReadonlyMap<string, EvidenceRow['kind']>,
  admittedCounterexamples: readonly string[],
): Map<TrialEvent, VerifyRow> {
  const rows = new Map<TrialEvent, VerifyRow>();
  let afterVerdict = false;
  for (const e of events) {
    if (e.type === 'verdict-written') afterVerdict = true;
    if (e.type !== 'verify-result') continue;
    const r = e.payload.result;
    const counts = isJudgeVerify(e) && !afterVerdict && kindOf.get(r.patchExhibitId) === 'patch';
    const counterOk =
      counterexamplesComplete(r, admittedCounterexamples) &&
      r.counterexamples.every((c) => !c.survived);
    rows.set(e, {
      seq: e.seq,
      patchExhibitId: r.patchExhibitId,
      counts,
      accepted: counts && isAccepted(r, admittedCounterexamples),
      checks: [
        { check: 'family-flipped', ok: r.familyFlipped },
        { check: 'suite-passed', ok: r.suitePassed },
        { check: 'rescan-clean', ok: r.rescanClean },
        { check: 'counterexamples', ok: counterOk },
      ],
      counterexamples: r.counterexamples.map((c) => ({
        exhibitId: c.exhibitId,
        survived: c.survived,
      })),
      ...(r.rejectedBy !== undefined ? { rejectedBy: r.rejectedBy } : {}),
    });
  }
  return rows;
}

function buildCost(events: readonly TrialEvent[]): CostView {
  const rows: CostRow[] = [];
  const total = { inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 0 };
  let remaining: CostView['remaining'];
  for (const e of events) {
    if (e.type !== 'cost-charged') continue;
    const c = e.payload.cost;
    rows.push({
      stage: c.stage,
      attempt: c.attempt,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      usd: c.usd,
      wallMs: c.wallMs,
    });
    total.inputTokens += c.inputTokens;
    total.outputTokens += c.outputTokens;
    total.usd += c.usd;
    total.wallMs += c.wallMs;
    const b = e.payload.remaining;
    remaining = {
      inputTokens: b.remainingInputTokens,
      outputTokens: b.remainingOutputTokens,
      usd: b.remainingUsd,
      exhausted: b.exhausted,
    };
  }
  return { rows, total, ...(remaining ? { remaining } : {}) };
}

function ballotRow(b: Ballot, seq: number): BallotRow {
  return {
    seq,
    jurorId: b.jurorId,
    mandate: b.mandate,
    model: b.model,
    question: b.question,
    vote: b.vote,
    confidence: b.confidence,
    citedExhibits: [...b.citedExhibits],
    inputVariant: b.inputVariant,
  };
}

/**
 * Ballots as cast. A record with no `ballot-cast` events but a verdict that carries ballots shows
 * those instead, under the verdict's seq, so recorded votes are never hidden.
 */
function buildBallots(events: readonly TrialEvent[]): BallotRow[] {
  const cast = events
    .filter((e): e is Of<'ballot-cast'> => e.type === 'ballot-cast')
    .map((e) => ballotRow(e.payload.ballot, e.seq));
  if (cast.length > 0) return cast;
  const verdict = events
    .filter((e): e is Of<'verdict-written'> => e.type === 'verdict-written')
    .at(-1);
  return verdict ? verdict.payload.verdict.ballots.map((b) => ballotRow(b, verdict.seq)) : [];
}

function buildVerdict(events: readonly TrialEvent[]): VerdictView | undefined {
  let verdict: Verdict | undefined;
  for (const e of events) if (e.type === 'verdict-written') verdict = e.payload.verdict;
  if (!verdict) return undefined;
  const models: VerdictView['models'] = [];
  for (const prompt of PromptId.options) {
    const model = verdict.modelIds[prompt];
    const version = verdict.promptVersions[prompt];
    if (model === undefined && version === undefined) continue;
    models.push({
      prompt,
      ...(model !== undefined ? { model } : {}),
      ...(version !== undefined ? { version } : {}),
    });
  }
  return {
    outcome: verdict.outcome,
    ...(verdict.severity !== undefined ? { severity: verdict.severity } : {}),
    ...(verdict.bundleSha256 !== undefined ? { bundleSha256: verdict.bundleSha256 } : {}),
    models,
    ...(verdict.jurorCorrelation !== undefined
      ? { jurorCorrelation: verdict.jurorCorrelation }
      : {}),
    exhibits: [...verdict.exhibits],
  };
}

function buildDiff(ctx: Context): DiffView | undefined {
  // The latest patch on record (by submission order) that a source served content for.
  const patches = ctx.view.exhibits.filter((x) => x.kind === 'patch').map((x) => x.id);
  for (let i = patches.length - 1; i >= 0; i -= 1) {
    const id = patches[i];
    const content = id === undefined ? undefined : ctx.patchContent.get(id);
    if (!content) continue;
    const parsed = parseUnifiedDiff(content.diff);
    return {
      exhibitId: content.id,
      filesTouched: content.filesTouched
        .slice(0, MAX_FILES)
        .map((f) => (f.length > MAX_FILE_NAME ? f.slice(0, MAX_FILE_NAME) : f)),
      linesChanged: content.linesChanged,
      added: parsed.added,
      removed: parsed.removed,
      lines: parsed.lines,
    };
  }
  return undefined;
}

function tapeTone(e: TrialEvent, ctx: Context): Tone {
  switch (e.type) {
    case 'exhibit-result':
      return e.payload.result.admissible ? 'pos' : 'neg';
    case 'exhibit-inadmissible':
      return 'neg';
    case 'objection':
    case 'appeal':
    case 'budget-exhausted':
    case 'escalated':
      return 'warn';
    case 'verify-result': {
      const row = ctx.verifyRows.get(e);
      if (!row?.counts) return 'warn';
      return row.accepted ? 'pos' : 'neg';
    }
    case 'verdict-written':
      return verdictTone(e.payload.verdict, ctx.view);
    case 'cost-charged':
      return e.payload.remaining.exhausted ? 'warn' : 'neutral';
    default:
      return 'neutral';
  }
}

function verdictTone(v: Verdict, view: CaseView): Tone {
  switch (v.outcome) {
    case 'proven-fixed':
      return view.stamp === 'VERIFIED' ? 'pos' : 'warn';
    case 'proven-unfixed':
      return 'neg';
    case 'escalated':
      return 'warn';
    default:
      return 'neutral';
  }
}

type Draft = Omit<Bubble, 'id' | 'seq' | 'agent'>;

function ruling(r: ExhibitResult, kind: EvidenceRow['kind']): Draft {
  if (!r.admissible) {
    const rule = r.rejectedBy;
    return {
      anchor: 'evidence',
      tone: 'neg',
      title: `${KIND_NAME[kind]} not admitted`,
      body:
        rule !== undefined
          ? `${RULE_TEXT[rule]} The Judge applied rule ${rule} and did not admit it.`
          : 'The Judge did not admit it. The record names no rule.',
      cites: [r.exhibitId],
    };
  }
  const vuln = r.runs.filter((run) => run.variant === 'vulnerable');
  const passed = vuln.filter((run) => run.passed).length;
  const first =
    vuln.length > 0
      ? `It passed on the vulnerable code in ${passed} of ${plural(vuln.length, 'run', 'runs')}`
      : r.vulnPass
        ? 'It passed on the vulnerable code'
        : 'It did not pass on the vulnerable code';
  const second =
    r.safeVariantFail === true
      ? r.vulnPass
        ? ' and failed on the known-safe variant, so it proves the difference.'
        : ' and failed on the known-safe variant.'
      : r.safeVariantFail === false
        ? ' and did not fail on the known-safe variant.'
        : '. No known-safe variant is recorded, so there is no difference to compare.';
  return {
    anchor: 'evidence',
    tone: 'pos',
    title: `${KIND_NAME[kind]} admitted`,
    body: `${first}${second}`,
    cites: [r.exhibitId],
  };
}

function rejectedRuling(
  id: string,
  kind: EvidenceRow['kind'],
  rule: Of<'exhibit-inadmissible'>['payload']['rejectedBy'],
): Draft {
  return {
    anchor: 'evidence',
    tone: 'neg',
    title: `${KIND_NAME[kind]} not admitted`,
    body: `${RULE_TEXT[rule]} The Judge applied rule ${rule} and did not admit it.`,
    cites: [id],
  };
}

function verifyBubbles(
  e: Of<'verify-result'>,
  row: VerifyRow | undefined,
  ctx: Context,
  afterVerdict: boolean,
): Draft[] {
  const r: VerifyResult = e.payload.result;
  const cites = [r.patchExhibitId as string];
  const judged: TrialEvent = e;
  if (!isJudgeVerify(judged))
    return [
      {
        anchor: 'verify',
        tone: 'warn',
        title: 'Check does not count',
        body: `${ROLE_NAME[e.actor]} recorded this patch check in the ${STAGE_NAME[e.stage]} stage. Only the Judge's own check in the verify stage counts.`,
        cites,
      },
    ];
  if (afterVerdict)
    return [
      {
        anchor: 'verify',
        tone: 'warn',
        title: 'Check after the verdict',
        body: 'This patch check was recorded after the verdict was written, so it does not count.',
        cites,
      },
    ];
  if (ctx.kindOf.get(r.patchExhibitId) !== 'patch')
    return [
      {
        anchor: 'verify',
        tone: 'warn',
        title: 'Check names no patch',
        body: 'This check names an exhibit the record does not hold as a patch, so it does not count.',
        cites,
      },
    ];
  if (row?.accepted) {
    const n = r.counterexamples.length;
    return [
      {
        anchor: 'verify',
        tone: 'pos',
        title: 'Patch confirmed',
        body:
          'The witness family no longer passes on the patched code, the test suite still passes, and the rescan is clean. ' +
          (n === 0
            ? 'No counterexample was admitted, so none had to be stopped.'
            : `${plural(n, 'admitted counterexample was', 'admitted counterexamples were')} tried and none survived.`),
        cites,
      },
    ];
  }
  const out: Draft[] = [];
  if (!r.familyFlipped)
    out.push({
      anchor: 'verify',
      tone: 'neg',
      title: 'Witness still passes',
      body: 'The witness family still passes on the patched code, so the patch does not stop the weakness.',
      cites,
    });
  if (!r.suitePassed)
    out.push({
      anchor: 'verify',
      tone: 'neg',
      title: 'Test suite failed',
      body: RULE_TEXT['suite-fails'],
      cites,
    });
  if (!r.rescanClean)
    out.push({
      anchor: 'verify',
      tone: 'neg',
      title: 'Rescan not clean',
      body: 'The rescan of the patched code still reports a finding.',
      cites,
    });
  const survived = r.counterexamples.filter((c) => c.survived).map((c) => c.exhibitId as string);
  if (survived.length > 0)
    out.push({
      anchor: 'verify',
      tone: 'neg',
      title: 'Counterexample survived',
      body: `${RULE_TEXT['counterexample-survives']} ${plural(survived.length, 'counterexample', 'counterexamples')} still worked.`,
      cites: [...cites, ...survived],
    });
  else if (row && row.checks.some((c) => c.check === 'counterexamples' && !c.ok))
    out.push({
      anchor: 'verify',
      tone: 'neg',
      title: 'Counterexample check incomplete',
      body: 'The check did not report exactly one result for each admitted counterexample, so it is not evidence the patch was tested against them.',
      cites,
    });
  if (out.length === 0 || r.rejectedBy !== undefined)
    out.push({
      anchor: 'verify',
      tone: 'neg',
      title: 'Patch not accepted',
      body:
        r.rejectedBy !== undefined
          ? `${RULE_TEXT[r.rejectedBy]} The Judge applied rule ${r.rejectedBy}.`
          : 'The Judge did not accept the patch.',
      cites,
    });
  return out;
}

function verdictBubble(v: Verdict, view: CaseView): Draft {
  const cited = plural(v.exhibits.length, 'exhibit', 'exhibits');
  let body: string;
  switch (v.outcome) {
    case 'proven-fixed': {
      const first = `The weakness was ruled proven${v.severity ? ` at ${v.severity} severity` : ''} and fixed, citing ${cited}.`;
      const second =
        view.stamp === 'VERIFIED'
          ? " The Judge's recorded patch check backs the fix, so the case is verified."
          : view.awaitingVerification
            ? ' No Judge check of the patch is recorded yet, so the fix is not verified.'
            : ' The recorded evidence does not back the fix, so it is not verified.';
      body = first + second;
      break;
    }
    case 'proven-unfixed':
      body = `The weakness was ruled proven${v.severity ? ` at ${v.severity} severity` : ''}, citing ${cited}. No fix was proven.`;
      break;
    case 'not-proven':
      body = `The weakness was not proven, citing ${cited}. This is not a finding that the code is safe.`;
      break;
    case 'dismissed':
      body = `The case was dismissed, citing ${cited}.`;
      break;
    case 'escalated':
      body = `The case was sent to human review, citing ${cited}. No conclusion about safety has been reached.`;
      break;
  }
  if (v.ballots.length > 0)
    body += ` The verdict records ${plural(v.ballots.length, 'ballot', 'ballots')}.`;
  return {
    anchor: 'verdict',
    tone: verdictTone(v, view),
    title: OUTCOME_TITLE[v.outcome],
    body,
    ...(v.summary.length > 0 ? { quote: quote(v.summary) } : {}),
    cites: [...v.exhibits],
  };
}

function bubblesFor(e: TrialEvent, ctx: Context, afterVerdict: boolean): Draft[] {
  switch (e.type) {
    case 'stage-exited': {
      const title = STAGE_TITLE[e.stage];
      const body = STAGE_BODY[e.stage];
      if (title !== undefined && body !== undefined)
        return [
          {
            anchor: 'stages',
            tone: 'neutral',
            title,
            body: `${body} The case moved on to ${STAGE_NAME[e.payload.to]}.`,
            cites: [],
          },
        ];
      if (e.stage === 'prosecution') {
        // Anywhere in the record: a counterexample filed at all means this bubble would mislead.
        const filed = ctx.events.some(
          (x) => x.type === 'exhibit-submitted' && x.payload.kind === 'counterexample',
        );
        if (!filed)
          return [
            {
              anchor: 'arguments',
              tone: 'neutral',
              title: 'No counterexample filed',
              body: `The prosecution stage finished with no counterexample in the record, and the case moved on to ${STAGE_NAME[e.payload.to]}.`,
              cites: [],
            },
          ];
      }
      return [];
    }
    case 'exhibit-submitted': {
      const id = e.payload.exhibitId as string;
      const who = ROLE_NAME[e.actor];
      if (e.payload.kind === 'witness')
        return [
          {
            anchor: 'evidence',
            tone: 'neutral',
            title: 'Witness filed',
            body: `${who} filed a witness. The Judge runs it against the vulnerable code and the known-safe variant before it counts as proof.`,
            cites: [id],
          },
        ];
      if (e.payload.kind === 'counterexample')
        return [
          {
            anchor: 'arguments',
            tone: 'warn',
            title: 'Counterexample filed',
            body: `${who} filed a counterexample. If the Judge admits it, any patch must stop it too.`,
            cites: [id],
          },
        ];
      const content = ctx.patchContent.get(id);
      return [
        {
          anchor: 'diff',
          tone: 'neutral',
          title: 'Patch filed',
          body: content
            ? `${who} filed a patch touching ${plural(content.filesTouched.length, 'file', 'files')} with ${plural(content.linesChanged, 'line', 'lines')} changed. The Judge checks it before it counts.`
            : `${who} filed a patch. Its content is not in this record, so its lines cannot be shown.`,
          cites: [id],
        },
      ];
    }
    case 'exhibit-result': {
      const r = e.payload.result;
      return [ruling(r, ctx.kindOf.get(r.exhibitId) ?? 'witness')];
    }
    case 'exhibit-inadmissible':
      return [
        rejectedRuling(
          e.payload.exhibitId,
          ctx.kindOf.get(e.payload.exhibitId) ?? 'witness',
          e.payload.rejectedBy,
        ),
      ];
    case 'objection':
      return [
        {
          anchor: 'arguments',
          tone: 'warn',
          title: 'Objection',
          body:
            e.actor === 'prosecution'
              ? 'The Prosecution objected, citing a counterexample. Its claim is quoted as recorded.'
              : `${ROLE_NAME[e.actor]} raised an objection, citing an exhibit. The claim is quoted as recorded.`,
          quote: quote(e.payload.claim),
          cites: [e.payload.exhibitId],
        },
      ];
    case 'appeal':
      return [
        {
          anchor: 'arguments',
          tone: 'warn',
          title: `Appeal round ${e.payload.round}`,
          body: `Appeal round ${e.payload.round} of at most ${MAX_APPEALS} was recorded, citing a counterexample. The patch must be checked again.`,
          cites: [e.payload.counterexampleId],
        },
      ];
    case 'ballot-cast': {
      const b = e.payload.ballot;
      return [
        {
          agentDetail: b.mandate,
          anchor: 'jury',
          tone: 'neutral',
          title: QUESTION_TITLE[b.question],
          body: `Voted ${b.vote} on ${QUESTION_NAME[b.question]} with ${Math.round(b.confidence * 100)}% confidence, citing ${plural(b.citedExhibits.length, 'exhibit', 'exhibits')}.`,
          cites: [...b.citedExhibits],
        },
      ];
    }
    case 'budget-exhausted':
      return [
        {
          anchor: 'cost',
          tone: 'warn',
          title: 'Budget exhausted',
          body: `${REVIEW_REASON['budget-exhausted']} The case goes to human review.`,
          ...(e.payload.escalation.detail.length > 0
            ? { quote: quote(e.payload.escalation.detail) }
            : {}),
          cites: [],
        },
      ];
    case 'escalated':
      return [
        {
          anchor: 'verdict',
          tone: 'warn',
          title: 'Escalated to human review',
          body: `${REVIEW_REASON[e.payload.escalation.reason]} No conclusion about safety has been reached.`,
          ...(e.payload.escalation.detail.length > 0
            ? { quote: quote(e.payload.escalation.detail) }
            : {}),
          cites: [],
        },
      ];
    case 'dismissed':
      return [
        {
          anchor: 'verdict',
          tone: 'neutral',
          title: 'Dismissed',
          body: `${DISMISS_TEXT[e.payload.dismissal.reason]} The case was closed without a proven finding.`,
          ...(e.payload.dismissal.detail.length > 0
            ? { quote: quote(e.payload.dismissal.detail) }
            : {}),
          cites: [],
        },
      ];
    case 'verdict-written':
      return [verdictBubble(e.payload.verdict, ctx.view)];
    case 'verify-result':
      return verifyBubbles(e, ctx.verifyRows.get(e), ctx, afterVerdict);
    default:
      return [];
  }
}

/**
 * Builds the terminal view from the recorded events, plus exhibit content when a source has it.
 * Pure and total: any event array, including an empty one, gives a view, and the same input gives
 * an equal view. Status, the VERIFIED stamp, and each exhibit's ruling come from `buildCaseView`.
 */
export function buildTerminalView(
  input: readonly TrialEvent[],
  content: readonly Exhibit[] = [],
): TerminalView {
  const events = recordedEvents(input);
  const view = buildCaseView(events);

  const kindOf = new Map<string, EvidenceRow['kind']>();
  for (const x of view.exhibits) kindOf.set(x.id, x.kind);
  const results = new Map<string, ExhibitResult>();
  for (const e of events)
    if (e.type === 'exhibit-result') results.set(e.payload.result.exhibitId, e.payload.result);
  const admittedCounterexamples = view.exhibits
    .filter((x) => x.kind === 'counterexample' && x.admitted)
    .map((x) => x.id);

  // Content counts only for a patch of this case the record holds; the first one served wins.
  const patchContent = new Map<string, PatchExhibit>();
  for (const x of content)
    if (
      x.kind === 'patch' &&
      x.caseId === view.caseId &&
      kindOf.get(x.id) === 'patch' &&
      !patchContent.has(x.id)
    )
      patchContent.set(x.id, x);

  const ctx: Context = {
    events,
    view,
    kindOf,
    results,
    verifyRows: buildVerify(events, kindOf, admittedCounterexamples),
    patchContent,
  };

  const finished = events.some(
    (e) =>
      e.type === 'verdict-written' ||
      e.type === 'escalated' ||
      e.type === 'budget-exhausted' ||
      e.type === 'dismissed',
  );

  const tape: TapeRow[] = events.map((e, i) => ({
    seq: e.seq,
    at: e.at,
    stage: e.stage,
    actor: e.actor,
    type: e.type,
    // The docket is one entry per recorded event, in the same order.
    text: view.docket[i]?.label ?? '',
    tone: tapeTone(e, ctx),
  }));

  const bubbles: Bubble[] = [];
  let afterVerdict = false;
  for (const e of events) {
    const drafts = bubblesFor(e, ctx, afterVerdict);
    drafts.forEach((d, n) => {
      bubbles.push({ ...d, id: `b${e.seq}-${n}`, agent: e.actor, seq: e.seq });
    });
    if (e.type === 'verdict-written') afterVerdict = true;
  }

  return {
    caseId: view.caseId,
    status: view.status,
    verified: view.stamp === 'VERIFIED',
    awaitingVerification: view.awaitingVerification,
    eventCount: events.length,
    lastSeq: events.at(-1)?.seq ?? -1,
    stages: buildStages(events, finished),
    evidence: buildEvidence(ctx),
    verify: [...ctx.verifyRows.values()],
    diff: buildDiff(ctx),
    cost: buildCost(events),
    ballots: buildBallots(events),
    tape,
    bubbles,
    verdict: buildVerdict(events),
  };
}
