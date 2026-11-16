import { useId, useState, type ReactNode } from 'react';
import type { CaseView, ExhibitView } from '../model/caseView.js';
import { REVIEW_REASON, STATUS_STAMP } from './status.js';

// Everything below renders case content (summaries, ids, details) as React text children only.
// Case content is untrusted: no raw HTML, no URLs or styles built from it.

export function Stamp({ view }: { view: CaseView }) {
  // The verified look comes only from the view model's own stamp field, never from status text.
  const { text, tone } =
    view.stamp === 'VERIFIED'
      ? ({ text: view.stamp, tone: 'verified' } as const)
      : view.status === 'verified'
        ? STATUS_STAMP.unverified
        : STATUS_STAMP[view.status];
  return <p className={`stamp stamp--${tone}`}>{text}</p>;
}

function Collapsible({
  level,
  title,
  meta,
  children,
}: {
  level: 2 | 3;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const panelId = `${uid}-panel`;
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="disclosure">
      <Heading>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? '- ' : '+ '}</span>
          {title}
          {meta ? <span className="muted">{`  ${meta}`}</span> : null}
        </button>
      </Heading>
      <div id={panelId} className="panel-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

function ExhibitDetail({ exhibit }: { exhibit: ExhibitView }) {
  return (
    <>
      <p className="meta">
        {exhibit.admitted
          ? 'Admitted by the Judge.'
          : `Not admitted by the Judge. Rule: ${exhibit.rejectedBy ?? 'not recorded'}.`}
      </p>
      {exhibit.runs.length === 0 ? (
        <p className="muted">No Judge runs are recorded for this exhibit.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption>{`Run log for ${exhibit.id}`}</caption>
            <thead>
              <tr>
                <th scope="col">Variant</th>
                <th scope="col">Attempt</th>
                <th scope="col">Result</th>
                <th scope="col">Exit code</th>
                <th scope="col">Duration ms</th>
                <th scope="col">Stdout sha256</th>
                <th scope="col">Stderr sha256</th>
              </tr>
            </thead>
            <tbody>
              {exhibit.runs.map((r) => (
                <tr key={`${r.variant}-${r.attempt}`}>
                  <td className="mono">{r.variant}</td>
                  <td>{r.attempt}</td>
                  <td>{r.passed ? 'pass' : 'fail'}</td>
                  <td>{r.exitCode}</td>
                  <td>{r.durationMs}</td>
                  <td className="mono hash">{r.stdoutSha256}</td>
                  <td className="mono hash">{r.stderrSha256}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function CaseFile({ view, slug }: { view: CaseView; slug?: string }) {
  return (
    <article aria-labelledby="page-heading">
      <p className="label">{`Case file ${slug ?? view.caseId}`}</p>
      <h1 id="page-heading">{view.headline}</h1>
      <Stamp view={view} />

      <section aria-labelledby="summary-heading">
        <h2 id="summary-heading">Summary</h2>
        <p className="label">Court summary</p>
        <p>{view.summary}</p>
        {view.status === 'unverified' && view.stampWithheld.length > 0 ? (
          <div className="panel">
            <h3>Why this is not verified</h3>
            <ul>
              {view.stampWithheld.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="meta muted">Cost: [metric]. Time to verdict: [metric].</p>
      </section>

      {view.humanReview ? (
        <section className="panel panel--review" aria-labelledby="review-heading">
          <h2 id="review-heading">Human review needed</h2>
          <p>{REVIEW_REASON[view.humanReview.reason]}</p>
          <p>
            <span className="label">Recorded detail</span>
            <br />
            {view.humanReview.detail}
          </p>
          <p>
            <span className="label">Next steps</span>
          </p>
          <ul>
            {view.humanReview.nextSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="exhibits-heading">
        <h2 id="exhibits-heading">{`Exhibits (${view.exhibits.length})`}</h2>
        {view.exhibits.length === 0 ? (
          <p className="muted">No exhibits have been filed.</p>
        ) : (
          view.exhibits.map((x) => (
            <Collapsible
              key={x.id}
              level={3}
              title={x.id}
              meta={`${x.kind}, ${x.admitted ? 'admitted' : 'not admitted'}`}
            >
              <ExhibitDetail exhibit={x} />
            </Collapsible>
          ))
        )}
      </section>

      <section aria-label="Docket">
        <Collapsible level={2} title="Docket" meta={`${view.docket.length} entries`}>
          <ol className="docket">
            {view.docket.map((d) => (
              <li key={d.seq}>
                <span className="mono muted">{`#${d.seq} ${d.stage} `}</span>
                {d.label}
                <span className="mono muted">{`  ${d.at}`}</span>
              </li>
            ))}
          </ol>
        </Collapsible>
      </section>
    </article>
  );
}
