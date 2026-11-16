import { listDir } from './walk.js';
import { join, relative, sep } from 'node:path';

/**
 * File names OSV-Scanner treats as dependency sources. Discovery's own copy of the list, used to
 * decide whether OSV-Scanner's "no packages found" exit (128) is a true empty result or a failed
 * parse of a lockfile that is there. Deliberately broad: a name listed here that OSV-Scanner would
 * not have read only turns an empty result into a failure, which is the safe direction.
 */
const NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'cargo.lock',
  'go.mod',
  'gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'pom.xml',
  'gradle.lockfile',
  'buildscript-gradle.lockfile',
  'pubspec.lock',
  'mix.lock',
  'packages.lock.json',
  'conan.lock',
  'renv.lock',
  'package.resolved',
  'podfile.lock',
  'cabal.project.freeze',
  'stack.yaml.lock',
  // Names found in the pinned 2.7.0 binary. Some (deno.lock, Podfile.lock, project.assets.json,
  // plain deps.json) did not react to garbage content in the probe and may need valid content;
  // others only apply in a specific directory (node_modules/.package-lock.json, gradle/). Kept on
  // purpose: over-inclusion only turns an empty result into a failure.
  'pylock.toml',
  '.package-lock.json',
  'verification-metadata.xml',
  'libs.versions.toml',
  'packages.config',
  'gems.locked',
  'deps.json',
  'project.assets.json',
  'packages.lock',
  'bom.json',
  'bom.xml',
  'directory.packages.props',
]);

export function isOsvLockfileName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    NAMES.has(n) ||
    /^requirements[\w.-]*\.txt$/.test(n) ||
    /^pylock\.[\w.-]+\.toml$/.test(n) ||
    /\.(?:cdx|spdx)\.(?:json|xml)$/.test(n) ||
    /\.(?:csproj|vbproj|fsproj)$/.test(n) ||
    /\.spdx(?:\.(?:json|xml|ya?ml|rdf))?$/.test(n) ||
    /\.deps\.json$/.test(n)
  );
}

/** Relative paths of files in the snapshot that OSV-Scanner could read. Never follows symlinks. */
export async function findOsvLockfiles(snapshotDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await listDir(dir)) {
      const full = join(dir, e.name);
      if (e.isDirectory) await walk(full);
      else if (isOsvLockfileName(e.name)) {
        found.push(relative(snapshotDir, full).split(sep).join('/'));
      }
    }
  };
  await walk(snapshotDir);
  return found.sort();
}
