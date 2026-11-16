import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootHints, CommitSha, RepoId, Sha256, TargetRef, VulnClass } from '@affidavit/contracts';
import type {
  CorpusApp,
  CorpusIndex,
  LicenseNote,
  Label,
  LineRange,
  NegativeControl,
  PatchRef,
  Pin,
  SafeVariant,
} from './types.js';

export type * from './types.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

interface RawPin extends Pin {
  patches: Record<string, { path: string; sha256: string }>;
}
interface RawApp {
  id: string;
  name: string;
  repo: string;
  license: LicenseNote;
  bootHints: unknown;
  bootNotes: string;
  labels: Label[];
  safeVariants: {
    id: string;
    fixes: string;
    patches: string[];
    bootHints: unknown;
    notes: string;
  }[];
  negativeControls: {
    id: string;
    patches: string[];
    file: string;
    range: LineRange;
    expectedRuleIds: string[];
    whyNotExploitable: string;
    bootHints: unknown;
  }[];
}

function readJson<T>(appDir: string, name: string): T {
  return JSON.parse(readFileSync(join(dataDir, appDir, name), 'utf8')) as T;
}

function loadApp(appDir: string): CorpusApp {
  const rawPin = readJson<RawPin>(appDir, 'pin.json');
  const raw = readJson<RawApp>(appDir, 'app.json');
  const { patches: pinPatches, ...pin } = rawPin;
  const repo = RepoId.parse(raw.repo);
  const refs = (ids: string[]): PatchRef[] =>
    ids.map((id) => {
      const p = pinPatches[id];
      if (!p) throw new Error(`${raw.id}: unknown patch ${id}`);
      return { id, path: p.path, sha256: p.sha256 };
    });
  const safeVariants: SafeVariant[] = raw.safeVariants.map((v) => ({
    id: v.id,
    appId: raw.id,
    fixes: v.fixes,
    target: TargetRef.parse({ repo, commit: pin.commit, variant: 'safe' }),
    patches: refs(v.patches),
    bootHints: BootHints.parse(v.bootHints),
    license: raw.license,
    notes: v.notes,
  }));
  const negativeControls: NegativeControl[] = raw.negativeControls.map((n) => ({
    id: n.id,
    appId: raw.id,
    target: TargetRef.parse({ repo, commit: pin.commit, variant: 'safe' }),
    patches: refs(n.patches),
    file: n.file,
    range: n.range,
    expectedRuleIds: n.expectedRuleIds,
    whyNotExploitable: n.whyNotExploitable,
    bootHints: BootHints.parse(n.bootHints),
    license: raw.license,
  }));
  return {
    id: raw.id,
    name: raw.name,
    repo,
    pin,
    license: raw.license,
    bootHints: BootHints.parse(raw.bootHints),
    bootNotes: raw.bootNotes,
    labels: raw.labels,
    safeVariants,
    negativeControls,
  };
}

function checkRange(where: string, r: LineRange): void {
  if (!Number.isInteger(r.startLine) || r.startLine < 1 || r.endLine < r.startLine) {
    throw new Error(`${where}: invalid line range ${r.startLine}-${r.endLine}`);
  }
}

function checkFile(where: string, file: string): void {
  if (file.startsWith('/') || file.split('/').includes('..')) {
    throw new Error(`${where}: file must be a relative path inside the repo`);
  }
}

/** Throws on the first structural problem. The loader runs it, so a bad index never loads. */
export function validateCorpus(index: CorpusIndex): void {
  const seen = new Set<string>();
  for (const app of index.apps) {
    if (seen.has(app.id)) throw new Error(`duplicate app id ${app.id}`);
    seen.add(app.id);
    CommitSha.parse(app.pin.commit);
    CommitSha.parse(app.pin.tree);
    Sha256.parse(app.pin.archiveSha256);
    if (!app.pin.repoUrl.startsWith('https://'))
      throw new Error(`${app.id}: repoUrl must be https`);
    for (const l of [app.license, ...app.safeVariants.map((v) => v.license)]) {
      if (!l.spdx || !l.file || !l.note) throw new Error(`${app.id}: license note incomplete`);
    }
    const labelIds = new Set<string>();
    for (const l of app.labels) {
      if (labelIds.has(l.id)) throw new Error(`${app.id}: duplicate label ${l.id}`);
      labelIds.add(l.id);
      VulnClass.parse(l.cls);
      checkRange(l.id, l.range);
      checkRange(`${l.id} source`, l.source.range);
      checkFile(l.id, l.file);
      checkFile(`${l.id} source`, l.source.file);
    }
    for (const v of app.safeVariants) {
      if (!labelIds.has(v.fixes)) throw new Error(`${v.id}: fixes unknown label ${v.fixes}`);
      for (const p of v.patches) Sha256.parse(p.sha256);
      BootHints.parse(v.bootHints);
    }
    for (const n of app.negativeControls) {
      checkRange(n.id, n.range);
      checkFile(n.id, n.file);
      for (const p of n.patches) Sha256.parse(p.sha256);
      BootHints.parse(n.bootHints);
      if (!n.whyNotExploitable) throw new Error(`${n.id}: whyNotExploitable is required`);
    }
  }
}

function loadCorpus(): CorpusIndex {
  const index: CorpusIndex = { apps: [loadApp('nodegoat')] };
  validateCorpus(index);
  return index;
}

export const corpus: CorpusIndex = loadCorpus();

export function getApp(id: string): CorpusApp {
  const app = corpus.apps.find((a) => a.id === id);
  if (!app) throw new Error(`unknown corpus app ${id}`);
  return app;
}

/** Absolute path of a patch file shipped in data/<app>/. */
export function patchPath(app: CorpusApp, patchId: string): string {
  const all = [...app.safeVariants, ...app.negativeControls].flatMap((x) => x.patches);
  const p = all.find((x) => x.id === patchId);
  if (!p) throw new Error(`${app.id}: unknown patch ${patchId}`);
  return join(dataDir, app.id, p.path);
}
