/**
 * L1-05 acceptance on OWASP NodeGoat at the pinned commit.
 *
 * Needs a checkout of the pinned tree. Either:
 *   AFFIDAVIT_CORPUS_NETWORK=1                fetch it (git and github.com; verified by commit,
 *                                              tree and archive hash, the same fetch the corpus
 *                                              tests and the L1-04 regression use)
 *   AFFIDAVIT_MAP_NODEGOAT_DIR=<dir>          use an existing checkout of that commit
 * Skipped otherwise. Nothing from the checkout is executed.
 *
 *   PowerShell: $env:AFFIDAVIT_CORPUS_NETWORK = '1'
 *               pnpm --filter @affidavit/discovery exec vitest run map.nodegoat
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../tools/index.js';
import { buildMap, reachabilityFor, type MapCandidate, type RepoMap } from './index.js';

interface ExpectedRoute {
  method: string;
  path: string;
  middleware: string[];
  handlerFile: string;
  authRequired: boolean;
}
interface Expected {
  commit: string;
  appMiddleware: string[];
  routes: ExpectedRoute[];
  dataAccess: {
    kind: string;
    method: string;
    collection?: string;
    file: string;
    startLine: number;
  }[];
}
interface Label {
  id: string;
  cls: string;
  file: string;
  range: { startLine: number; endLine: number };
  route: { method: string; path: string; middleware: string[]; authRequired: boolean };
  reachability: 'reachable' | 'unreachable' | 'unknown';
}
interface FetchPinned {
  fetchPinned(opts: {
    repoUrl: string;
    commit: string;
    tree: string;
    archiveSha256: string;
    dest: string;
  }): Promise<void>;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const corpusDir = join(repoRoot(), 'packages', 'corpus', 'data', 'nodegoat');
const expected = readJson<Expected>(
  join(repoRoot(), 'fixtures', 'corpus', 'map', 'nodegoat-routes.json.fixture'),
);
const app = readJson<{ labels: Label[] }>(join(corpusDir, 'app.json'));
const pin = readJson<{
  repoUrl: string;
  commit: string;
  tree: string;
  archiveSha256: string;
}>(join(corpusDir, 'pin.json'));

const existing = process.env['AFFIDAVIT_MAP_NODEGOAT_DIR'];
const enabled = existing !== undefined || process.env['AFFIDAVIT_CORPUS_NETWORK'] === '1';

/** Runs offline: the hand-written list must at least agree with the corpus labels. */
describe('NodeGoat expected route list (fixture)', () => {
  it('is for the pinned commit', () => {
    expect(expected.commit).toBe(pin.commit);
  });

  it('has no duplicate method and path', () => {
    const keys = expected.routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('contains the route of every labeled issue, with the labeled middleware and auth flag', () => {
    for (const l of app.labels) {
      const r = expected.routes.find((x) => x.method === l.route.method && x.path === l.route.path);
      expect(r, `route for ${l.id}`).toBeDefined();
      expect(r?.middleware, l.id).toEqual(l.route.middleware);
      expect(r?.authRequired, l.id).toBe(l.route.authRequired);
    }
  });
});

describe.skipIf(!enabled)('map on NodeGoat at the pinned commit', { timeout: 300_000 }, () => {
  let work = '';
  let dir = '';
  let map: RepoMap;

  beforeAll(async () => {
    if (existing !== undefined) {
      dir = existing;
    } else {
      work = mkdtempSync(join(tmpdir(), 'affidavit-map-'));
      dir = join(work, 'nodegoat');
      const mod = (await import(
        pathToFileURL(join(repoRoot(), 'packages', 'corpus', 'scripts', 'fetch-pinned.mjs')).href
      )) as FetchPinned;
      await mod.fetchPinned({
        repoUrl: pin.repoUrl,
        commit: pin.commit,
        tree: pin.tree,
        archiveSha256: pin.archiveSha256,
        dest: dir,
      });
    }
    map = await buildMap({ root: dir });
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('extracts every expected route with its middleware, handler file and auth flag', () => {
    const got = map.routes.map((r) => ({
      method: r.route.method,
      path: r.route.path,
      middleware: r.route.middleware,
      handlerFile: r.route.handlerFile,
      authRequired: r.route.authRequired,
    }));
    expect(got).toEqual(expected.routes);
  });

  it('puts the application-wide middleware in front of every route, in order', () => {
    expect(map.routes.length).toBeGreaterThan(0);
    for (const r of map.routes) {
      expect(r.appMiddleware).toEqual(expected.appMiddleware);
      expect(r.mounted).toBe('app');
      expect(r.pathDynamic).toBe(false);
    }
  });

  it('does not put the error handler or the tutorial mount in any chain', () => {
    for (const r of map.routes) {
      expect(r.chain.map((c) => c.label)).not.toContain('ErrorHandler');
      expect(r.chain.map((c) => c.label)).not.toContain('tutorialRouter');
    }
  });

  it('finds the expected data-access calls', () => {
    for (const e of expected.dataAccess) {
      const hit = map.dataAccess.find(
        (d) => d.file === e.file && d.startLine === e.startLine && d.kind === e.kind,
      );
      expect(hit, `${e.kind} ${e.method} at ${e.file}:${e.startLine}`).toBeDefined();
      expect(hit?.method).toBe(e.method);
      if (e.collection !== undefined) expect(hit?.collection).toBe(e.collection);
    }
  });

  it('matches the label for the reachability of every labeled issue, with the labeled route', () => {
    const cands: MapCandidate[] = app.labels.map((l) => ({
      id: l.id,
      file: l.file,
      range: l.range,
    }));
    const results = reachabilityFor(map, cands);
    expect(results).toHaveLength(app.labels.length);
    for (const l of app.labels) {
      const r = results.find((x) => x.candidateId === l.id);
      expect(r?.reachability, l.id).toBe(l.reachability);
      expect(r?.reason, l.id).toBe('route-path');
      const viaLabeledRoute = r?.paths.find(
        (p) => p.method === l.route.method && p.path === l.route.path,
      );
      expect(
        viaLabeledRoute,
        `${l.id} reached through ${l.route.method} ${l.route.path}`,
      ).toBeDefined();
      expect(viaLabeledRoute?.middleware).toEqual(l.route.middleware);
      expect(viaLabeledRoute?.authRequired).toBe(l.route.authRequired);
      // The path ends in the function that holds the labeled lines.
      const last = viaLabeledRoute?.functions[viaLabeledRoute.functions.length - 1];
      expect(last?.file).toBe(l.file);
      expect(last?.startLine).toBeLessThanOrEqual(l.range.startLine);
      expect(last?.endLine).toBeGreaterThanOrEqual(l.range.endLine);
    }
  });

  it('walks the gate issue from the route handler into the data layer', () => {
    const gate = reachabilityFor(map, [
      {
        id: 'gate',
        file: 'app/data/allocations-dao.js',
        range: { startLine: 77, endLine: 79 },
      },
    ])[0];
    const names = gate?.paths[0]?.functions.map((f) => `${f.file}:${f.name}`);
    expect(names).toEqual([
      'app/routes/allocations.js:displayAllocations',
      'app/data/allocations-dao.js:getByUserIdAndThreshold',
      'app/data/allocations-dao.js:searchCriteria',
    ]);
  });

  it('reaches the error handler through its `use` registration, which is not a route', () => {
    expect(map.routes.some((r) => r.route.method === 'USE')).toBe(false);
    const r = reachabilityFor(map, [
      { id: 'error', file: 'app/routes/error.js', range: { startLine: 3, endLine: 13 } },
    ])[0];
    expect(r?.reachability).toBe('reachable');
    expect(r?.paths[0]?.method).toBe('USE');
  });

  it('never calls code no route reaches unreachable here: eval and a dynamic require leave the repo open', () => {
    // artifacts/db-reset.js is a start-up script that no route reaches. NodeGoat evals request
    // input and builds a require path from the environment, so the answer is unknown.
    const r = reachabilityFor(map, [
      { id: 'script', file: 'artifacts/db-reset.js', range: { startLine: 90, endLine: 90 } },
      { id: 'module-level', file: 'app/routes/session.js', range: { startLine: 1, endLine: 5 } },
    ]);
    for (const x of r) expect(x.reachability, x.candidateId).toBe('unknown');
    expect(map.coverage.complete).toBe(false);
    expect(map.coverage.leaks.map((l) => l.kind)).toEqual(
      expect.arrayContaining(['code-eval', 'dynamic-require']),
    );
  });
});
