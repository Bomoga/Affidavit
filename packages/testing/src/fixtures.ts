import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Repo-root fixtures directory, resolved from this file so it works from any cwd. */
export const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures');

export function readFixtureJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, relPath), 'utf8')) as unknown;
}

/** Every .json file under fixtures/, as paths relative to fixtures/ with forward slashes. */
export function listFixtureFiles(dir: string = FIXTURES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFixtureFiles(full));
    else if (entry.name.endsWith('.json'))
      out.push(relative(FIXTURES_DIR, full).split('\\').join('/'));
  }
  return out.sort();
}
