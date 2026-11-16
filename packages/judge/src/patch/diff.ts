/**
 * A strict reader for the unified diffs Remedy submits (L2-07). The Judge counts lines and files
 * from the diff itself and never trusts the `filesTouched` or `linesChanged` the author declared.
 *
 * Only plain text edits to regular files are accepted. Anything else (binary patches, renames,
 * copies, mode changes, symlinks, submodules, paths outside the tree or under `.git`, quoted
 * names, hunks whose line counts disagree with their header) makes the diff unreadable, which the
 * Judge records as `schema`.
 */

export interface DiffLine {
  /** Repository-relative path of the file the line belongs to. */
  path: string;
  /** The line's text without its leading `+`, `-` or space. */
  text: string;
}

export interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  added: string[];
  removed: string[];
  /**
   * This file's section of the diff exactly as submitted (file headers and hunks), one entry per
   * line. `renderDiff` joins sections back into a diff, so a workbench can apply a subset of the
   * files (for example the patch without its test files) with `git apply`.
   */
  raw: string[];
}

export interface ParsedDiff {
  files: DiffFile[];
  /** Added plus removed lines over every file, like `git diff --numstat`. */
  linesChanged: number;
}

export type DiffParse = { ok: true; diff: ParsedDiff } | { ok: false; reason: string };

/**
 * Longest diff line accepted. Source lines longer than this are minified or generated code, which
 * a patch has no reason to touch, and a cap keeps every pattern the Judge runs on a line cheap.
 */
export const MAX_LINE_CHARS = 2000;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
/** Extended header lines git writes that are harmless for a plain text edit. */
const HARMLESS =
  /^(index [0-9a-f]+\.\.[0-9a-f]+( 100644| 100755)?|new file mode 100(644|755)|deleted file mode 100(644|755))$/;

/** Rejects anything but a plain relative path inside the tree. */
export function unsafePathReason(path: string): string | null {
  if (path.length === 0) return 'empty path';
  if (path.startsWith('"')) return 'quoted path';
  // Control characters, backslashes and the like have no place in a source path.
  if (!/^[\w@+=,.~/-]+$/.test(path)) return 'unusual characters in path';
  if (path.startsWith('/')) return 'absolute path';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'path escapes the tree';
  if (parts.some((p) => p.toLowerCase() === '.git')) return 'path inside .git';
  return null;
}

const fail = (reason: string): DiffParse => ({ ok: false, reason });

