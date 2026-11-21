/**
 * L1-07, case file assembly. Takes one arraigned candidate (L1-06), the redacted workspace from
 * ingestion (L1-01) and the map's answer (L1-05), and builds a contract `CaseFile`: cleaned
 * slices (see `slice.ts`), the route, the redactions, boot hints and, when the corpus has one for
 * this exact tree and issue, the known-safe variant. The result is validated with the contract
 * before it is returned.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  BootHints,
  CaseFile,
  type CaseId,
  type Redaction,
  type RepoId,
  type Slice,
  type TargetRef,
  type TenantId,
  type VulnClass,
} from '@affidavit/contracts';
import type { Arraigned } from '../arraign/index.js';
import { routeInfoOf, type FnRef, type ReachPath } from '../map/index.js';
import { cleanSource, safeName, sliceOf, type CleanFile } from './slice.js';

export {
  cleanSource,
  escapeInvisible,
  isProse,
  PROSE_MARKER,
  proseIdentifier,
  proseRegex,
  provenCode,
  safeName,
  sliceOf,
  WITHHELD_MARKER,
  type CleanFile,
  type NameKind,
  type SliceOptions,
} from './slice.js';

/** The part of a corpus app (`@affidavit/corpus` `CorpusApp`) assembly reads. */
export interface CorpusAppLike {
  id: string;
  repo: string;
  pin: { commit: string };
  bootHints: BootHints;
  labels: readonly {
    id: string;
    cls: VulnClass;
    file: string;
    range: { startLine: number; endLine: number };
  }[];
  safeVariants: readonly { id: string; fixes: string; target: TargetRef; bootHints: BootHints }[];
}

export interface AssembleInput {
  caseId: CaseId;
  tenantId: TenantId;
  repo: RepoId;
  /** The pinned commit the workspace was checked out at (ingestion verified it). */
  commit: string;
  /** The redacted workspace from ingestion. Slices are read from here only. */
  workspacePath: string;
  /** `IngestOk.redactions`: copied into the case file as they are (locations, never values). */
  redactions: readonly Redaction[];
  /** `IngestOk.redactor.apply`, applied to every slice as a second line of defence. */
  redact?: ((s: string) => string) | undefined;
  arraigned: Arraigned;
  /** The corpus entry for this repo, when there is one. */
  corpus?: CorpusAppLike | undefined;
  /** Used when the corpus gives none. Required then: the contract needs boot hints. */
  bootHints?: BootHints | undefined;
}

export interface AssembleResult {
  caseFile: CaseFile;
  /** Corpus label the candidate matched, if any. */
  labelId?: string;
  /** Corpus safe variant attached, if any. */
  safeVariantId?: string;
  /** Files whose slice was withheld because they did not parse cleanly. */
  withheld: string[];
}

export class MissingBootHintsError extends Error {
  constructor() {
    super('no boot hints: the corpus has none for this repo and none were given');
    this.name = 'MissingBootHintsError';
  }
}

export class CaseFileInvalidError extends Error {
  constructor(public readonly issues: string[]) {
    super(`assembled case file does not validate: ${issues.join('; ')}`);
    this.name = 'CaseFileInvalidError';
  }
}

/** Lines in one slice. A longer function is cut around the lines that matter. */
export const MAX_SLICE_LINES = 80;
/** Slices per case file (the sink function plus the route path in front of it). */
export const MAX_SLICES = 6;
/** Lines of context around the candidate when its function is too long to show whole. */
const CONTEXT = 10;
const MAX_SOURCE_BYTES = 1024 * 1024;

const overlaps = (
  a: { startLine: number; endLine: number },
  b: { startLine: number; endLine: number },
): boolean => a.startLine <= b.endLine && a.endLine >= b.startLine;

/** The route to show: the shortest reaching path that is a real route (not a `use` entry). */
function chosenPath(a: Arraigned): ReachPath | undefined {
  if (a.reach.reachability !== 'reachable') return undefined;
  return a.reach.paths.find((p) => p.method !== 'USE') ?? undefined;
}

interface Want {
  file: string;
  startLine: number;
  endLine: number;
}

function fnWindow(fn: FnRef, focus?: { startLine: number; endLine: number }): Want {
  if (fn.endLine - fn.startLine + 1 <= MAX_SLICE_LINES) {
    return { file: fn.file, startLine: fn.startLine, endLine: fn.endLine };
  }
  if (focus) {
    const startLine = Math.max(fn.startLine, focus.startLine - CONTEXT);
    return {
      file: fn.file,
      startLine,
      endLine: Math.min(fn.endLine, focus.endLine + CONTEXT, startLine + MAX_SLICE_LINES - 1),
    };
  }
  return { file: fn.file, startLine: fn.startLine, endLine: fn.startLine + MAX_SLICE_LINES - 1 };
}

