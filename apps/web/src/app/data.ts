import { TrialEvent } from '@affidavit/contracts';
import { buildCaseView, type CaseView } from '../model/caseView.js';
import { createFakeEventSource } from '../model/source.js';

// The fixtures are generated at the repo root. @affidavit/testing reads them with node:fs, which
// a browser bundle cannot do, so Vite inlines the same JSON files here. A test checks both
// loaders agree.
const RAW = import.meta.glob<unknown>('../../../../fixtures/trials/*.events.json', {
  eager: true,
  import: 'default',
});

const SUFFIX = '.events.json';

const EVENTS = new Map<string, TrialEvent[]>(
  Object.entries(RAW)
    .map(([path, json]): [string, TrialEvent[]] => [
      (path.split('/').pop() ?? path).slice(0, -SUFFIX.length),
      TrialEvent.array().parse(json),
    ])
    .sort(([a], [b]) => a.localeCompare(b)),
);

export function listCaseSlugs(): string[] {
  return [...EVENTS.keys()];
}

export function getCaseEvents(slug: string): TrialEvent[] | undefined {
  return EVENTS.get(slug);
}

export interface CaseListItem {
  slug: string;
  view: CaseView;
}

export class CaseNotFoundError extends Error {
  constructor() {
    super('No case file with that id');
    this.name = 'CaseNotFoundError';
  }
}

/** Reads a case through the fake SSE source, the same path the live stream will use. */
export async function loadCase(slug: string): Promise<CaseView> {
  const events = getCaseEvents(slug);
  if (!events) throw new CaseNotFoundError();
  const seen: TrialEvent[] = [];
  for await (const e of createFakeEventSource(events).subscribe()) seen.push(e);
  return buildCaseView(seen);
}

export async function loadCaseList(): Promise<CaseListItem[]> {
  return Promise.all(listCaseSlugs().map(async (slug) => ({ slug, view: await loadCase(slug) })));
}
