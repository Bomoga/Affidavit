import { sha256Hex } from './sha256.js';
import type { PromptDefinition, PromptId } from './types.js';

/** Append-only: prompt id to version to digest of what that version said. */
export type VersionHistory = Record<PromptId, Record<string, string>>;

/** Digest of everything that defines a prompt's behavior except its version label. */
export function promptDigest(p: PromptDefinition): string {
  return sha256Hex(JSON.stringify([p.id, p.role, p.outputSchemaRef, p.system]));
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Returns human-readable problems; an empty array means prompts and history agree. */
export function checkVersionHistory(
  prompts: Readonly<Record<PromptId, PromptDefinition>>,
  history: VersionHistory,
): string[] {
  const problems: string[] = [];
  for (const p of Object.values(prompts)) {
    const entry = history[p.id] as Record<string, string> | undefined;
    const digest = promptDigest(p);
    if (!entry) {
      problems.push(`${p.id}: no history entry. Add { '${p.version}': '${digest}' }.`);
      continue;
    }
    const recorded = entry[p.version];
    if (recorded === undefined) {
      problems.push(
        `${p.id}: version ${p.version} is not in the history. Append '${p.version}': '${digest}'.`,
      );
    } else if (recorded !== digest) {
      problems.push(
        `${p.id}@${p.version}: prompt text changed without a version bump. Bump the version, then append its digest ${digest}.`,
      );
    }
    const newest = Object.keys(entry).sort(compareSemver).at(-1);
    if (newest !== undefined && compareSemver(newest, p.version) > 0) {
      problems.push(
        `${p.id}: history has ${newest}, which is newer than the current ${p.version}.`,
      );
    }
  }
  return problems;
}
