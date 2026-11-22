import type { Exhibit, TrialEvent } from '@affidavit/contracts';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { RULE_TEXT, STATUS_STAMP } from '../app/status.js';
import { buildTerminalView } from './model.js';
import type {
  BallotRow,
  Bubble,
  CostView,
  DiffView,
  EvidenceRow,
  PanelId,
  RunCell,
  StageCell,
  TapeRow,
  TerminalView,
  VerdictView,
  VerifyRow,
} from './types.js';

// The trial terminal (L3-13): one trial as a dense grid of panels, with speech bubbles from the
// agents pinned to the panel each one explains.
//
// Every recorded string (ids, quotes, file names, diff lines, model names) is rendered as a React
// text child and nowhere else. Class names never come from the view: each enum-like field goes
// through a static lookup table with a fallback, so an unexpected value shows as plain text and
// cannot pick a class.

interface Look {
  label: string;
  cls: string;
}

function pick<T>(table: Readonly<Record<string, T>>, key: string, fallback: T): T {
  return Object.hasOwn(table, key) ? (table[key] as T) : fallback;
}

const AGENTS: Readonly<Record<string, Look>> = {
  defense: { label: 'Defense', cls: 'defense' },
  prosecution: { label: 'Prosecution', cls: 'prosecution' },
  remedy: { label: 'Remedy', cls: 'remedy' },
  judge: { label: 'Judge', cls: 'judge' },
  juror: { label: 'Juror', cls: 'juror' },
  stenographer: { label: 'Stenographer', cls: 'stenographer' },
};

function agentLook(role: string): Look {
  return pick(AGENTS, role, { label: role, cls: 'unknown' });
}

const STAGE_LABEL: Readonly<Record<string, string>> = {
  intake: 'Intake',
  map: 'Map',
  arraign: 'Arraign',
  defense: 'Defense',
  prosecution: 'Prosecution',
  remedy: 'Remedy',
  verify: 'Verify',
  jury: 'Jury',
  verdict: 'Verdict',
  dismissed: 'Dismissed',
  escalated: 'Escalated',
};

const STAGE_STATE: Readonly<Record<string, Look & { glyph: string }>> = {
  pending: { label: 'pending', cls: 'pending', glyph: '□' },
  active: { label: 'active', cls: 'active', glyph: '▶' },
  done: { label: 'done', cls: 'done', glyph: '■' },
};

const EVIDENCE_STATE: Readonly<Record<string, Look>> = {
  pending: { label: 'PENDING', cls: 'pending' },
  admitted: { label: 'ADMITTED', cls: 'pos' },
  rejected: { label: 'REJECTED', cls: 'neg' },
};

const KIND_LABEL: Readonly<Record<string, string>> = {
  witness: 'Witness',
  counterexample: 'Counterexample',
  patch: 'Patch',
};

const KIND_CLAIM: Readonly<Record<string, string>> = {
  witness: 'claims the flaw is real and this test proves it',
  counterexample: 'claims this input gets past the proof or the patch',
  patch: 'claims this change fixes the flaw',
};

const TONES: Readonly<Record<string, Look & { glyph: string; word: string }>> = {
  pos: { label: 'pos', cls: 'pos', glyph: '+', word: 'Favorable: ' },
  neg: { label: 'neg', cls: 'neg', glyph: 'x', word: 'Adverse: ' },
  warn: { label: 'warn', cls: 'warn', glyph: '!', word: 'Caution: ' },
  neutral: { label: 'neutral', cls: 'neutral', glyph: '·', word: '' },
};
const NEUTRAL = { label: 'neutral', cls: 'neutral', glyph: '·', word: '' };

const CHECK_LABEL: Readonly<Record<string, string>> = {
  'family-flipped': 'Witness family flips to fail on the patched code',
  'suite-passed': 'Existing test suite passes with the patch',
  'rescan-clean': 'Rescan of the patched code is clean',
  counterexamples: 'No counterexample survives the patch',
};

const OUTCOME: Readonly<Record<string, Look>> = {
  'proven-fixed': { label: 'PROVEN, FIX CLAIMED', cls: 'neutral' },
  'proven-unfixed': { label: 'PROVEN, NOT FIXED', cls: 'neg' },
  'not-proven': { label: 'NOT PROVEN', cls: 'neutral' },
  dismissed: { label: 'DISMISSED', cls: 'neutral' },
  escalated: { label: 'ESCALATED TO HUMAN REVIEW', cls: 'warn' },
};

const PANEL_TITLE: Readonly<Record<PanelId, string>> = {
  stages: 'Stages',
  evidence: 'Evidence',
  verify: 'Verify',
  diff: 'Diff',
  arguments: 'Arguments',
  jury: 'Jury',
  cost: 'Cost',
  tape: 'Tape',
  verdict: 'Verdict',
};

const VARIANTS = ['vulnerable', 'safe', 'patched'] as const;
const METRIC = '[metric]';
const VISIBLE_BUBBLES = 3;

function int(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : METRIC;
}

