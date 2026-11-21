import { Exhibit, TrialEvent } from '@affidavit/contracts';
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

// Exhibit content (witness code, patch diff) for fixture cases. The event stream carries only
// exhibit ids and the API has no exhibit content read yet, so only fixture cases have content.
const RAW_EXHIBITS = import.meta.glob<unknown>('../../../../fixtures/exhibits/*.exhibits.json', {
  eager: true,
  import: 'default',
});

const EXHIBITS_SUFFIX = '.exhibits.json';

const EXHIBITS = new Map<string, Exhibit[]>(
  Object.entries(RAW_EXHIBITS).map(([path, json]): [string, Exhibit[]] => [
    (path.split('/').pop() ?? path).slice(0, -EXHIBITS_SUFFIX.length),
    Exhibit.array().parse(json),
  ]),
);

/** Exhibit content for a case, or an empty array when no source has any. */
export function getCaseExhibits(slug: string): Exhibit[] {
  return [...(EXHIBITS.get(slug) ?? [])];
}

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