export function parseUnifiedDiff(diff: string): DiffParse {
  const lines = diff.split('\n');
  // A trailing newline leaves one empty string; anything else empty is checked below.
  if (lines.at(-1) === '') lines.pop();

  const files: DiffFile[] = [];
  const seen = new Set<string>();
  let i = 0;

  // Checked before any pattern runs on a line, so no regex here or in literal.ts sees a long one.
  const long = lines.findIndex((l) => l.length > MAX_LINE_CHARS);
  if (long !== -1) return fail(`line ${long + 1} is over ${MAX_LINE_CHARS} characters`);

  while (i < lines.length) {
    const start = i;
    // Every section must start with `diff --git a/P b/P`, and its `---`/`+++` names must be
    // exactly `a/P` (or /dev/null) and `b/P` (or /dev/null). `git apply` strips the first path
    // component of whatever name it is given, so a section headed `--- z/test/a.js` would mean
    // `test/a.js` to git and `z/test/a.js` to a reader that only strips `a/`. With these exact
    // names the path the Judge checks is the path git writes.
    const header = lines[i] ?? '';
    const m = DIFF_GIT.exec(header);
    if (!m || m[1] !== m[2]) return fail(`expected "diff --git a/P b/P" at line ${i + 1}`);
    const path = m[1] as string;
    i++;
    while (i < lines.length && !(lines[i] ?? '').startsWith('--- ')) {
      const ext = lines[i] ?? '';
      if (ext.startsWith('diff --git ')) return fail(`no text change for ${path}`);
      if (!HARMLESS.test(ext)) return fail(`unsupported extended header: ${ext}`);
      i++;
    }

    const minus = lines[i] ?? '';
    const plus = lines[i + 1] ?? '';
    if (!minus.startsWith('--- ') || !plus.startsWith('+++ ')) {
      return fail(`expected a file header at line ${i + 1}`);
    }
    const oldName = stripTimestamp(minus.slice(4));
    const newName = stripTimestamp(plus.slice(4));
    i += 2;

    if (oldName !== '/dev/null' && oldName !== `a/${path}`) {
      return fail(`"--- ${oldName}" does not name a/${path}`);
    }
    if (newName !== '/dev/null' && newName !== `b/${path}`) {
      return fail(`"+++ ${newName}" does not name b/${path}`);
    }
    if (oldName === '/dev/null' && newName === '/dev/null')
      return fail('file header names no file');
    const status: DiffFile['status'] =
      oldName === '/dev/null' ? 'added' : newName === '/dev/null' ? 'deleted' : 'modified';
    const why = unsafePathReason(path);
    if (why !== null) return fail(`${why}: ${JSON.stringify(path)}`);
    if (seen.has(path)) return fail(`file appears twice: ${path}`);
    seen.add(path);

    const file: DiffFile = { path, status, added: [], removed: [], raw: [] };
    let hunks = 0;
    while (i < lines.length && (lines[i] ?? '').startsWith('@@')) {
      const m = HUNK.exec(lines[i] ?? '');
      if (!m) return fail(`malformed hunk header: ${lines[i]}`);
      let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newLeft = m[4] === undefined ? 1 : Number(m[4]);
      i++;
      hunks++;
      while (oldLeft > 0 || newLeft > 0) {
        const line = lines[i];
        if (line === undefined) return fail(`hunk in ${path} ends early`);
        const tag = line[0];
        const text = line.slice(1);
        if (tag === ' ' || line === '') {
          oldLeft--;
          newLeft--;
        } else if (tag === '-') {
          file.removed.push(text);
          oldLeft--;
        } else if (tag === '+') {
          file.added.push(text);
          newLeft--;
        } else if (line.startsWith('\\ ')) {
          // "\ No newline at end of file" belongs to the previous line and counts for nothing.
        } else {
          return fail(`unexpected line in hunk of ${path}: ${line.slice(0, 40)}`);
        }
        if (oldLeft < 0 || newLeft < 0) return fail(`hunk in ${path} is longer than its header`);
        i++;
      }
      while ((lines[i] ?? '').startsWith('\\ ')) i++;
    }
    if (hunks === 0) return fail(`no hunk for ${path}`);
    if (file.added.length + file.removed.length === 0) return fail(`no change in ${path}`);
    file.raw = lines.slice(start, i);
    files.push(file);
  }

  if (files.length === 0) return fail('diff has no files');
  const linesChanged = files.reduce((n, f) => n + f.added.length + f.removed.length, 0);
  return { ok: true, diff: { files, linesChanged } };
}

function stripTimestamp(name: string): string {
  const tab = name.indexOf('\t');
  return tab === -1 ? name : name.slice(0, tab);
}

/** The diff restricted to some of its files, with `linesChanged` recounted. */
export function selectFiles(diff: ParsedDiff, keep: (f: DiffFile) => boolean): ParsedDiff {
  const files = diff.files.filter(keep);
  const linesChanged = files.reduce((n, f) => n + f.added.length + f.removed.length, 0);
  return { files, linesChanged };
}

/** Joins file sections back into unified diff text. Empty when the diff has no files. */
export const renderDiff = (diff: ParsedDiff): string =>
  diff.files.map((f) => `${f.raw.join('\n')}\n`).join('');

/** Every added line, tagged with its file. */
export const addedLines = (diff: ParsedDiff): DiffLine[] =>
  diff.files.flatMap((f) => f.added.map((text) => ({ path: f.path, text })));
