import { queryOptions, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { buildCaseView } from '../model/caseView.js';
import { SAFE_CASE_ID, type BackoffPolicy, type StreamTransport } from '../model/liveStream.js';
import { CaseFile, ConnectionStatus, Stamp } from './CaseFile.js';
import { CaseNotFoundError, loadCase, loadCaseList } from './data.js';
import { useSourceConfig, useTrialStream } from './source.js';

const caseApi = getRouteApi('/cases/$caseId');

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

const caseListQuery = queryOptions({ queryKey: ['cases'], queryFn: loadCaseList });
const caseQuery = (slug: string) =>
  queryOptions({
    queryKey: ['case', slug],
    queryFn: () => loadCase(slug),
    retry: (count, error) => !(error instanceof CaseNotFoundError) && count < 2,
  });

export function CaseListPage() {
  useDocumentTitle('Case files - Affidavit');
  const live = useSourceConfig().mode === 'live';
  const q = useQuery({ ...caseListQuery, enabled: !live });
  if (live)
    return (
      <>
        <p className="label">Affidavit</p>
        <h1 id="page-heading">Case files</h1>
        <p>
          This view is connected to the live API, which has no list of cases. Open a case by its
          address, for example /cases/your-case-id.
        </p>
      </>
    );
  return (
    <>
      <p className="label">Affidavit</p>
      <h1 id="page-heading">Case files</h1>
      <p className="muted">
        Each case file records what the Court found, what the Judge admitted, and whether a fix was
        confirmed. Open one for a plain-language summary first.
      </p>
      {q.isPending ? (
        <p role="status">Loading case files.</p>
      ) : q.isError ? (
        <p role="alert">The case files could not be loaded.</p>
      ) : (
        <ul className="case-list" aria-label="Case files">
          {q.data.map(({ slug, view }) => (
            <li key={slug}>
              <Link to="/cases/$caseId" params={{ caseId: slug }} className="mono">
                {slug}
              </Link>
              <p>{view.headline}</p>
              <Stamp view={view} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function CasePage() {
  const { caseId } = caseApi.useParams();
  const source = useSourceConfig();
  if (source.mode === 'live') {
    // The id goes into a URL path, so anything outside the safe set is treated as not found.
    return SAFE_CASE_ID.test(caseId) ? (
      <LiveCasePage
        caseId={caseId}
        transport={source.transport}
        {...(source.backoff ? { backoff: source.backoff } : {})}
        {...(source.maxEvents ? { maxEvents: source.maxEvents } : {})}
      />
    ) : (
      <NotFoundPage />
    );
  }
  return <FixtureCasePage caseId={caseId} />;
}

function LiveCasePage({
  caseId,
  transport,
  backoff,
  maxEvents,
}: {
  caseId: string;
  transport: StreamTransport;
  backoff?: BackoffPolicy;
  maxEvents?: number;
}) {
  const { snapshot, retry } = useTrialStream(caseId, transport, backoff, maxEvents);
  const view = useMemo(() => buildCaseView(snapshot.events), [snapshot.events]);
  useDocumentTitle(
    snapshot.status === 'not-found'
      ? 'Case file not found - Affidavit'
      : `${view.headline} - Affidavit`,
  );
  // The server said no such case (or no access to it); say so plainly and do not retry.
  if (snapshot.status === 'not-found') return <NotFoundPage />;
  return (
    <CaseFile
      view={view}
      slug={caseId}
      connection={
        <ConnectionStatus
          status={snapshot.status}
          dropped={snapshot.invalidCount}
          tooLong={snapshot.tooLong}
          onRetry={retry}
        />
      }
    />
  );
}

function FixtureCasePage({ caseId }: { caseId: string }) {
  const q = useQuery(caseQuery(caseId));
  const title = q.data
    ? `${q.data.headline} - Affidavit`
    : q.error instanceof CaseNotFoundError
      ? 'Case file not found - Affidavit'
      : q.isError
        ? 'Case file could not be loaded - Affidavit'
        : 'Loading case file - Affidavit';
  useDocumentTitle(title);
  if (q.isPending)
    return (
      <>
        <h1 id="page-heading">Loading case file</h1>
        <p role="status">Loading case file.</p>
      </>
    );
  if (q.error instanceof CaseNotFoundError) return <NotFoundPage />;
  if (q.isError)
    return (
      <>
        <h1 id="page-heading">Case file could not be loaded</h1>
        <p role="alert">This case file could not be loaded.</p>
      </>
    );
  return <CaseFile view={q.data} slug={caseId} />;
}

export function NotFoundPage() {
  useDocumentTitle('Case file not found - Affidavit');
  return (
    <>
      <h1 id="page-heading">Case file not found</h1>
      <p>There is no case file at this address.</p>
      <p>
        <Link to="/">Back to all case files</Link>
      </p>
    </>
  );
}
