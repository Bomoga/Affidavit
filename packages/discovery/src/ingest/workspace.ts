import { chmod, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redaction } from '@affidavit/contracts';
import { FONT_HEAD_BYTES, fontFormatOf } from '../tools/fonts.js';
import { signatureClass } from '../tools/unscannable.js';
import { listDir } from '../tools/walk.js';
import { entriesOf, holdsUtf16, redactBuffer, type SecretRedactor } from './redactor.js';
import type { ExcludedFile, ExclusionReason } from './types.js';

/**
 * Conservative on purpose: `.env`, `.env.*`, `.env-local`, `.env_production`, `prod.env`,
 * `prod.env.local` and the like (any case, any depth), plus `.envs` and `.envrc`. A directory with
 * such a name is left out whole. Lead question: narrow this set?
 */
export function isEnvName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.envs' || n === '.envrc' || n === '.flaskenv') return true;
  // `.env~`, `.env1`, `.envlocal` and the like; `.environment` and `.envelope` are not env files.
  if (/^\.env[a-z0-9~]*$/.test(n) && !/^\.(?:environ|envelope)/.test(n)) return true;
  // Editor and file-manager copies: `.env copy`, `.env - Copy`, `.env (1)`, `.env `, `.env+old`,
  // `.env@prod`: `.env` followed by anything that is not a letter. `#.env#` is an editor backup.
  if (/^\.env(?![a-z])/.test(n) || /^#\.env.*#$/.test(n)) return true;
  // `prod.env`, `prod.env~`, `prod.env copy`, `a.env.local`: `.env` anywhere, not followed by a
  // letter (`.environment`).
  return /\.env(?![a-z])/.test(n);
}

/** The longest media signature in the tools table ends at byte 8 (`ftyp` at offset 4). */
const HEAD_BYTES = 64;

/**
 * True when the file starts with an image, audio or video signature (the tools layer's table, the
 * same one that classes a file `binary-media`). Judged on content alone: a media file under an
 * archive-like or misleading name is still media. Such files are kept out whole, because the
 * scanner's coverage of their bytes (UTF-16 text, text past a chunk cut) is not guaranteed and a
 * binary cannot be rewritten safely.
 */
async function isMediaFile(abs: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(abs, 'r');
  } catch {
    return false; // unreadable: the later steps fail on it as before
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return signatureClass(buf.subarray(0, bytesRead)) === 'media';
  } finally {
    await fh.close();
  }
}

/**
 * True when the file is a font whose structure checks out (tools/fonts.ts, the same check that
 * classes a file `binary-font` for the scan). Judged on the bytes and the extension.
 */
export async function isFontFile(abs: string, name: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(abs, 'r');
  } catch {
    return false; // unreadable: the later steps fail on it as before
  }
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, FONT_HEAD_BYTES));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return fontFormatOf(name, buf.subarray(0, bytesRead), size) !== undefined;
  } finally {
    await fh.close();
  }
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
  const entries = entriesOf(redactor);
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
      // Before the map's own reasons: whatever else is true of a media file, it does not leave.
      if (e.isFile && (await isMediaFile(join(src, e.name)))) {
        skip(childRel, 'media-file');
        continue;
      }
      // Fonts the same way: the scanner skips them, so they never leave.
      if (e.isFile && (await isFontFile(join(src, e.name), e.name))) {
        skip(childRel, 'font-file');
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
      const target = join(dst, safePath(e.name));
      try {
        // wx: never overwrite. Two names that end up the same file (redaction, or a case-insensitive
        // file system) keep the first and leave the second out.
        await writeFile(target, buf, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          skip(childRel, 'name-collision');
          continue;
        }
        throw err;
      }
      await chmod(target, st.mode & 0o777).catch(() => undefined);
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
  const globals = entriesOf(redactor).filter((e) => e.scope === 'global');
  if (globals.length === 0) return [];
  const leaks: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    const dir = rel === '' ? wsDir : join(wsDir, ...rel.split('/'));
    for (const e of await listDir(dir)) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (globals.some((g) => childRel.includes(g.value.toString('utf8')))) leaks.push(childRel);
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
