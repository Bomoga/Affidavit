import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { CaseFile, Stamp } from './CaseFile.js';
import { CaseNotFoundError, loadCase, loadCaseList } from './data.js';

const caseListQuery = queryOptions({ queryKey: ['cases'], queryFn: loadCaseList });
const caseQuery = (slug: string) =>
  queryOptions({
    queryKey: ['case', slug],
    queryFn: () => loadCase(slug),
    retry: (count, error) => !(error instanceof CaseNotFoundError) && count < 2,
  });

export function CaseListPage() {
  const q = useQuery(caseListQuery);
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
              <Stamp status={view.status} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function CasePage() {
  const { caseId = '' } = useParams({ strict: false });
  const q = useQuery(caseQuery(caseId));
  if (q.isPending) return <p role="status">Loading case file.</p>;
  if (q.error instanceof CaseNotFoundError) return <NotFoundPage />;
  if (q.isError) return <p role="alert">This case file could not be loaded.</p>;
  return <CaseFile view={q.data} slug={caseId} />;
}

export function NotFoundPage() {
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
