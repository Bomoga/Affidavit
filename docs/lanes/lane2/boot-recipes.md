# Boot recipes (L2-04)

`packages/sandbox/src/boot` builds a target from its checkout and boots it on a case network. Entry points: `buildTarget(srcDir, bootHints, { workRoot })` and `bootTarget(caseNetwork, imageId, recipe)`.

## Lead decision 2026-11-20: no egress exception, no js-yaml

PR #18 asked for two exceptions. Both were declined:

- **No dependency fetch.** An earlier version of this PR let `npm ci --ignore-scripts` reach `registry.npmjs.org` through a per-build CONNECT proxy. That is gone (`fetch.ts`, the proxy, the egress bridge and the `fetch` and `egress` run spec options were removed). Deny-all egress has no exception. A target whose install would download anything is `unsupported` at the recipe step, per plan.md (Lane 2, item 3: a target that cannot boot without real egress is marked unsupported rather than granted an exception). `buildGvisorRunArgs` now refuses any run spec key it does not know, so no caller can add a route out.
- **No `js-yaml`.** The compose precheck reads the small YAML subset compose files use with our own key scanner (`yaml-keys.ts`) and refuses anything outside it.

**Update 2026-11-20 (L2-04c):** the lead chose the first option below, a pinned dependency bundle. See "Dependency bundles" further down. Without a bundle, everything in this paragraph still holds; with one, NodeGoat's production dependencies install offline in the jail.

**Consequence, stated plainly: NodeGoat cannot be built any more.** It installs its dependencies at build time (its lockfile lists packages, and its Dockerfile runs `npm install`), so both the vulnerable and the safe variant are `unsupported` with reason "needs a dependency fetch at build time". The L2-04 done-when ("NodeGoat vulnerable and safe variants boot, report healthy, and return their digests") is not met, and the L2-07 workbench and L2-10 NodeGoat witnesses cannot run against a booted NodeGoat until there is a way to supply dependencies without egress. Nothing in the jail was weakened to get around this. Options for the lead (not implemented): a dependency set prepared offline by a human and mounted read-only after review, or a corpus that vendors `node_modules` under review. Either is a new decision.

What still builds: a target with no dependencies at all (nothing in the lockfile to download, nothing declared in `package.json`; with no `build` script, dev-only entries do not count).

## Why a split build

A target's Dockerfile usually runs `npm install`, which needs the network and runs package install scripts. `docker build` runs RUN steps with runc and full egress, outside gVisor, which the threat model does not allow ("Docker alone is not the boundary"). A Remedy patch would have its code built the same way. So the target's RUN steps are never executed as written (decision 2026-11-15, chosen by the Lane 2 owner):

| Step        | What runs                                                                                                                                                                                                         | Where                        | Network                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| 1. Stage    | Copy of the checkout: regular files only. No `.git`, `node_modules`, `.env*`, `.npmrc`, symlinks                                                                                                                  | Host (our code)              | n/a                            |
| 2. Recipe   | Boot hints (parsed with the contract schema first), compose file and Dockerfile are read, never run. The lockfile and `package.json` must list nothing to download (`dependencyFetchProblem`), else `unsupported` | Host (our code)              | none                           |
| Base        | The final-stage base must be an official `node` image. It is pinned by digest, and refused if it has `ONBUILD` triggers                                                                                           | Host (our code)              | Docker Hub pull, by the daemon |
| 3. Scripts  | `npm run build` if present, with the pinned base image and `npm_config_offline`                                                                                                                                   | gVisor, as nobody            | none                           |
| 4. Assemble | `docker build --network none` from a generated Dockerfile with only `FROM <base@digest>`, `COPY` and `WORKDIR`                                                                                                    | BuildKit, no RUN step exists | none                           |

No step has a route out. The lockfile check (`checkLockfile`) still runs first and names git, file, link, workspace and non-registry sources for what they are; then `dependencyFetchProblem` refuses any package the install would download, even from the registry.

### Host disk and cleanup

The scripts step mounts the staged tree read-write from the host's work root and runs repository code. So their writes are bounded on three levels:

- Each jailed step runs with `RLIMIT_FSIZE` at `BUILD_MAX_FILE_BYTES` (256 MiB, configuration): no single file, sparse or not, can pass it (`truncate` to 1 TiB fails with `EFBIG`).
- After the scripts step, before the tree becomes a build context, `checkBuiltTree` walks it with `lstat` (links counted, never followed) and an explicit stack. More than `BUILT_TREE_CAPS.maxEntries` (200 000) entries, more than `maxBytes` (2 GiB, the sum of `st_size`, which is what `COPY .` writes for a sparse file), any FIFO, socket or device, or any directory the host cannot read stops the build at that step (`failed`, reason with tree-relative paths).
- **Host setup:** the work root should sit on its own filesystem or quota, so that what a step writes before the walk sees it (up to the tree caps, plus `/scratch` and `/tmp` in RAM) cannot fill the host disk. Not enforced by this code.

Build steps write into the staged tree as uid 65534, which the host user cannot delete. A jailed janitor container, as the same user, first gives owner rwx to every directory that lacks it, one at a time as `find` visits it and before it descends (a build script can leave `chmod 000` directories that even uid 65534 cannot descend into; busybox `chmod -R` does not work here because it stops at the host-owned `/w`), and then runs `find /w -mindepth 1 -delete`; its exit status is checked. The host then removes the build directory. Cleanup never throws, so it cannot replace the build's real outcome. If the directory is still there afterwards, the outcome carries `leftovers` (a separate operational signal, not an error), or a process warning is emitted when the build itself threw.

### Reasons never carry host paths

Outcome reasons end up in evidence and the courtroom UI. Errors from `execFile` begin with `Command failed: <bin> <args>`, which repeats every host path in the arguments, so only their stderr is used (`execErrorText`). Every build reason then goes through `scrubPaths`, which replaces the tree, build directory, source checkout, work root, host temp directory and the Compose binary with `<tree>`, `<build>`, `<src>`, `<workRoot>`, `<tmp>` and `<compose>`.

### Residual risk (follow-up)

**Docker's data root fills with images.** Sidecar images can be any Docker Hub reference, with no limit on how many a compose file names or how large they are, and pulled images (sidecars, bases) and assembled target images are never removed. That is the same disk risk as unbounded build writes, on Docker's data root instead of the work root. Needs a sidecar count and size cap and an image garbage collector (assembled images carry `affidavit.sandbox.image`). Not done in this PR.

### Base allowlist and ONBUILD

The final-stage base must match `node`, `node:<tag>`, `node@sha256:<digest>` or the same under `library/` (`baseImageProblem` in `images.ts`). Anything else is `unsupported` at step `base`, before any pull. The base runs repository code in step 3, and it is the root of the assembled image. An allowlist of the official image keeps that root to one known publisher.

After pinning, `docker image inspect --format '{{json .Config.OnBuild}}'` must be empty. An `ONBUILD RUN` in a base would run during step 4 with BuildKit and no gVisor. A non-empty list is `unsupported`; an unreadable answer throws.

## Dependency bundles (L2-04c, lead decision 2026-11-20)

NodeGoat gets its dependencies through a pinned dependency bundle, built outside the jail from the corpus lockfile and mounted read only into the build. There is still no egress exception and no proxy: the network is used by one human-run step on a host, and by nothing else.

### Building a bundle (human-run, networked host, never in a jail)

```
node packages/corpus/scripts/fetch-pinned.mjs nodegoat
pnpm --filter @affidavit/sandbox bundle:build --app nodegoat \
  --checkout packages/corpus/data/src/nodegoat --out <bundle dir>
```