function ms(n: number): string {
  if (!Number.isFinite(n)) return METRIC;
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

function usd(n: number): string {
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : METRIC;
}

/** Clock part of a recorded ISO time; anything else is shown as recorded. */
function clock(at: string): string {
  return /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(at)?.[1] ?? at;
}

/** The Judge's rule in plain words, followed by the recorded rule id. */
function ruleText(rule: string): string {
  const words = pick<string>(RULE_TEXT, rule, 'The rule that applied is not one this view knows.');
  return `${words} Rule: ${rule}.`;
}

function passFail(ok: boolean): string {
  return ok ? 'pass' : 'fail';
}

function Res({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? 'term-res term-res--pass' : 'term-res term-res--fail'}>
      {ok ? 'PASS' : 'FAIL'}
    </span>
  );
}

function AgentChip({ role, detail }: { role: string; detail?: string | undefined }) {
  const look = agentLook(role);
  return (
    <span className={`term-chip term-chip--${look.cls}`}>
      {detail ? `${look.label}: ${detail}` : look.label}
    </span>
  );
}

function Ids({ ids, label }: { ids: readonly string[]; label: string }) {
  if (ids.length === 0) return null;
  return (
    <span className="term-ids">
      {label ? <span className="sr-only">{`${label} `}</span> : null}
      {ids.map((id, i) => (
        <span key={i} className="term-id">
          {id}
        </span>
      ))}
    </span>
  );
}

/** A region that scrolls inside its panel. Focusable so a keyboard user can scroll it. */
function Scroll({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`term-scroll${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Bubbles

function BubbleItem({ bubble }: { bubble: Bubble }) {
  const agent = agentLook(bubble.agent);
  const tone = pick(TONES, bubble.tone, NEUTRAL);
  return (
    <li className={`term-bubble term-bubble--${agent.cls}`}>
      <p className="term-bubble-head">
        <AgentChip role={bubble.agent} detail={bubble.agentDetail} />
        <span className="term-bubble-seq">{`#${bubble.seq}`}</span>
      </p>
      <p className="term-bubble-title">
        {tone.word ? (
          <span className={`term-tone term-tone--${tone.cls}`} aria-hidden="true">
            {tone.glyph}
          </span>
        ) : null}
        {tone.word ? <span className="sr-only">{tone.word}</span> : null}
        {bubble.title}
      </p>
      <p className="term-bubble-body">{bubble.body}</p>
      {bubble.quote ? (
        <blockquote className="term-quote">
          <p className="term-quote-label">Recorded text</p>
          <p className="term-quote-text">{bubble.quote}</p>
        </blockquote>
      ) : null}
      {bubble.cites.length > 0 ? (
        <p className="term-bubble-cites">
          <Ids ids={bubble.cites} label="Cites" />
        </p>
      ) : null}
    </li>
  );
}