/** Which line ranges to slice, sink first, then the route path from the handler inward. */
function wanted(a: Arraigned, path: ReachPath | undefined): Want[] {
  const c = a.candidate;
  const out: Want[] = [];
  const add = (w: Want): void => {
    if (out.length >= MAX_SLICES) return;
    if (
      out.some((o) => o.file === w.file && o.startLine <= w.startLine && o.endLine >= w.endLine)
    ) {
      return;
    }
    out.push(w);
  };
  const fn = a.reach.fn;
  if (fn && fn.file === c.file && overlaps(fn, c.range)) add(fnWindow(fn, c.range));
  else {
    add({
      file: c.file,
      startLine: Math.max(1, c.range.startLine - CONTEXT),
      endLine: c.range.endLine + CONTEXT,
    });
  }
  for (const f of path?.functions ?? []) add(fnWindow(f));
  // A slice inside a later, larger one is dropped; if it was the sink slice, the larger one takes
  // its place at the front, so the sink is always shown first.
  const inside = (a: Want, b: Want): boolean =>
    a !== b && a.file === b.file && b.startLine <= a.startLine && b.endLine >= a.endLine;
  const kept = out.filter((w) => !out.some((o) => inside(w, o)));
  const sink = out[0];
  const holder = sink && kept.find((k) => k === sink || inside(sink, k));
  return holder ? [holder, ...kept.filter((k) => k !== holder)] : kept;
}

/** Reads a workspace file without following links, refusing paths that leave the workspace. */
async function readWorkspaceFile(root: string, file: string): Promise<string | undefined> {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) return undefined;
  const base = resolve(root);
  const full = resolve(base, file);
  const rel = relative(base, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  let handle;
  try {
    handle = await open(join(base, rel), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.includes(0)) return undefined;
    return b.toString('utf8').replace(/^\ufeff/, '');
  } finally {
    await handle.close();
  }
}

/** The corpus label and safe variant for this candidate, only for the exact pinned tree. */
function corpusMatch(input: AssembleInput): {
  labelId?: string;
  safe?: CorpusAppLike['safeVariants'][number];
} {
  const app = input.corpus;
  if (!app || app.repo !== input.repo || app.pin.commit !== input.commit) return {};
  const c = input.arraigned.candidate;
  const label = app.labels.find(
    (l) => l.file === c.file && l.cls === c.cls && overlaps(l.range, c.range),
  );
  if (!label) return {};
  const safe = app.safeVariants.find((v) => v.fixes === label.id);
  return safe ? { labelId: label.id, safe } : { labelId: label.id };
}

export async function assembleCaseFile(input: AssembleInput): Promise<AssembleResult> {
  const { arraigned: a } = input;
  const path = chosenPath(a);
  const match = corpusMatch(input);
  const bootHints =
    input.corpus && input.corpus.repo === input.repo && input.corpus.pin.commit === input.commit
      ? input.corpus.bootHints
      : input.bootHints;
  if (!bootHints) throw new MissingBootHintsError();

  const cleaned = new Map<string, CleanFile>();
  const withheld: string[] = [];
  const slices: Slice[] = [];
  for (const w of wanted(a, path)) {
    let clean = cleaned.get(w.file);
    if (!clean) {
      const text = await readWorkspaceFile(input.workspacePath, w.file);
      clean =
        text === undefined
          ? { text: undefined, commentsRemoved: 0, proseRemoved: 0 }
          : await cleanSource(w.file, text);
      cleaned.set(w.file, clean);
      if (clean.text === undefined) withheld.push(w.file);
    }
    slices.push(sliceOf(safeName('file', w.file), clean, w, { redact: input.redact }));
  }

  // Every repo-derived name that reaches the case file goes through `safeName` (strict charset,
  // no prose-like parts), not only the slice text.
  const draft: Record<string, unknown> = {
    schemaVersion: 1,
    id: input.caseId,
    tenantId: input.tenantId,
    target: { repo: input.repo, commit: input.commit, variant: 'vulnerable' },
    candidate: { ...a.candidate, file: safeName('file', a.candidate.file) },
    slices,
    bootHints,
    redactions: input.redactions.map((r) => ({ ...r, file: safeName('file', r.file) })),
    escalationFloor: a.escalationFloor,
  };
  if (path) {
    const route = routeInfoOf(path);
    draft['route'] = {
      ...route,
      path: safeName('route-path', route.path),
      handlerFile: safeName('file', route.handlerFile),
      middleware: route.middleware.map((m) => safeName('label', m)),
    };
  }
  if (match.safe) draft['safeVariant'] = match.safe.target;
  const parsed = CaseFile.safeParse(draft);
  if (!parsed.success) {
    throw new CaseFileInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const out: AssembleResult = { caseFile: parsed.data, withheld };
  if (match.labelId) out.labelId = match.labelId;
  if (match.safe) out.safeVariantId = match.safe.id;
  return out;
}
