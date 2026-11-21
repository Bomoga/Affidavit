# Boot recipes (L2-04)

`packages/sandbox/src/boot` builds a target from its checkout and boots it on a case network. Entry points: `buildTarget(srcDir, bootHints, { workRoot })` and `bootTarget(caseNetwork, imageId, recipe)`.

## Lead decision 2026-11-20: no egress exception, no js-yaml

PR #18 asked for two exceptions. Both were declined:

- **No dependency fetch.** An earlier version of this PR let `npm ci --ignore-scripts` reach `registry.npmjs.org` through a per-build CONNECT proxy. That is gone (`fetch.ts`, the proxy, the egress bridge and the `fetch` and `egress` run spec options were removed). Deny-all egress has no exception. A target whose install would download anything is `unsupported` at the recipe step, per plan.md (Lane 2, item 3: a target that cannot boot without real egress is marked unsupported rather than granted an exception). `buildGvisorRunArgs` now refuses any run spec key it does not know, so no caller can add a route out.
- **No `js-yaml`.** The compose precheck reads the small YAML subset compose files use with our own key scanner (`yaml-keys.ts`) and refuses anything outside it.

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
