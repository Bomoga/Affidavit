// Builds a pinned dependency bundle for a corpus app (lead decision 2026-11-20, L2-04c).
//
// HUMAN-RUN ONLY, ON A NETWORKED HOST, NEVER INSIDE A JAIL. This is the only code in Lane 2 that
// touches the network for dependencies. It is not exported from @affidavit/sandbox, the Judge
// and the worker never call it, and no agent path reaches it. A human runs it, reviews the
// manifest it prints, and then pins the digest in docker/sandbox/dependency-bundles/pins.json.
//
// Usage:
//   node packages/corpus/scripts/fetch-pinned.mjs nodegoat          (once, gives the checkout)
//   pnpm --filter @affidavit/sandbox bundle:build --app nodegoat \
//     --checkout <repo>/packages/corpus/data/src/nodegoat --out <bundle dir>
//
// What it does:
//   1. Reads the app's pin from the corpus loader and checks the checkout's HEAD is that commit.
//   2. Reads package-lock.json from git at that commit (the committed bytes, not the work tree).
//   3. Plans both sections (production, dev). A section with a package that cannot be installed
//      without lifecycle scripts, comes from outside the registry or has no integrity hash is
//      written as `unsupported`, every such package named, and nothing is fetched for it.
//   4. Runs `npm cache add --ignore-scripts` for the resolved URL of each package in the other
//      section(s), into an empty temporary cache, with an empty npm config and the public
//      registry. No package is installed or unpacked, and no script runs.
//   5. Verifies every tarball against every hash in its lockfile integrity, inspects it for
//      install scripts, and writes `<out>/<sha256>.tar` plus `<out>/<sha256>.json`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getApp } from '@affidavit/corpus';
import {
  assembleBundleFile,
  digestHex,
  parseIntegrity,
  planLockfile,
  pruneExcludedDev,
  readBundleExclusions,
  sectionPackages,
  type BundleSection,
  type PlannedPackage,
} from '../src/bundle/index.js';

const exec = promisify(execFile);

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`missing --${name} (see the usage at the top of this script)`);
  }
  return v;
}

function npmCli(): string {
  const found = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((p) => existsSync(p));
  if (found === undefined) throw new Error('npm-cli.js not found next to this node binary');
  return found;
}

async function main(): Promise<void> {
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
    throw new Error('refusing to run inside a container: this is a human-run host step');
  }
  const appId = arg('app');
  const checkout = resolve(arg('checkout'));
  const out = resolve(arg('out'));
  const app = getApp(appId);
  const commit = app.pin.commit;

  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
  if (head !== commit) throw new Error(`checkout HEAD ${head} is not the corpus pin ${commit}`);
  const lockText = (
    await exec('git', ['show', `${commit}:package-lock.json`], {
      cwd: checkout,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
  const pkgText = (await exec('git', ['show', `${commit}:package.json`], { cwd: checkout })).stdout;
  // The reviewed exclusion list (packages/sandbox/bundle-exclusions.json). Security relevant: it
  // goes into the dev section and its digest, and is printed below for the reviewer.
  const excludedDev = readBundleExclusions(appId, commit);

  const read = planLockfile(lockText);
  if (!read.ok) throw new Error(read.reason);
  const plan = read.plan;
  let devPlan = plan;
  if (excludedDev.length > 0) {
    const pruned = pruneExcludedDev(lockText, pkgText, excludedDev);
    if (!pruned.ok) throw new Error(pruned.reason);
    const devRead = planLockfile(pruned.lockText);
    if (!devRead.ok) throw new Error(devRead.reason);
    devPlan = devRead.plan;
  }
  const planFor = (s: BundleSection) => (s === 'dev' ? devPlan : plan);
  const wanted = (['production', 'dev'] as const)
    .filter((s) => planFor(s).problems[s].length === 0)
    .flatMap((s) => sectionPackages(planFor(s), [s]));

  const tmp = await mkdtemp(join(tmpdir(), 'affidavit-bundle-build-'));
  try {
    const cache = join(tmp, 'cache');
    // Two empty files: npm refuses to load one file as both the user and the global config.
    const userRc = join(tmp, 'user-npmrc');
    const globalRc = join(tmp, 'global-npmrc');
    await writeFile(userRc, '');
    await writeFile(globalRc, '');
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k)) env[k] = v;
    const urls = [...new Set(wanted.map((p) => p.resolved))];
    const cli = npmCli();
    for (let i = 0; i < urls.length; i += 50) {
      await exec(
        process.execPath,
        [
          cli,
          'cache',
          'add',
          '--ignore-scripts',
          '--cache',
          cache,
          '--userconfig',
          userRc,
          '--globalconfig',
          globalRc,
          '--registry',
          'https://registry.npmjs.org/',
          ...urls.slice(i, i + 50),
        ],
        { cwd: tmp, env, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 },
      );
      console.error(`fetched ${Math.min(i + 50, urls.length)} of ${urls.length}`);
    }

    // npm stores content by the hash it computed. Look a tarball up by each hash the lockfile
    // names; if npm used another algorithm, fall back to hashing every cached file once.
    const content = join(cache, '_cacache', 'content-v2');
    let scanned: Map<string, string> | undefined;
    const scan = async (): Promise<Map<string, string>> => {
      const index = new Map<string, string>();
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) {
            const data = await readFile(p);
            for (const algo of ['sha1', 'sha512'] as const)
              index.set(`${algo}:${digestHex(algo, data)}`, p);
          }
        }
      };
      if (existsSync(content)) await walk(content);
      return index;
    };
    const tarballFor = async (p: PlannedPackage): Promise<Buffer | null> => {
      for (const h of parseIntegrity(p.integrity) ?? []) {
        const direct = join(content, h.algo, h.hex.slice(0, 2), h.hex.slice(2, 4), h.hex.slice(4));
        if (existsSync(direct)) return readFile(direct);
      }
      scanned ??= await scan();
      for (const h of parseIntegrity(p.integrity) ?? []) {
        const hit = scanned.get(`${h.algo}:${h.hex}`);
        if (hit !== undefined) return readFile(hit);
      }
      return null;
    };

    await mkdir(out, { recursive: true });
    const partial = join(out, `.partial-${process.pid}.tar`);
    const built = await assembleBundleFile(
      { app: appId, commit, lockText, pkgText, excludedDev, tarballFor },
      partial,
    );
    const final = join(out, `${built.sha256}.tar`);
    await rename(partial, final);
    const npmVersion = (await exec(process.execPath, [cli, '--version'], { env })).stdout.trim();
    await writeFile(
      join(out, `${built.sha256}.json`),
      `${JSON.stringify(
        {
          bundleSha256: built.sha256,
          bytes: built.bytes,
          builtWith: { node: process.version, npm: npmVersion },
          skipped: plan.skipped,
          manifest: built.manifest,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`bundle ${final}`);
    console.log(`sha256 ${built.sha256} (${built.bytes} bytes)`);
    for (const [name, s] of Object.entries(built.manifest.sections)) {
      console.log(
        s.status === 'ok'
          ? `${name}: ok, ${s.packages.length} packages, section sha256 ${s.sha256}`
          : `${name}: unsupported: ${s.reason}`,
      );
    }
    if (excludedDev.length > 0) {
      console.log(`dev excludes ${excludedDev.length} reviewed packages (in the section digest):`);
      for (const e of excludedDev) console.log(`  ${e.name}@${e.version}: ${e.reason}`);
    }
    console.log(
      'Review the manifest, then set bundleSha256 in docker/sandbox/dependency-bundles/pins.json.',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