`packages/sandbox/scripts/build-dependency-bundle.ts` is the only Lane 2 code that fetches dependencies. It is not exported from `@affidavit/sandbox`, and the Judge and worker never call it. Two tests check this. `deny-all.test.ts` checks that nothing under `src/` imports from `scripts/`. `egress-guard.test.ts` parses every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` file under `src/` with the TypeScript compiler (not tests, test helpers or the lint itself). It runs an allowlist lint over them (`egress-guard.ts`).

**The egress guard is a lint, not a security boundary.** It raises the cost of a mistake, and of slipping a network call past review, in this package's host code. A determined author can write code a static check does not understand. The runtime boundary is gVisor with `--network none` (or an internal-only case network) and no egress for anything the Judge or an agent runs. The bundle build is a human-run host step. What the lint allows:

- **Modules (allowlist).** Relative imports, the built-ins in `ALLOWED_BUILTINS`, and the packages in this package's `dependencies` are allowed. The built-ins are `fs`, `fs/promises`, `path`, `crypto`, `stream`, `stream/promises`, `zlib`, `os`, `url`, `util`, `events`, `buffer`, `string_decoder` and `assert`, plus `child_process` in the sanctioned files only. Any other import, re-export, `import()` or `require()` is a finding (for example `http`, `net`, `vm`, `worker_threads`, `inspector`, `module`, or an undeclared package). `dockerode` is declared but unused, and importing it is a finding anywhere: a Docker API client sets its own host, network mode and pulls, which the lint cannot see. So is a module name that is not a plain string literal, `createRequire`, and an aliased `require`.
- **Globals.** These are findings:
  - any value reference to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval` or `Function`
  - any reference to `globalThis`, `window`, `self` or `global` other than `typeof` (so aliasing one is a finding)
  - `process.binding`, `process.dlopen` and `process.getBuiltinModule` (dot or bracket), and computed access on `process`
  - any use of `process`, `Reflect`, `module` or `require` other than `x.member`, `typeof x` or (for `require`) a direct call. So `const { binding } = process` and `const R = Reflect` are findings.
  - `Reflect.get`, `Reflect.apply` and `Reflect.construct`
- **`child_process`.**
  - Only the files in `CHILD_PROCESS_FILES` may import it, and only as named spawn functions called directly or through `promisify`.
  - The executable must be a string literal from `ALLOWED_EXECUTABLES` (`docker`, `tar`).
  - The argv must be an inline array literal, or a `const` array literal in scope in the same file. Its elements are literals, typed values, or spreads of other such `const` arrays. The docker subcommand and the `--network` value are checked in that literal. A variable of unknown origin (a parameter, a `let`, a `const` bound to a call) is a finding. The argv may have no other spread and no package-manager or fetch-tool word.
  - **docker:** only the allowlisted subcommands: `build`, `run`, `create`, `start`, `stop`, `rm`, `rmi`, `inspect`, `kill`, `ps`, `wait`, `logs`, `image inspect|rm|ls`, `network create|rm|inspect|ls` and `volume inspect|rm|ls`. There is no `pull`, `exec`, `cp` or `push`. `build`, `run` and `create` need `--network none`, and `network create` needs `--internal`.
  - **tar:** only `-x -c -t -f -z -v` clusters, `-C`, `--no-same-owner` and `--no-same-permissions`. So there is no `--to-command`, `-I`, `--use-compress-program`, `--checkpoint-action`, `-T` or `--files-from`.
- **Reviewed exceptions.** Each one names its file, its exact finding and its reason in `EGRESS_ALLOWLIST`. It covers one call site (or `count` of them), and only inside its `within` function when one is set, so a second call site with the same label is a finding.
  - the containment `node:http` listener
  - the fixed Compose binary and its arguments
  - `docker pull` in `pullPinned`, for an image already pinned by digest
  - the sidecar readiness `docker exec` on the internal case network
  - the `@affidavit/testing` flags for the plain-Docker containment baseline
  - the docker argv built by tested builders (named by the builder, such as `args = buildGvisorRunArgs(...)`) or from run-local values
- **Network by design (human-review items for the lead).** Two reviewed exceptions reach a network on purpose. Each is a named `networkByDesign` entry in `EGRESS_ALLOWLIST`. Pulling target-named images from a public registry on the host is an egress and supply-chain decision, not a jail matter.
  - **`pinImage` pulls from Docker Hub** (`images.ts`). The Docker daemon pulls on the host to pin an image by digest. This covers the official `node` base and also the target-named compose sidecar images, since `boot.ts` calls `pinImage` for each sidecar. So a target's compose file chooses which public images the host pulls. No container runs during the pull.
  - **The plain-Docker baseline on the default bridge** (`plain-docker.ts`). The containment suite runs a probe container on Docker's default bridge, which has a route out, as the comparison case for the jail. It runs only in `pnpm containment`, never in a build, a boot or a trial.
- **Self-tests.** Every rule has one, including every evasion from the #55 re-review, delta review and final delta review, and the `.js`, `.jsx`, `.mjs` and `.cjs` cases. A test also fails on a stale allowlist entry.

