import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listDir } from '../tools/walk.js';
import type { Detection, Framework, FrameworkEvidence, IngestUnsupported } from './types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100_000;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

const DEP_FRAMEWORKS: Record<string, Framework> = {
  express: 'express',
  koa: 'koa',
  fastify: 'fastify',
};

const JS_EXT = /\.(?:[cm]?js|jsx)$/i;
const TS_EXT = /\.(?:[cm]?ts|tsx)$/i;
const OTHER_EXT: Record<string, RegExp> = {
  python: /\.py$/i,
  go: /\.go$/i,
  ruby: /\.rb$/i,
  java: /\.(?:java|kt)$/i,
  php: /\.php$/i,
  rust: /\.rs$/i,
  csharp: /\.cs$/i,
};
const NEXT_ROUTE_FILE = /^route\.(?:[cm]?[jt]s|[jt]sx)$/i;

interface Walk {
  packageJsons: string[]; // repo-relative, posix
  /** Directory rel path (posix, '' for root) to the file names directly in it. */
  files: Map<string, string[]>;
  counts: { js: number; ts: number; other: Record<string, number> };
  /** The entry or depth cap was hit, so parts of the tree were not looked at. */
  truncated: boolean;
}

export interface WalkLimits {
  maxEntries?: number;
  maxDepth?: number;
}

async function walk(root: string, limits: WalkLimits): Promise<Walk> {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const out: Walk = {
    packageJsons: [],
    files: new Map(),
    counts: { js: 0, ts: 0, other: {} },
    truncated: false,
  };
  let seen = 0;
  const visit = async (rel: string, depth: number): Promise<void> => {
    const entries = await listDir(rel === '' ? root : join(root, rel));
    const names: string[] = [];
    for (const e of entries) {
      if (++seen > maxEntries) {
        out.truncated = true;
        return;
      }
      if (e.isDirectory) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (depth >= maxDepth) {
          out.truncated = true;
          continue;
        }
        await visit(rel === '' ? e.name : `${rel}/${e.name}`, depth + 1);
        continue;
      }
      if (!e.isFile) continue;
      names.push(e.name);
      if (e.name === 'package.json') {
        out.packageJsons.push(rel === '' ? e.name : `${rel}/${e.name}`);
      }
      if (TS_EXT.test(e.name) && !/\.d\.[cm]?ts$/i.test(e.name)) out.counts.ts++;
      else if (JS_EXT.test(e.name)) out.counts.js++;
      else {
        for (const [lang, re] of Object.entries(OTHER_EXT)) {
          if (re.test(e.name)) out.counts.other[lang] = (out.counts.other[lang] ?? 0) + 1;
        }
      }
    }
    out.files.set(rel, names);
  };
  await visit('', 0);
  out.packageJsons.sort();
  return out;
}

function depNames(pkg: unknown): string[] {
  if (typeof pkg !== 'object' || pkg === null) return [];
  const names: string[] = [];
  for (const key of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const block = (pkg as Record<string, unknown>)[key];
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      names.push(...Object.keys(block));
    }
  }
  return names;
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join2 = (a: string, b: string): string => (a === '' ? b : `${a}/${b}`);

/** Next API routes: pages/api (or src/pages/api) files, and app router `route` files. */
function nextRouteFiles(w: Walk, pkgDir: string): string[] {
  const found: string[] = [];
  for (const [dir, names] of w.files) {
    const under =
      pkgDir === ''
        ? dir
        : dir === pkgDir
          ? ''
          : dir.startsWith(`${pkgDir}/`)
            ? dir.slice(pkgDir.length + 1)
            : undefined;
    if (under === undefined) continue;
    const inPagesApi = /^(?:src\/)?pages\/api(?:\/|$)/.test(under);
    const inApp = /^(?:src\/)?app(?:\/|$)/.test(under);
    for (const n of names) {
      if (inPagesApi && (JS_EXT.test(n) || TS_EXT.test(n))) found.push(join2(dir, n));
      else if (inApp && NEXT_ROUTE_FILE.test(n)) found.push(join2(dir, n));
    }
  }
  return found.sort();
}

export type DetectOutcome =
  | { supported: true; detection: Detection }
  | { supported: false; unsupported: Omit<IngestUnsupported, 'commit' | 'status'> };

/**
 * Language and framework detection from the checked-out tree. The repo is data: package.json is
 * parsed with JSON.parse and only dependency NAMES are compared against a fixed list; nothing
 * from it is executed or echoed (evidence is repo paths only).
 */
export async function detectRepo(root: string, limits: WalkLimits = {}): Promise<DetectOutcome> {
  const w = await walk(root, limits);
  const observed: Record<string, number> = {
    javascript: w.counts.js,
    typescript: w.counts.ts,
    ...w.counts.other,
  };
  const fail = (
    reason: IngestUnsupported['reason'],
    detail: string,
  ): { supported: false; unsupported: Omit<IngestUnsupported, 'commit' | 'status'> } =>
    w.truncated
      ? {
          supported: false,
          unsupported: {
            reason: 'tree-too-large-to-scan',
            detail:
              'The tree is too large or too deep to scan fully, so no supported framework was found in the part that was read.',
            observed,
          },
        }
      : { supported: false, unsupported: { reason, detail, observed } };

  if (w.packageJsons.length === 0) {
    return fail('no-package-json', 'No package.json found, so this is not a Node.js project.');
  }
  if (w.counts.js + w.counts.ts === 0) {
    return fail(
      'no-js-ts-sources',
      'A package.json exists but there are no JavaScript or TypeScript sources.',
    );
  }

  const frameworks: FrameworkEvidence[] = [];
  const roots: string[] = [];
  let tsconfig = false;
  for (const pj of w.packageJsons) {
    const abs = join(root, pj);
    let pkg: unknown;
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.size > MAX_PACKAGE_JSON_BYTES) continue;
      pkg = JSON.parse(await readFile(abs, 'utf8'));
    } catch {
      continue; // unreadable or malformed: not a usable package root
    }
    const dir = dirOf(pj);
    roots.push(dir);
    if ((w.files.get(dir) ?? []).includes('tsconfig.json')) tsconfig = true;
    const names = new Set(depNames(pkg));
    for (const [dep, framework] of Object.entries(DEP_FRAMEWORKS)) {
      if (names.has(dep)) {
        frameworks.push({ framework, packageJson: pj, via: 'dependency', evidence: [] });
      }
    }
    if (names.has('next')) {
      const routes = nextRouteFiles(w, dir);
      if (routes.length > 0) {
        frameworks.push({
          framework: 'next-api',
          packageJson: pj,
          via: 'route-files',
          evidence: routes.slice(0, 10),
        });
      }
    }
  }

  if (frameworks.length === 0) {
    return fail(
      'no-supported-framework',
      'No Express, Koa, Fastify or Next API routes found. Only those are supported.',
    );
  }
  return {
    supported: true,
    detection: {
      language: tsconfig || w.counts.ts >= w.counts.js ? 'typescript' : 'javascript',
      frameworks,
      packageRoots: roots.sort(),
    },
  };
}
