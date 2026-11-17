import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redaction } from '@affidavit/contracts';
import { listDir } from '../tools/walk.js';
import { holdsUtf16, redactBuffer, type SecretRedactor } from './redactor.js';
import type { ExcludedFile, ExclusionReason } from './types.js';

/** `.env`, `.env.*`, any case. `.envrc` (direnv) is kept out too. */
export function isEnvName(name: string): boolean {
  const n = name.toLowerCase();
  return n === '.env' || n.startsWith('.env.') || n === '.envrc';
}

export interface BuiltWorkspace {
  excluded: ExcludedFile[];
  redactions: Redaction[];
}

/**
 * Writes the outgoing workspace from the raw checkout. The only code path that does: a file is
 * written only after its bytes pass through the redaction map, and `.env` files, files that
 * cannot be redacted, and anything that is not a plain file are never written. The checkout's own
 * `.git` is not part of the workspace.
 */
export async function buildWorkspace(
  rawDir: string,
  wsDir: string,
  redactor: SecretRedactor,
  mustExclude: ReadonlyMap<string, ExclusionReason>,
  maxFileBytes: number,
): Promise<BuiltWorkspace> {
  const excluded: ExcludedFile[] = [];
  const seen = new Set<string>();
  const redactions: Redaction[] = [];
  const entries = redactor.all();
  const safePath = (p: string): string => redactor.applyPath(p);
  const skip = (rel: string, reason: ExclusionReason): void => {
    excluded.push({ path: safePath(rel), reason });
  };

  await mkdir(wsDir, { recursive: false });
  const visit = async (rel: string): Promise<void> => {
    const src = rel === '' ? rawDir : join(rawDir, ...rel.split('/'));
    const dst = rel === '' ? wsDir : join(wsDir, ...safePath(rel).split('/'));
    if (rel !== '') await mkdir(dst, { recursive: true });
    for (const e of await listDir(src)) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (rel === '' && e.name === '.git') continue;
      if (isEnvName(e.name)) {
        skip(childRel, 'env-file');
        continue;
      }
      if (e.isDirectory) {
        await visit(childRel);
        continue;
      }
      const reason = mustExclude.get(childRel);
      if (reason !== undefined) {
        skip(childRel, reason);
        continue;
      }
      const abs = join(src, e.name);
      const st = await lstat(abs);
      if (!e.isFile || !st.isFile()) {
        skip(childRel, 'not-regular-file');
        continue;
      }
      if (st.size > maxFileBytes) {
        skip(childRel, 'too-large');
        continue;
      }
      const input = await readFile(abs);
      if (holdsUtf16(input, entries)) {
        skip(childRel, 'secret-in-other-encoding');
        continue;
      }
      const { buf, hits } = redactBuffer(childRel, input, entries);
      const outRel = safePath(childRel);
      await writeFile(join(dst, safePath(e.name)), buf);
      await chmod(join(dst, safePath(e.name)), st.mode & 0o777).catch(() => undefined);
      for (const h of hits) {
        const key = `${outRel}|${h.startLine}|${h.endLine}|${h.entry.placeholder}`;
        if (seen.has(key)) continue;
        seen.add(key);
        redactions.push({
          file: outRel,
          startLine: h.startLine,
          endLine: h.endLine,
          kind: h.entry.ruleId,
          placeholder: h.entry.placeholder,
        });
      }
    }
  };
  await visit('');
  redactions.sort(
    (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  excluded.sort((a, b) => a.path.localeCompare(b.path));
  return { excluded, redactions };
}

/**
 * Last line of defence: walks the finished workspace and returns every path whose bytes (or
 * name) still hold a global map value. Located (short) values are not checked, they cannot be
 * searched for everywhere.
 */
export async function findLeaks(wsDir: string, redactor: SecretRedactor): Promise<string[]> {
  const globals = redactor.all().filter((e) => e.scope === 'global');
  if (globals.length === 0) return [];
  const leaks: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    const dir = rel === '' ? wsDir : join(wsDir, ...rel.split('/'));
    for (const e of await listDir(dir)) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (globals.some((g) => e.name.includes(g.value.toString('utf8')))) leaks.push(childRel);
      if (e.isDirectory) await visit(childRel);
      else if (e.isFile) {
        const b = await readFile(join(dir, e.name));
        if (globals.some((g) => b.includes(g.value))) leaks.push(childRel);
      }
    }
  };
  await visit('');
  return leaks;
}