The builder script refuses to run inside a container. It:

1. Takes the app's commit from the corpus loader (`getApp`) and checks the checkout's `HEAD` is that commit, then reads `package-lock.json` and `package.json` from git at that commit (the committed bytes, not the work tree), and the app's reviewed dev exclusions from `packages/sandbox/bundle-exclusions.json` (below).
2. Plans two sections with `planLockfile`: `production` and `dev`. A section with any package that is a link or workspace, comes from git, a file or another host, has no resolved URL or integrity hash, or that the lockfile marks `hasInstallScript`, is written as `unsupported` with every such package named, and nothing is fetched for it. An optional package whose `os` rules out Linux (NodeGoat's `fsevents`) is skipped, as npm skips it on Linux.
3. Runs `npm cache add --ignore-scripts` for each resolved URL into an empty temporary cache, with empty user and global npm config and the public registry. Nothing is installed or unpacked and no script runs.
4. Checks every hash in each package's lockfile `integrity` against the tarball, and inspects the `package.json` and `binding.gyp` of every package root in the tarball: the package itself and any nested `node_modules/<name>` inside it (bundledDependencies) (`inspectPackageTarball`, gunzip in memory, nothing written). A `preinstall`, `install` or `postinstall` script, or a `binding.gyp` (an implicit node-gyp build), anywhere in it makes its section `unsupported`, by name. A `prepare` script does not (re-review decision, 2026-11-21): npm runs `prepare` only for the root project and for git or folder sources, never for a registry tarball, every bundled package is a registry tarball (git, file and URL sources stay refused), and the install uses `--ignore-scripts`. Such a package is recorded with `prepareScriptIgnored: true` in the manifest, under the section digest, so a reviewer sees it; opening a bundle refuses a tarball with a `prepare` script the manifest does not record. So does a lockfile entry marked `inBundle` with `hasInstallScript`. A tarball whose `package.json` name or version differs from the lockfile's is refused.
5. Writes `<out>/<sha256>.tar` and `<out>/<sha256>.json`. The tar holds `manifest.json` and `tarballs/<sha512>.tgz`, regular files only, sorted, with fixed metadata, so the same lockfile gives the same bytes (checked: two runs gave the same digest). The manifest lists, per section, every package's path, name, version, resolved URL, lockfile integrity and tarball sha512, plus a sha256 per section. The bundle's own sha256 cannot be inside it; it is the file name and is in the `.json` next to it.

A human reviews the manifest and the exclusion list, and then sets `bundleSha256` in `docker/sandbox/dependency-bundles/pins.json`.

### Reviewed dev exclusions (security relevant)

`packages/sandbox/bundle-exclusions.json` lists, per app and commit, dev packages left out of the bundle on purpose: each entry has the package name, the exact version the lockfile pins, and a reason. They are packages the test suite does not need and that cannot be bundled (an install script, or a git source). The list is written into the dev section of the manifest, under the section digest, so changing an entry or a reason changes the bundle sha256; the builder prints it, and a build that mounts the dev section reports it (`recipe.install.excludedDev`, `BuildOutcome.dependencyBundle.excludedDev`). Before the offline install the build prunes those entries, their subtrees and anything only they reach from the staged `package.json` and `package-lock.json` (both the `packages` map and the v1 `dependencies` tree npm 6 reads; `pruneExcludedDev`). An exclusion that matches nothing (a stale list) or a production package is refused, and so is a list under which a kept package still needs an excluded one (its `dependencies`, `optionalDependencies` or `peerDependencies`, as the lockfile resolves them); the refusal names both. The rest of dev is still hash-verified and script-free. **This list is a human-review item:** it decides which dev code is left out of the suite image.

NodeGoat at `c5cb68a7`, from reading its `Gruntfile.js` and `package.json`: `npm test` is `grunt test`, which is `env:test` then `mochaTest:unit` (`test/unit/*.js`). Excluded:

- `cypress@3.3.1`: only the `test:e2e`, `test:ci` and `cy:verify` scripts and `test/e2e` use it; its install script downloads a binary.
- `nodemon@1.19.1`: only the `dev` script and the Gruntfile `concurrent` task (`run`, `default`) use it; it has an install script.
- `grunt-if@0.2.0`: a GitHub tarball; only the `testsecurity` task uses it. The Gruntfile still calls `loadNpmTasks("grunt-if")`, which logs a missing module and continues (the Gruntfile also sets `force`).

**Lockfile hashes.** 257 of NodeGoat's production packages are pinned in its lockfile by sha1 only (an old lockfile). The builder checks those sha1 values, and the bundle then pins every tarball by sha512 and the whole bundle by sha256. The trust root for those packages is still the lockfile's sha1. This is a known weakness of the corpus lockfile, recorded here for review, not worked around.

### Using a bundle in the split build

`buildTarget(src, hints, { workRoot, dependencyBundle: { path, sha256, allowedRoot } })`:

| Step        | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                 | Network                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------- |
| 0. Bundle   | `openDependencyBundle`: the path must be a regular file (not a link) whose real path is under `allowedRoot`, within the size cap. A first streaming pass hashes the whole file, and nothing is created or written unless the sha256 equals the pin (fail closed, `failed` at step `bundle`). A second pass parses the tar (hashing again: a file changed in between is refused) into a fresh `0700` directory that is removed on any failure. Then the manifest and its section digests are validated, each tarball must match its sha512 name, every lockfile hash, and its package name and version (a tarball with no version is refused), and each is inspected again for install scripts. Laying out the npm cache re-reads and re-hashes every tarball, so a file changed after verification is refused | Host (our code)       | none                    |
| 2. Recipe   | As before, but `bundleCoverageProblem` replaces the no-download rule: every package the staged lockfile installs (with the dev exclusions pruned, when dev is mounted) must be in the bundle, pinned identically (path, version, resolved, integrity). A patch that changes a dependency is caught here. The target's own `preinstall`, `install`, `postinstall` and `prepare` scripts, which `--ignore-scripts` skips, are reported in `recipe.install.ignoredRootScripts` rather than silently dropped                                                                                                                                                                                                                                                                                                      | Host (our code)       | none                    |
| 3a. Install | Only the sections the recipe needs (`production`, plus `dev` for a build script or a suite image) are laid out as an npm content cache (`_cacache/content-v2/<algo>/..`, paths derived only from verified digests) and mounted read only at `/affidavit-deps`. The jail copies it to `/scratch` and runs `npm ci --offline --ignore-scripts --no-audit --no-fund` (production adds `--omit=dev` and `NODE_ENV=production`)                                                                                                                                                                                                                                                                                                                                                                                    | gVisor, as nobody     | none (`--network none`) |
| 4. Assemble | Unchanged: `docker build --network none` (`assembleBuildArgs`), no registry, no proxy, no build args                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | BuildKit, no RUN step | none                    |

Refused while reading a bundle: a digest mismatch, a symlink, hardlink, directory or other non-file entry, an absolute path, a `..` path, any name other than `manifest.json` and `tarballs/<128 hex>.tgz`, duplicate entries, more than `maxEntries` (20 000) entries, a bundle over `maxBundleBytes` (1 GiB), a tarball over `maxTarballBytes` (64 MiB), a manifest over 16 MiB, a tarball that unpacks past 256 MiB. These caps are configuration, not measurements. A tampered bundle is `failed` (`unsupported: false`); an intact bundle holding a package that needs a lifecycle script is `unsupported`, naming it.

### Production and dev sections

The runtime image mounts only `production`, so dev packages never reach an image that is attacked. The patch workbench's suite build (`devDependencies: true`) mounts `production` and `dev`. Each section is hashed on its own, and `BuildOutcome.dependencyBundle` reports the bundle sha256 and the digest of each section mounted.

**NodeGoat's dev section is complete** (356 packages) after the three reviewed exclusions. Three of its packages ship a `prepare` script in their registry tarball and are recorded `prepareScriptIgnored`: `domelementtype@2.3.0`, `entities@2.2.0` (both nested under `dom-serializer`) and `uuid@3.3.2`. The production section (396 packages) is unchanged.

**NodeGoat's own suite runs no meaningful tests.** `npm test` is `grunt test`, whose `mochaTest:unit` globs `test/unit/*.js`. NodeGoat has no `test/unit` directory (only `test/e2e` and `test/security`), and the Gruntfile sets `force`. On this host, from the bundle with no network (pruned lockfile, `npm ci --offline --ignore-scripts`, 751 packages), `grunt test` printed "No files to check...OK" and exited 0. So "suite passes" on NodeGoat proves only that the patched image builds. The real patch evidence on NodeGoat is the family rerun plus the counterexamples.

### Digest as an evidence input

`BuildOutcome.dependencyBundle.sha256` (and `BootedTarget.dependencyBundleSha256` in the Judge) is an input of the image. The contract has no dedicated field and contracts are not edited here, so `dependencyBundleToolVersions({ vulnerable, safe })` gives `BundleManifest.toolVersions` entries `dependency-bundle:<variant> = sha256:<hex>`. **Gap:** `packages/evidence` has no `BundleManifest` builder or `replay` yet (its `index.ts` exports nothing), so there is no clean slot to implement this in. When L2-08 lands, `replay` must read those keys, build with the same pinned bundle, and refuse to replay if the bundle digest differs. `targetDigests` stays the image ID; a different bundle gives different node_modules layers and so a different image.

**Wiring.** `pinnedDependencyBundle({ app, commit, path, storeRoot })` resolves the file's real path, and refuses one outside the configured bundle store (`storeRoot`, absolute; links are followed first, so a link in the store that points out is refused). It then hashes the file and returns a ref only when the digest equals the pin in `pins.json`; a null pin or a mismatch throws, saying a human must run the builder, review the manifest and set the pin. The ref's `allowedRoot` is the store root, not the bundle's own folder. The patch workbench takes `dependencyBundle` in its options and passes it to `bootVariant` and the suite `buildTarget`, and opens the bundle (verified the same way) to give its manifest to the suite `deriveRecipe` precheck. `nodegoat.integration.test.ts` and `bundle.integration.test.ts` build the ref from `AFFIDAVIT_NODEGOAT_BUNDLE` (the bundle file) inside `AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT` (the store) this way, so they fail closed until a pin is set.

### What has run where

- Windows, no gVisor (this PR): unit tests for planning, inspection, bundle writing and opening (every refusal above), coverage, the install command and the build args. `offline-install.test.ts` runs the host's real npm against a materialized bundle cache with registry and proxies pointed at a closed port: a devDependency resolves for the suite build, the runtime build gets production only, and a missing section fails instead of fetching. `buildTarget` refusing a wrong digest at step `bundle` also runs here (it fails before any jail step).
- NodeGoat, on this Windows host with network, run by the Lane 2 agent after the re-review fixes: the builder produced `57e33bc3e70ae6434374f0341ecb16e3abe83141f751baa59d6f7f20fa8420da` (18 001 408 bytes; production section `311eb5b271a6c8363ec4e7ffba38ab48682283baf59e39800ce90a153b8a8df0`, 396 packages; dev section `ba0ff21b7d688b77691dad3404683a756df04a5e92e9e9e111e2054d54723297`, 356 packages, with the three exclusions recorded), twice, with the same digest. (The earlier `ab739bc5...` and `43397670...` digests are superseded.) The suite install and `grunt test` described above also ran here from it. Opening it verified, coverage against NodeGoat's lockfile passed for production, and host `npm ci --offline --ignore-scripts --omit=dev` from it installed 395 packages (express, mongodb, swig, forever, needle present) with no network. **That digest is not pinned:** `pins.json` keeps `null` until a human rebuilds it on a networked host, gets the same digest, and reviews the manifest.
- Sandbox host: `bundle.integration.test.ts` (a target whose dependency comes only from the bundle builds and boots healthy; the suite build resolves a devDependency; a wrong digest is refused; NodeGoat builds and boots from its pinned bundle when `AFFIDAVIT_NODEGOAT_DIR`, `AFFIDAVIT_NODEGOAT_BUNDLE` and a pin are set) is written but **has not run**. The in-jail `npm ci` has not run on NodeGoat's `node:12-alpine` (npm 6) base; that npm reads the cache the same way (content by integrity) but this is unverified.

## Boot

`bootTarget` starts, all on the case network and all under gVisor with the usual jail flags:

1. A stub for each `ExternalStub` (`http` and `s3` answer anything on port 80, `smtp` on port 25). HTTPS is not stubbed: the target would not trust a stub certificate.
2. Each compose sidecar (for NodeGoat, `mongo:4.4`), pinned by digest, with a capped tmpfs over every VOLUME the image declares. See "Volumes" below.
3. The seed script, if the hints name one (`kind: script`; SQL seeds are not supported yet). See "Seeding" below.
4. The target, with the compose command, else Dockerfile ENTRYPOINT and CMD, else `npm start`.
5. A probe container polls `http://target:<port><healthRoute>` until it answers 2xx or 3xx.

If the target never becomes healthy, it runs once more under the syscall trace. A connect outside the case network, or a failed name lookup in its output (inside gVisor only `/etc/hosts` names resolve, so a lookup fails before any connect), makes it `unsupported`. Anything else is `failed`.

### Timeouts

`healthTimeoutMs` comes from the boot hints, which are untrusted. The recipe clamps it to `MAX_HEALTH_TIMEOUT_MS` (180 000 ms, configuration, not a measurement). The seed run, the health probe and the diagnosis run all derive their waits from the clamped value. `buildTarget` and `bootTarget` both check the recipe with `recipeProblem`, so a bad working directory, environment key, host alias, port or timeout is an `unsupported` outcome, never an exception thrown while a run is set up.

Docker or jail errors during boot (a pull, a start, a teardown check) are a `failed` outcome, not an exception out of `bootTarget`.

### Volumes

A sidecar whose image declares a volume the jail cannot put a tmpfs over (`/tmp`, `/etc`, `/`, and the other reserved paths) is `unsupported`.

`main` refuses any image that declares a `VOLUME`, because Docker would create an anonymous, host-backed volume that can outlive the container (`sandbox-runner.md`, "No volumes"). Witness runs and build steps keep that rule unchanged. Sidecars are the one exception, and only in `startJailedService`: an image's declared volumes are accepted only when a tmpfs from the recipe covers each one exactly (`uncoveredVolumes`). After `docker run --detach` the container's mounts are read back, and if Docker created any volume anyway, the container is removed with its volumes and the boot throws.

### Seeding (lead decision, pending sign-off)

A seed script is code from the target's repository, run with `node <path>` from the target's image before the target starts. It is untrusted code. It runs under the same jail as the target: gVisor, the case network with no route out, no host path, and the clamped timeout. It does not widen what the target itself can do. Even so, it runs repository code at a point where the target has not been shown to boot. Accepting it at all is a lead decision. It needs Adrian's sign-off before it is relied on; until then it is off the gate path (NodeGoat needs no seed script).

## Jail flags added for services and builds

All opt-in; witness runs keep the L2-03 flags (checked by the containment suite, 8 of 8 on 2026-11-15).

- `writableTmpMb`: a capped writable `/tmp` (MongoDB puts its socket there). Witnesses keep a read-only `/tmp`.
- `tmpfs`: capped writable tmpfs mounts, for image volumes. Reserved paths (`/`, `/proc`, `/sys`, `/dev`, `/etc`, `/scratch`, `/tmp`) are refused.
- `env` and `workdir`. `HOME` and `TMPDIR` stay `/scratch`. A working directory may not be or sit under a reserved path.
- There is no network option besides `none` and a per-case internal network. A run spec with an unknown key (`fetch`, `egress`, `dns`, ...) throws.
- Host aliases on a case network may now be dotted names, for stubs such as `payments.example.com`.

## Environment values

Compose values written in the file are used as is; `${...}` values are never resolved. A key the compose file names without a value stays unset, as it would under Compose on a host without it (for NodeGoat, `NODE_ENV` unset means its development config). Keys in `bootHints.env` that nothing else sets get `affidavit-synthetic`.

## Compose precheck

Before Compose sees the file, `scanYamlKeys` (`yaml-keys.ts`, our own code, no YAML library) tokenizes it and reports every mapping key and whether its value is empty. Keys that read other files are refused wherever they are written: `include`, `extends`, `env_file`, `label_file`, `secrets`, `configs`, `ssh` and `additional_contexts`, compared case-insensitively. That covers `x-` extension blocks, flow style (`{env_file: x}`, and `{env_file:/x}` with no space) and quoted keys. An empty value (`secrets: []`, `secrets:` with nothing under it) names no file and is allowed.

Anything outside the subset is refused, so the target is `unsupported` (fail closed): YAML tags (Compose's `!reset` and `!override`, `!!binary`), explicit `?` keys, directives, more than one document, tab indentation, NUL, a byte order mark, a bare carriage return and the other characters go-yaml treats as line breaks (NEL, U+2028, U+2029), reserved indicators, anchors, aliases and merge keys (`<<`), a flow collection spanning lines, a key that spans lines, a double-quoted key with an escape, duplicate keys in one mapping, unterminated quotes and unbalanced brackets.

The scanner is a security check, so it only skips text where it knows exactly where that text ends. A block scalar (`|` or `>`, optionally with `+` or `-` and a comment) is read only as the value of a key that is the first token on its line. Its content is the following lines indented deeper than that key; it must have at least one content line, and no content line may be less indented than the first. Any other block scalar is refused: after `- `, after an anchor, inside a flow collection, with an indentation indicator (`|2`) or with text after the header. An earlier version measured a block scalar against the indentation of its header line, so `- a: |` followed by a key at the mapping's column would have been skipped as scalar text while Compose read it as a key (security review, 2026-11-20).

The scanner and Compose are different parsers and could disagree on an edge case. So the normalized output of Compose's `config --no-interpolate` (JSON, read with `JSON.parse`) is walked again with `findHostReadingKey`, and the recipe is refused if Compose's own reading has any of those keys. Compose has then read the file, but nothing it read reaches a container.

### Compose runs on the host, with nothing from the tree

Normalizing is the one step that runs a CLI on the host against the tree. The Docker CLI loads plugins from `$DOCKER_CONFIG` or `$HOME/.docker` (`cli-plugins/`, and `cliPluginsExtraDirs` in `config.json`), and `config.json` can also choose a context and proxies. An earlier version ran it with the tree as `HOME` and working directory, so a repository shipping an executable `.docker/cli-plugins/docker-compose` would have had it run on the host, outside any jail. Now:

- The Compose v2 binary is run directly from a fixed absolute path (`COMPOSE_BIN_PATHS`, the Docker CLI's system plugin directories, or `AFFIDAVIT_COMPOSE_BIN` set by the host), never found through `PATH`, `HOME` or `DOCKER_CONFIG`. A host with Compose only under a user's `~/.docker` (Docker Desktop) must set `AFFIDAVIT_COMPOSE_BIN`.
- Its working directory, `HOME` and `DOCKER_CONFIG` are a fresh, empty, 0700 directory made with `mkdtemp` outside the tree and removed afterwards (`withEmptyDockerConfig`). `composeConfigInvocation` refuses a config directory inside the tree. The tree reaches Compose only as `--project-directory` and the `-f` path. No other host variable is passed.
- Staging drops `.docker` along with `.git`, `.env*` and `.npmrc`.

The only other host-side CLI call that touches the tree is the assemble step's `docker build`. It runs with the host's own environment and working directory, and the tree is only its build context (the generated Dockerfile's own ignore file takes precedence over the tree's).

## Limits of the MVP

- npm only (`package-lock.json` v1 to v3). Yarn and pnpm targets are `unsupported`.
- Base images: official `node` only. Sidecar images must be plain Docker Hub names (no registry host, which could point the Docker daemon at an internal address).
- The final Dockerfile stage cannot build on an earlier stage, and compose build args are not supported.

## Sandbox-host runs

**After the 2026-11-20 rework: not run.** The rework (no fetch, no js-yaml) was made on a Windows machine without gVisor. `pnpm --filter @affidavit/sandbox test:sandbox-host` has not run on it. The NodeGoat cases now assert `unsupported`; a new case checks a build script reaches neither the registry, a public IP nor cloud metadata, and that no `affidavit-egress-` network exists. The fetch-network cases were removed with the fetch step.

**Before the rework (2026-11-16, owner's workstation, history):** on the earlier tip of PR #18, with the fetch step, 337 of 337 sandbox-host tests passed with NodeGoat `c5cb68a7`, including NodeGoat vulnerable and safe building through the proxy and booting healthy. Those results no longer describe this code. Two fixes from that run are still in: the janitor (`find /w -mindepth 1 -type d ! -perm -u=rwx -exec chmod u+rwx {} \;`, which fixes each locked directory before descending) and the case-network gateway check.

Build and boot times: [metric] until they are measured on the shared sandbox host.