function Notes({ title, bubbles }: { title: string; bubbles: readonly Bubble[] }) {
  if (bubbles.length === 0) return null;
  const cut = Math.max(0, bubbles.length - VISIBLE_BUBBLES);
  const earlier = bubbles.slice(0, cut);
  const latest = bubbles.slice(cut);
  return (
    <div className="term-notes">
      <ul className="term-note-list" aria-label={`Notes on ${title}`}>
        {latest.map((b) => (
          <BubbleItem key={b.id} bubble={b} />
        ))}
      </ul>
      {earlier.length > 0 ? (
        <details className="term-earlier">
          <summary>{`${earlier.length} earlier`}</summary>
          <ul className="term-note-list" aria-label={`Earlier notes on ${title}`}>
            {earlier.map((b) => (
              <BubbleItem key={b.id} bubble={b} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** True when the terminal sits inside a page that already has its own h1. */
const EmbeddedContext = createContext(false);

function PanelHeading({ id, children }: { id: string; children: ReactNode }) {
  return useContext(EmbeddedContext) ? <h3 id={id}>{children}</h3> : <h2 id={id}>{children}</h2>;
}

/** A heading one level under its panel's heading. */
function SubHeading({ className, children }: { className?: string; children: ReactNode }) {
  return useContext(EmbeddedContext) ? (
    <h4 className={className}>{children}</h4>
  ) : (
    <h3 className={className}>{children}</h3>
  );
}

function Panel({
  id,
  uid,
  meta,
  bubbles,
  children,
}: {
  id: PanelId;
  uid: string;
  meta: ReactNode;
  bubbles: readonly Bubble[];
  children: ReactNode;
}) {
  const title = PANEL_TITLE[id];
  const headingId = `${uid}-${id}`;
  return (
    <section
      className={`term-panel term-panel--${id}${bubbles.length > 0 ? ' term-panel--noted' : ''}`}
      aria-labelledby={headingId}
    >
      <div className="term-box">
        <div className="term-bar">
          <PanelHeading id={headingId}>{title}</PanelHeading>
          <p className="term-bar-meta">{meta}</p>
        </div>
        <div className="term-body">{children}</div>
      </div>
      <Notes title={title} bubbles={bubbles} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Panels

function StageRail({ stages }: { stages: readonly StageCell[] }) {
  return (
    <ol className="term-rail">
      {stages.map((s, i) => {
        const state = pick(STAGE_STATE, s.state, { label: s.state, cls: 'pending', glyph: '□' });
        const meta = [
          s.attempts > 0 ? `${s.attempts} att` : '',
          s.wallMs !== undefined ? ms(s.wallMs) : '',
        ].filter(Boolean);
        return (
          <li
            key={i}
            className={`term-rail-item term-rail-item--${state.cls}`}
            aria-current={state.cls === 'active' ? 'step' : undefined}
          >
            <span className="term-rail-top">
              <span className="term-rail-n">{String(i + 1).padStart(2, '0')}</span>
              <span aria-hidden="true">{state.glyph}</span>
              <span className="term-rail-state">{state.label}</span>
            </span>
            <span className="term-rail-name">{pick(STAGE_LABEL, s.stage, s.stage)}</span>
            <span className="term-rail-meta">
              {meta.length > 0 ? meta.join(' ') : ' '}
              {s.exitedTo ? (
                <span className="sr-only">{`, then ${pick(STAGE_LABEL, s.exitedTo, s.exitedTo)}`}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RunMatrix({ row }: { row: EvidenceRow }) {
  if (row.runs.length === 0)
    return <p className="term-dim">No Judge runs are recorded for this exhibit.</p>;
  const byCell = new Map<string, RunCell>();
  let last = 3;
  for (const r of row.runs) {
    byCell.set(`${r.variant}/${r.attempt}`, r);
    if (Number.isInteger(r.attempt) && r.attempt > last) last = Math.min(r.attempt, 12);
  }
  const attempts = Array.from({ length: last }, (_, i) => i + 1);
  return (
    <Scroll label="Run matrix, scrolls sideways">
      <table className="term-matrix">
        <caption className="sr-only">{`Run matrix for ${row.id}: result, exit code and duration per variant and attempt`}</caption>
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              Att
            </th>
            {VARIANTS.map((v) => (
              <th key={v} scope="colgroup" colSpan={3} className="term-matrix-variant">
                {v}
              </th>
            ))}
          </tr>
          <tr>
            {VARIANTS.map((v) => (
              <FragmentCols key={v} variant={v} />
            ))}
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a}>
              <th scope="row" className="term-num">
                {a}
              </th>
              {VARIANTS.map((v) => {
                const r = byCell.get(`${v}/${a}`);
                return r ? (
                  <FragmentRun key={v} run={r} />
                ) : (
                  <td key={v} colSpan={3} className="term-norun">
                    <span aria-hidden="true">{'·'}</span>
                    <span className="sr-only">not run</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function FragmentCols({ variant }: { variant: string }) {
  return (
    <>
      <th scope="col" className="term-matrix-first">
        <span className="sr-only">{`${variant} `}</span>res
      </th>
      <th scope="col" className="term-num">
        <span className="sr-only">{`${variant} `}</span>exit
      </th>
      <th scope="col" className="term-num">
        <span className="sr-only">{`${variant} `}</span>ms
      </th>
    </>
  );
}

function FragmentRun({ run }: { run: RunCell }) {
  return (
    <>
      <td className="term-matrix-first">
        <Res ok={run.passed} />
      </td>
      <td className="term-num">{run.exitCode}</td>
      <td className="term-num">{int(run.durationMs)}</td>
    </>
  );
}

function differential(row: EvidenceRow): { line: string; look: Look } | undefined {
  if (row.vulnPass === undefined) return undefined;
  const safe =
    row.safeVariantFail === undefined
      ? 'no safe variant on record'
      : passFail(!row.safeVariantFail);
  const line = `vulnerable: ${passFail(row.vulnPass)}, safe: ${safe}`;
  if (row.safeVariantFail === undefined)
    return { line, look: { label: 'NOT DIFFERENTIAL', cls: 'warn' } };
  return row.vulnPass && row.safeVariantFail
    ? { line, look: { label: 'HOLDS', cls: 'pos' } }
    : { line, look: { label: 'DOES NOT HOLD', cls: 'neg' } };
}

function ExhibitBlock({ row }: { row: EvidenceRow }) {
  const state = pick(EVIDENCE_STATE, row.state, { label: row.state, cls: 'pending' });
  const diff = differential(row);
  const hasFacts =
    diff !== undefined ||
    row.family !== undefined ||
    row.egressAttempts !== undefined ||
    row.durationMs !== undefined;
  return (
    <div className="term-exhibit">
      <div className="term-exhibit-head">
        <SubHeading className="term-id">{row.id}</SubHeading>
        <span className="term-kind">{pick(KIND_LABEL, row.kind, row.kind)}</span>
        <AgentChip role={row.author} />
        <span className={`term-state term-state--${state.cls}`}>{state.label}</span>
      </div>
      {row.state === 'rejected' ? (
        <p className="term-reason">
          {row.rejectedBy
            ? ruleText(row.rejectedBy)
            : 'Rejected by the Judge. The rule that applied is not recorded.'}
        </p>
      ) : null}
      {row.state === 'pending' ? (
        <p className="term-dim">No Judge ruling is recorded yet. Pending is not a rejection.</p>
      ) : null}
      <div className="term-exhibit-grid">
        <RunMatrix row={row} />
        {hasFacts ? (
          <dl className="term-facts">
            {diff ? (
              <div>
                <dt>Differential</dt>
                <dd>
                  <span className={`term-state term-state--${diff.look.cls}`}>
                    {diff.look.label}
                  </span>
                  <span className="term-facts-line">{diff.line}</span>
                </dd>
              </div>
            ) : null}
            {row.family ? (
              <div>
                <dt>Family</dt>
                <dd>
                  <span className="term-family">
                    {row.family.map((ok, i) => (
                      <span
                        key={i}
                        className={ok ? 'term-cell term-cell--pass' : 'term-cell term-cell--fail'}
                      >
                        <span aria-hidden="true">{ok ? 'P' : 'F'}</span>
                        <span className="sr-only">{`parameter ${i + 1} ${passFail(ok)}, `}</span>
                      </span>
                    ))}
                  </span>
                  <span className="term-facts-line">{`${row.family.filter(Boolean).length} of ${row.family.length} pass`}</span>
                </dd>
              </div>
            ) : null}
            {row.egressAttempts !== undefined ? (
              <div>
                <dt>Egress</dt>
                <dd className="term-num-left">{`${int(row.egressAttempts)} attempts`}</dd>
              </div>
            ) : null}
            {row.durationMs !== undefined ? (
              <div>
                <dt>Judge time</dt>
                <dd className="term-num-left">{ms(row.durationMs)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

function EvidenceBody({ rows }: { rows: readonly EvidenceRow[] }) {
  if (rows.length === 0) return <p className="term-dim">No exhibits have been filed.</p>;
  return (
    <>
      {rows.map((row, i) => (
        <ExhibitBlock key={i} row={row} />
      ))}
    </>
  );
}

function VerifyBody({ view }: { view: TerminalView }) {
  if (view.verify.length === 0)
    return (
      <p className="term-dim">
        {view.awaitingVerification
          ? 'Judge verification event not yet recorded. Nothing in the record says the fix failed.'
          : 'No Judge patch check is recorded.'}
      </p>
    );
  return (
    <>
      {view.verify.map((row, i) => (
        <VerifyRound key={i} row={row} round={i + 1} />
      ))}
    </>
  );
}

function VerifyRound({ row, round }: { row: VerifyRow; round: number }) {
  const state: Look = !row.counts
    ? { label: 'DOES NOT COUNT', cls: 'warn' }
    : row.accepted
      ? { label: 'ACCEPTED', cls: 'pos' }
      : { label: 'NOT ACCEPTED', cls: 'neg' };
  return (
    <div className={row.counts ? 'term-round' : 'term-round term-round--void'}>
      <div className="term-round-head">
        <SubHeading>{`Round ${round}`}</SubHeading>
        <span className="term-dim">{`seq ${row.seq}`}</span>
        <span className="term-id">{row.patchExhibitId}</span>
        <span className={`term-state term-state--${state.cls}`}>{state.label}</span>
      </div>
      {!row.counts ? (
        <p className="term-void-note">
          Does not count: this is not the Judge&apos;s own check in the verify stage before the
          verdict. It cannot earn or remove the VERIFIED stamp.
        </p>
      ) : null}
      <ul className="term-checks">
        {row.checks.map((c, i) => (
          <li key={i}>
            <Res ok={c.ok} />
            <span className="term-check-label">{pick(CHECK_LABEL, c.check, c.check)}</span>
          </li>
        ))}
        {row.counterexamples.map((c, i) => (
          <li key={`cx-${i}`} className="term-check-sub">
            <Res ok={!c.survived} />
            <span className="term-check-label">
              <span className="term-id">{c.exhibitId}</span>
              {c.survived
                ? ' still works against the patched code'
                : ' no longer works against the patched code'}
            </span>
          </li>
        ))}
      </ul>
      {row.rejectedBy ? <p className="term-reason">{ruleText(row.rejectedBy)}</p> : null}
    </div>
  );
}

const DIFF_MARK: Readonly<Record<string, { mark: string; word: string; cls: string }>> = {
  add: { mark: '+', word: 'added', cls: 'add' },
  del: { mark: '-', word: 'removed', cls: 'del' },
  ctx: { mark: ' ', word: 'unchanged', cls: 'ctx' },
};

function DiffBody({ diff, patchIds }: { diff: DiffView | undefined; patchIds: readonly string[] }) {
  if (!diff)
    return (
      <div>
        <p className="term-dim">
          The patch content is not in the record. Only the Judge&apos;s results for a patch can be
          shown here.
        </p>
        {patchIds.length > 0 ? (
          <p className="term-dim">
            {'Patch on record: '}
            <Ids ids={patchIds} label="" />
          </p>
        ) : null}
      </div>
    );
  return (
    <>
      <p className="term-diff-files">
        <span className="term-id">{diff.exhibitId}</span>
        {diff.filesTouched.map((f, i) => (
          <span key={i} className="term-diff-path">
            {f}
          </span>
        ))}
      </p>
      <Scroll label="Patch diff, scrolls sideways" className="term-diff-scroll">
        <table className="term-diff">
          <caption className="sr-only">{`Patch ${diff.exhibitId} as submitted`}</caption>
          <thead>
            <tr>
              <th scope="col" className="term-num">
                old
              </th>
              <th scope="col" className="term-num">
                new
              </th>
              <th scope="col">
                <span className="sr-only">Change</span>
              </th>
              <th scope="col">line</th>
            </tr>
          </thead>
          <tbody>
            {diff.lines.map((line, i) => {
              if (line.kind === 'file' || line.kind === 'hunk')
                return (
                  <tr
                    key={i}
                    className={line.kind === 'file' ? 'term-diff-file' : 'term-diff-hunk'}
                  >
                    <td colSpan={4}>
                      <span className="sr-only">{line.kind === 'file' ? 'File ' : 'Hunk '}</span>
                      {line.text}
                    </td>
                  </tr>
                );
              const m = pick(DIFF_MARK, line.kind, {
                mark: '?',
                word: 'unknown change',
                cls: 'ctx',
              });
              return (
                <tr key={i} className={`term-diff-line term-diff-line--${m.cls}`}>
                  <td className="term-diff-no">{line.oldNo ?? ''}</td>
                  <td className="term-diff-no">{line.newNo ?? ''}</td>
                  <td className="term-diff-mark">
                    <span aria-hidden="true">{m.mark}</span>
                    <span className="sr-only">{m.word}</span>
                  </td>
                  <td className="term-diff-text">{line.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}

function StateTag({ state }: { state: string }) {
  const look = pick(EVIDENCE_STATE, state, { label: state, cls: 'pending' });
  return <span className={`term-state term-state--${look.cls}`}>{look.label}</span>;
}

/** What the Judge's counting patch checks say about one exhibit, in static words. */
function verifyRuling(row: EvidenceRow, verify: readonly VerifyRow[]): string | undefined {
  const counting = verify.filter((v) => v.counts);
  if (row.kind === 'patch') {
    const last = counting.filter((v) => v.patchExhibitId === row.id).at(-1);
    if (!last) return undefined;
    return last.accepted ? 'patch check passed' : 'patch check failed';
  }
  if (row.kind === 'counterexample') {
    for (const v of [...counting].reverse()) {
      const hit = v.counterexamples.find((c) => c.exhibitId === row.id);
      if (hit) return hit.survived ? 'survives the patch' : 'defeated by the patch';
    }
  }
  return undefined;
}

function ArgumentsBody({ view, bubbles }: { view: TerminalView; bubbles: readonly Bubble[] }) {
  if (view.evidence.length === 0 && bubbles.length === 0)
    return (
      <p className="term-dim">No claims, objections, counterexamples or appeals are recorded.</p>
    );
  const stateOf = new Map(view.evidence.map((e) => [e.id, e.state] as const));
  return (
    <table className="term-args">
      <caption className="sr-only">Claims and the Judge&apos;s rulings on them</caption>
      <thead>
        <tr>
          <th scope="col">Claim</th>
          <th scope="col">Ruling</th>
        </tr>
      </thead>
      <tbody>
        {view.evidence.map((row, i) => {
          const extra = verifyRuling(row, view.verify);
          return (
            <tr key={`e-${i}`}>
              <td>
                <AgentChip role={row.author} />
                <span className="term-args-claim">
                  {`${pick(KIND_LABEL, row.kind, row.kind)} `}
                  <span className="term-id">{row.id}</span>
                  {` ${pick(KIND_CLAIM, row.kind, 'is filed')}`}
                </span>
              </td>
              <td>
                <AgentChip role="judge" />
                <span className="term-args-ruling">
                  <StateTag state={row.state} />
                  {row.rejectedBy ? ` ${row.rejectedBy}` : ''}
                  {extra ? `, ${extra}` : ''}
                </span>
              </td>
            </tr>
          );
        })}
        {bubbles.map((b) => (
          <tr key={`b-${b.id}`}>
            <td>
              <AgentChip role={b.agent} detail={b.agentDetail} />
              <span className="term-args-claim">{b.title}</span>
              {b.quote ? <span className="term-args-quote">{b.quote}</span> : null}
            </td>
            <td>
              {b.cites.length === 0 ? (
                <span className="term-dim">No exhibit cited, so no ruling attaches.</span>
              ) : (
                <ul className="term-args-cites">
                  {b.cites.map((id, i) => (
                    <li key={i}>
                      <span className="term-id">{id}</span>{' '}
                      {stateOf.has(id) ? (
                        <StateTag state={stateOf.get(id) ?? 'pending'} />
                      ) : (
                        <span className="term-dim">not in the record</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Confidence({ value }: { value: number }) {
  if (!Number.isFinite(value)) return <span>{METRIC}</span>;
  const filled = Math.round(Math.min(1, Math.max(0, value)) * 10);
  return (
    <span className="term-conf">
      <span aria-hidden="true" className="term-conf-fill">
        {'■'.repeat(filled)}
      </span>
      <span aria-hidden="true" className="term-conf-rest">
        {'□'.repeat(10 - filled)}
      </span>
      <span className="term-conf-n">{value.toFixed(2)}</span>
    </span>
  );
}

function JuryBody({ ballots }: { ballots: readonly BallotRow[] }) {
  if (ballots.length === 0) return <p className="term-dim">No ballots are recorded.</p>;
  return (
    <Scroll label="Ballots, scrolls sideways">
      <table className="term-jury">
        <caption className="sr-only">Ballots cast by the jury</caption>
        <thead>
          <tr>
            <th scope="col">Juror</th>
            <th scope="col">Mandate</th>
            <th scope="col">Question</th>
            <th scope="col">Vote</th>
            <th scope="col">Confidence</th>
            <th scope="col">Cites</th>
          </tr>
        </thead>
        <tbody>
          {ballots.map((b, i) => (
            <tr key={i}>
              <td>
                <span className="term-id">{b.jurorId}</span>
                <span className="term-sub">{b.model}</span>
                <span className="term-sub">{`input ${b.inputVariant}`}</span>
              </td>
              <td>{b.mandate}</td>
              <td>{b.question}</td>
              <td className="term-vote">{b.vote}</td>
              <td>
                <Confidence value={b.confidence} />
              </td>
              <td>
                <Ids ids={b.citedExhibits} label="" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function CostBody({ cost }: { cost: CostView }) {
  const none = cost.rows.length === 0;
  return (
    <>
      <Scroll label="Cost by stage, scrolls sideways">
        <table className="term-cost">
          <caption className="sr-only">Cost charged per stage attempt</caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col" className="term-num">
                Att
              </th>
              <th scope="col" className="term-num">
                Tok in
              </th>
              <th scope="col" className="term-num">
                Tok out
              </th>
              <th scope="col" className="term-num">
                USD
              </th>
              <th scope="col" className="term-num">
                Wall
              </th>
            </tr>
          </thead>
          <tbody>
            {none ? (
              <tr>
                <td className="term-dim">none recorded</td>
                {[0, 1, 2, 3, 4].map((i) => (
                  <td key={i} className="term-num term-dim">
                    {METRIC}
                  </td>
                ))}
              </tr>
            ) : (
              cost.rows.map((r, i) => (
                <tr key={i}>
                  <td>{pick(STAGE_LABEL, r.stage, r.stage)}</td>
                  <td className="term-num">{r.attempt}</td>
                  <td className="term-num">{int(r.inputTokens)}</td>
                  <td className="term-num">{int(r.outputTokens)}</td>
                  <td className="term-num">{usd(r.usd)}</td>
                  <td className="term-num">{ms(r.wallMs)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                Total
              </th>
              <td className="term-num">{none ? METRIC : int(cost.total.inputTokens)}</td>
              <td className="term-num">{none ? METRIC : int(cost.total.outputTokens)}</td>
              <td className="term-num">{none ? METRIC : usd(cost.total.usd)}</td>
              <td className="term-num">{none ? METRIC : ms(cost.total.wallMs)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={2}>
                Budget left
              </th>
              <td className="term-num">
                {cost.remaining ? int(cost.remaining.inputTokens) : METRIC}
              </td>
              <td className="term-num">
                {cost.remaining ? int(cost.remaining.outputTokens) : METRIC}
              </td>
              <td className="term-num">{cost.remaining ? usd(cost.remaining.usd) : METRIC}</td>
              <td className="term-num">
                {cost.remaining?.exhausted ? (
                  <span className="term-state term-state--warn">EXHAUSTED</span>
                ) : (
                  ''
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </Scroll>
    </>
  );
}

function TapeBody({ tape }: { tape: readonly TapeRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const count = tape.length;
  // Newest row is at the bottom; keep it in view as the record grows or the scrubber moves.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div
      ref={ref}
      className="term-scroll term-tape-scroll"
      role="group"
      aria-label="Event tape, newest last"
      tabIndex={0}
    >
      {count === 0 ? (
        <p className="term-dim">No events are recorded.</p>
      ) : (
        <table className="term-tape">
          <caption className="sr-only">Recorded events in order</caption>
          <thead>
            <tr>
              <th scope="col" className="term-num">
                Seq
              </th>
              <th scope="col">Time</th>
              <th scope="col">Stage</th>
              <th scope="col">Actor</th>
              <th scope="col">Event</th>
            </tr>
          </thead>
          <tbody>
            {tape.map((row, i) => {
              const tone = pick(TONES, row.tone, NEUTRAL);
              const actor = agentLook(row.actor);
              return (
                <tr key={i}>
                  <td className="term-num term-dim">{row.seq}</td>
                  <td className="term-dim">{clock(row.at)}</td>
                  <td className="term-dim">{pick(STAGE_LABEL, row.stage, row.stage)}</td>
                  <td className={`term-actor term-actor--${actor.cls}`}>{actor.label}</td>
                  <td className="term-tape-text">
                    <span className={`term-tone term-tone--${tone.cls}`} aria-hidden="true">
                      {tone.glyph}
                    </span>
                    {tone.word ? <span className="sr-only">{tone.word}</span> : null}
                    {row.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function statusLook(view: TerminalView): Look {
  // The verified look comes only from the view's own `verified` flag, never from status text.
  if (view.verified) return { label: 'VERIFIED', cls: 'verified' };
  const stamp = pick<{ text: string; tone: string }>(
    STATUS_STAMP,
    view.status === 'verified' ? 'unverified' : view.status,
    { text: view.status, tone: 'plain' },
  );
  return { label: stamp.text, cls: stamp.tone === 'warn' ? 'warn' : 'plain' };
}

function VerdictBody({ view, verdict }: { view: TerminalView; verdict: VerdictView | undefined }) {
  const status = statusLook(view);
  if (!verdict)
    return (
      <>
        <p className="term-verdict-line">
          <span className={`term-stamp term-stamp--${status.cls}`}>{status.label}</span>
        </p>
        <p className="term-dim">No verdict is recorded yet.</p>
      </>
    );
  const outcome = pick(OUTCOME, verdict.outcome, { label: verdict.outcome, cls: 'neutral' });
  return (
    <>
      <p className="term-verdict-line">
        <span className={`term-outcome term-outcome--${outcome.cls}`}>{outcome.label}</span>
        <span className={`term-stamp term-stamp--${status.cls}`}>{status.label}</span>
      </p>
      {view.awaitingVerification ? (
        <p className="term-dim">
          Judge verification event not yet recorded. Nothing in the record says the fix failed.
        </p>
      ) : null}
      <dl className="term-kv">
        <div>
          <dt>Severity</dt>
          <dd>{verdict.severity ?? 'not recorded'}</dd>
        </div>
        <div>
          <dt>Juror corr</dt>
          <dd>
            {verdict.jurorCorrelation !== undefined ? verdict.jurorCorrelation.toFixed(2) : METRIC}
          </dd>
        </div>
        <div>
          <dt>Bundle</dt>
          <dd className="term-hash">{verdict.bundleSha256 ?? 'not recorded'}</dd>
        </div>
        <div>
          <dt>Exhibits</dt>
          <dd>
            {verdict.exhibits.length > 0 ? <Ids ids={verdict.exhibits} label="" /> : 'none cited'}
          </dd>
        </div>
      </dl>
      {verdict.models.length > 0 ? (
        <table className="term-models">
          <caption className="sr-only">Models and prompt versions that ran</caption>
          <thead>
            <tr>
              <th scope="col">Prompt</th>
              <th scope="col">Model</th>
              <th scope="col">Ver</th>
            </tr>
          </thead>
          <tbody>
            {verdict.models.map((m, i) => (
              <tr key={i}>
                <td>{m.prompt}</td>
                <td>{m.model ?? <span className="term-dim">not recorded</span>}</td>
                <td>{m.version ?? <span className="term-dim">not recorded</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="term-dim">No models or prompt versions are recorded.</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The terminal

const PANEL_IDS = Object.keys(PANEL_TITLE) as PanelId[];

function groupBubbles(bubbles: readonly Bubble[]): Record<PanelId, Bubble[]> {
  const out = Object.fromEntries(PANEL_IDS.map((id) => [id, [] as Bubble[]])) as Record<
    PanelId,
    Bubble[]
  >;
  // A bubble with an anchor this view does not know still shows: it lands on the tape.
  for (const b of [...bubbles].sort((a, z) => a.seq - z.seq)) pick(out, b.anchor, out.tape).push(b);
  return out;
}

export function Terminal({
  view,
  toolbar,
  embedded = false,
}: {
  view: TerminalView;
  toolbar?: ReactNode;
  /** Inside a page with its own h1: the title becomes an h2 and panel headings h3. */
  embedded?: boolean;
}) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const notes = useMemo(() => groupBubbles(view.bubbles), [view.bubbles]);
  const status = statusLook(view);
  const done = view.stages.filter((s) => s.state === 'done').length;
  const active = view.stages.find((s) => s.state === 'active');
  const admitted = view.evidence.filter((e) => e.state === 'admitted').length;
  const counting = view.verify.filter((v) => v.counts);
  const lastCheck = counting.at(-1);
  const patchIds = view.evidence.filter((e) => e.kind === 'patch').map((e) => e.id);
  const argCount = view.evidence.length + notes.arguments.length;

  return (
    <EmbeddedContext.Provider value={embedded}>
      <article className="term" aria-labelledby={titleId}>
        <div className="term-status">
          {embedded ? (
            <h2 id={titleId} className="term-title">
              <span className="term-brand">Affidavit</span> trial terminal
            </h2>
          ) : (
            <h1 id={titleId} className="term-title">
              <span className="term-brand">Affidavit</span> trial terminal
            </h1>
          )}
          <dl className="term-status-fields">
            <div>
              <dt>Case</dt>
              <dd>{view.caseId}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd className={`term-stamp term-stamp--${status.cls}`}>{status.label}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>{int(view.eventCount)}</dd>
            </div>
            <div>
              <dt>Last seq</dt>
              <dd>{view.eventCount > 0 ? int(view.lastSeq) : 'none'}</dd>
            </div>
          </dl>
        </div>
        {toolbar}

        <div className="term-grid">
          <Panel
            id="stages"
            uid={uid}
            bubbles={notes.stages}
            meta={`${done}/${view.stages.length} done${active ? `, active ${pick(STAGE_LABEL, active.stage, active.stage)}` : ''}`}
          >
            <StageRail stages={view.stages} />
          </Panel>

          <Panel
            id="evidence"
            uid={uid}
            bubbles={notes.evidence}
            meta={`${view.evidence.length} exhibits, ${admitted} admitted`}
          >
            <EvidenceBody rows={view.evidence} />
          </Panel>

          <Panel
            id="verify"
            uid={uid}
            bubbles={notes.verify}
            meta={
              lastCheck
                ? `${view.verify.length} rounds, last ${lastCheck.accepted ? 'accepted' : 'not accepted'}`
                : `${view.verify.length} rounds`
            }
          >
            <VerifyBody view={view} />
          </Panel>

          <Panel
            id="diff"
            uid={uid}
            bubbles={notes.diff}
            meta={
              view.diff ? (
                <>
                  {`${view.diff.filesTouched.length} files `}
                  <span className="term-add">{`+${view.diff.added}`}</span>{' '}
                  <span className="term-del">{`-${view.diff.removed}`}</span>
                  <span className="sr-only">{` (${view.diff.added} lines added, ${view.diff.removed} removed)`}</span>
                </>
              ) : (
                'not in the record'
              )
            }
          >
            <DiffBody diff={view.diff} patchIds={patchIds} />
          </Panel>

          <Panel id="arguments" uid={uid} bubbles={notes.arguments} meta={`${argCount} claims`}>
            <ArgumentsBody view={view} bubbles={notes.arguments} />
          </Panel>

          <Panel id="jury" uid={uid} bubbles={notes.jury} meta={`${view.ballots.length} ballots`}>
            <JuryBody ballots={view.ballots} />
          </Panel>

          <Panel
            id="cost"
            uid={uid}
            bubbles={notes.cost}
            meta={
              view.cost.rows.length > 0
                ? `${view.cost.rows.length} charges, ${usd(view.cost.total.usd)}`
                : METRIC
            }
          >
            <CostBody cost={view.cost} />
          </Panel>

          <Panel id="tape" uid={uid} bubbles={notes.tape} meta={`${view.tape.length} rows`}>
            <TapeBody tape={view.tape} />
          </Panel>

          <Panel id="verdict" uid={uid} bubbles={notes.verdict} meta={status.label}>
            <VerdictBody view={view} verdict={view.verdict} />
          </Panel>
        </div>
      </article>
    </EmbeddedContext.Provider>
  );
}

/**
 * The terminal with a position in the record: "show the record as of event N". It starts at the
 * latest event and follows new ones while it is there. Scrubbing back replays the argument.
 */
export function TerminalWithScrubber({
  events,
  content,
  embedded = false,
}: {
  events: readonly TrialEvent[];
  content?: readonly Exhibit[];
  embedded?: boolean;
}) {
  const uid = useId();
  const total = events.length;
  const first = Math.min(1, total);
  // null means "at latest": the position follows the record as it grows.
  const [pinned, setPinned] = useState<number | null>(null);
  const n = pinned === null ? total : Math.min(Math.max(pinned, first), total);
  const atLatest = n >= total;
  const go = (next: number) => setPinned(next >= total ? null : Math.max(first, next));
  const view = useMemo(() => buildTerminalView(events.slice(0, n), content), [events, n, content]);

  const toolbar = (
    <div className="term-scrub" role="group" aria-label="Position in the record">
      <label htmlFor={`${uid}-pos`}>Show the record as of event</label>
      <input
        id={`${uid}-pos`}
        type="range"
        min={first}
        max={total}
        step={1}
        value={n}
        disabled={total <= 1}
        onChange={(e) => go(Number(e.currentTarget.value))}
      />
      <p className="term-scrub-pos" data-testid="term-scrub-pos">
        {`Event ${n} of ${total}`}
        <span className="term-dim">{atLatest ? ', following latest' : ', paused'}</span>
      </p>
      <span className="term-scrub-buttons">
        <button
          type="button"
          onClick={() => go(n - 1)}
          disabled={n <= first}
          aria-label="Step back one event"
        >
          <span aria-hidden="true">{'◀'}</span> Back
        </button>
        <button
          type="button"
          onClick={() => go(n + 1)}
          disabled={atLatest}
          aria-label="Step forward one event"
        >
          Fwd <span aria-hidden="true">{'▶'}</span>
        </button>
        <button type="button" onClick={() => setPinned(null)} disabled={atLatest}>
          Latest
        </button>
      </span>
    </div>
  );
  return <Terminal view={view} toolbar={toolbar} embedded={embedded} />;
}
