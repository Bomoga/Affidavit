import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BootHints,
  CommitSha,
  RepoId,
  RouteInfo,
  Sha256,
  TargetRef,
  VulnClass,
} from '@affidavit/contracts';
import type {
  CodeLocation,
  CorpusApp,
  CorpusIndex,
  Label,
  LicenseNote,
  LineRange,
  NegativeControl,
  PatchRef,
  SafeVariant,
} from './types.js';

export type * from './types.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

type Obj = Record<string, unknown>;

function obj(where: string, v: unknown): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: expected an object`);
  }
  return v as Obj;
}

function str(where: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new Error(`${where}: expected a non-empty string`);
  return v;
}

function strs(where: string, v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error(`${where}: expected an array`);
  return v.map((x, i) => str(`${where}[${i}]`, x));
}

function arr(where: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${where}: expected an array`);
  return v;
}

function range(where: string, v: unknown): LineRange {
  const o = obj(where, v);
  const { startLine, endLine } = o;
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new Error(`${where}: invalid line range`);
  }
  return { startLine, endLine };
}

function repoFile(where: string, v: unknown): string {
  const f = str(where, v);
  if (f.startsWith('/') || f.includes('\\') || f.split('/').includes('..')) {
    throw new Error(`${where}: file must be a relative path inside the repo`);
  }
  return f;
}

function location(where: string, v: unknown): CodeLocation {
  const o = obj(where, v);
  return { file: repoFile(`${where}.file`, o['file']), range: range(`${where}.range`, o['range']) };
}

function license(where: string, v: unknown): LicenseNote {
  const o = obj(where, v);
  const note = str(`${where}.note`, o['note']);
  if (note.length < 20) throw new Error(`${where}: license note too short`);
  return { spdx: str(`${where}.spdx`, o['spdx']), file: str(`${where}.file`, o['file']), note };
}

function label(where: string, v: unknown): Label {
  const o = obj(where, v);
  const reachability = o['reachability'];
  if (
    reachability !== 'reachable' &&
    reachability !== 'unreachable' &&
    reachability !== 'unknown'
  ) {
    throw new Error(`${where}.reachability: invalid`);
  }
  const cwe = str(`${where}.cwe`, o['cwe']);
  if (!/^CWE-\d+$/.test(cwe)) throw new Error(`${where}.cwe: expected CWE-<number>`);
  const loc = location(where, { file: o['file'], range: o['range'] });
  return {
    id: str(`${where}.id`, o['id']),
    cls: VulnClass.parse(o['cls']),
    title: str(`${where}.title`, o['title']),
    cwe,
    file: loc.file,
    range: loc.range,
    source: location(`${where}.source`, o['source']),
    route: RouteInfo.parse(o['route']),
    reachability,
    notes: str(`${where}.notes`, o['notes']),
  };
}

interface RawPin {
  repoUrl: string;
  commit: string;
  tree: string;
  archiveSha256: string;
  patches: Record<string, { path: string; sha256: string }>;
}

function readJson(appDir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dataDir, appDir, name), 'utf8')) as unknown;
}

