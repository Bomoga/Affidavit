import { readdir } from 'node:fs/promises';

/**
 * A directory entry name is not valid UTF-8. The host walks in lockfiles.ts and unscannable.ts
 * read names as strings, which would mangle such a name and then fail with a confusing ENOENT, so
 * they stop with this typed error instead. Treat the repo as hostile or unscannable.
 */
export class NonUtf8NameError extends Error {
  readonly dir: string;
  constructor(dir: string) {
    super(`a name inside ${dir} is not valid UTF-8, so this snapshot cannot be walked safely`);
    this.name = 'NonUtf8NameError';
    this.dir = dir;
  }
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Lists a directory without following symlinks. Throws NonUtf8NameError for raw non-UTF-8 names. */
export async function listDir(dir: string): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, encoding: 'buffer' })) {
    const name = e.name.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(e.name)) throw new NonUtf8NameError(dir);
    out.push({ name, isDirectory: e.isDirectory(), isFile: e.isFile() });
  }
  return out;
}