function loadApp(appDir: string): CorpusApp {
  const pinRaw = obj('pin', readJson(appDir, 'pin.json'));
  const patchTable = obj('pin.patches', pinRaw['patches']);
  const pin: RawPin = {
    repoUrl: str('pin.repoUrl', pinRaw['repoUrl']),
    commit: CommitSha.parse(pinRaw['commit']),
    tree: CommitSha.parse(pinRaw['tree']),
    archiveSha256: Sha256.parse(pinRaw['archiveSha256']),
    patches: {},
  };
  for (const [id, p] of Object.entries(patchTable)) {
    const po = obj(`pin.patches.${id}`, p);
    pin.patches[id] = { path: str(`${id}.path`, po['path']), sha256: Sha256.parse(po['sha256']) };
  }
  const raw = obj('app', readJson(appDir, 'app.json'));
  const id = str('app.id', raw['id']);
  const repo = RepoId.parse(raw['repo']);
  const lic = license('app.license', raw['license']);
  const refs = (where: string, ids: string[]): PatchRef[] =>
    ids.map((pid) => {
      const p = pin.patches[pid];
      if (!p) throw new Error(`${where}: unknown patch ${pid}`);
      return { id: pid, path: p.path, sha256: p.sha256 };
    });
  const { patches: _patches, ...pinOut } = pin;
  void _patches;
  return {
    id,
    name: str('app.name', raw['name']),
    repo,
    pin: pinOut,
    license: lic,
    bootHints: BootHints.parse(raw['bootHints']),
    bootNotes: str('app.bootNotes', raw['bootNotes']),
    labels: arr('app.labels', raw['labels']).map((l, i) => label(`labels[${i}]`, l)),
    outOfScope: arr('app.outOfScope', raw['outOfScope']).map((x, i) => {
      const o = obj(`outOfScope[${i}]`, x);
      return { issue: str('issue', o['issue']), reason: str('reason', o['reason']) };
    }),
    safeVariants: arr('app.safeVariants', raw['safeVariants']).map((x, i): SafeVariant => {
      const o = obj(`safeVariants[${i}]`, x);
      return {
        id: str('id', o['id']),
        appId: id,
        fixes: str('fixes', o['fixes']),
        target: TargetRef.parse({ repo, commit: pin.commit, variant: 'safe' }),
        patches: refs('safeVariants', strs('patches', o['patches'])),
        bootHints: BootHints.parse(o['bootHints']),
        license: lic,
        notes: str('notes', o['notes']),
      };
    }),
    negativeControls: arr('app.negativeControls', raw['negativeControls']).map(
      (x, i): NegativeControl => {
        const o = obj(`negativeControls[${i}]`, x);
        if (o['role'] !== 'negative-control') throw new Error(`negativeControls[${i}]: bad role`);
        const loc = location(`negativeControls[${i}]`, { file: o['file'], range: o['range'] });
        return {
          id: str('id', o['id']),
          appId: id,
          role: 'negative-control',
          base: TargetRef.parse({ repo, commit: pin.commit, variant: 'vulnerable' }),
          patches: refs('negativeControls', strs('patches', o['patches'])),
          file: loc.file,
          range: loc.range,
          expectedRuleIds: strs('expectedRuleIds', o['expectedRuleIds']),
          whyNotExploitable: str('whyNotExploitable', o['whyNotExploitable']),
          bootHints: BootHints.parse(o['bootHints']),
          license: lic,
        };
      },
    ),
  };
}

/**
 * Throws on the first structural problem. The loader runs it, and it re-checks every field at
 * runtime so a hand-built or mutated index is validated the same way as the loaded one.
 */
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
    license(`${app.id}.license`, app.license);
    BootHints.parse(app.bootHints);
    const labelIds = new Set<string>();
    for (const l of app.labels) {
      if (labelIds.has(l.id)) throw new Error(`${app.id}: duplicate label ${l.id}`);
      labelIds.add(l.id);
      label(l.id, l);
    }
    for (const v of app.safeVariants) {
      if (!labelIds.has(v.fixes)) throw new Error(`${v.id}: fixes unknown label ${v.fixes}`);
      TargetRef.parse(v.target);
      license(`${v.id}.license`, v.license);
      for (const p of v.patches) Sha256.parse(p.sha256);
      BootHints.parse(v.bootHints);
    }
    for (const n of app.negativeControls) {
      range(n.id, n.range);
      repoFile(n.id, n.file);
      if (n.role !== 'negative-control') throw new Error(`${n.id}: bad role`);
      TargetRef.parse(n.base);
      if (n.base.variant !== 'vulnerable') throw new Error(`${n.id}: base must be the pinned tree`);
      license(`${n.id}.license`, n.license);
      strs(`${n.id}.expectedRuleIds`, n.expectedRuleIds);
      if (n.expectedRuleIds.length === 0) throw new Error(`${n.id}: expectedRuleIds is empty`);
      str(`${n.id}.whyNotExploitable`, n.whyNotExploitable);
      for (const p of n.patches) Sha256.parse(p.sha256);
      BootHints.parse(n.bootHints);
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

/** Absolute path of a patch file shipped in data/<app>/. Refuses paths that leave that directory. */
export function patchPath(app: CorpusApp, patchId: string): string {
  const all = [...app.safeVariants, ...app.negativeControls].flatMap((x) => x.patches);
  const p = all.find((x) => x.id === patchId);
  if (!p) throw new Error(`${app.id}: unknown patch ${patchId}`);
  const root = resolve(dataDir, app.id);
  const full = resolve(root, p.path);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${app.id}: patch ${patchId} path escapes the app data directory`);
  }
  return full;
}
