# Boot recipes (L2-04)

`packages/sandbox/src/boot` builds a target from its checkout and boots it on a case network. Entry points: `buildTarget(srcDir, bootHints, { workRoot })` and `bootTarget(caseNetwork, imageId, recipe)`.

## Why a split build

A target's Dockerfile usually runs `npm install`, which needs the network and runs package install scripts. `docker build` runs RUN steps with runc and full egress, outside gVisor, which the threat model does not allow ("Docker alone is not the boundary"). A Remedy patch would have its code built the same way. So the target's RUN steps are never executed as written (decision 2026-11-15, chosen by the Lane 2 owner):

| Step        | What runs                                                                                                                                                          | Where                        | Network                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1. Stage    | Copy of the checkout: regular files only. No `.git`, `node_modules`, `.env*`, `.npmrc`, symlinks                                                                   | Host (our code)              | n/a                                                                                                        |
| 2. Recipe   | Boot hints (parsed with the contract schema first), compose file and Dockerfile are read, never run. The lockfile must only point at `https://registry.npmjs.org/` | Host (our code)              | none                                                                                                       |
| Base        | The final-stage base must be an official `node` image. It is pinned by digest, and refused if it has `ONBUILD` triggers                                            | Host (our code)              | Docker Hub pull, by the daemon                                                                             |
| 3. Fetch    | `npm ci --ignore-scripts` (`--omit=dev` unless the app has a `build` script), run with Lane 2's own pinned npm image (`FETCH_IMAGE`), never the target's base      | gVisor, as nobody            | A fresh internal case network whose only peer is a CONNECT proxy that forwards to `registry.npmjs.org:443` |
| 4. Scripts  | `npm rebuild` (dependency install scripts), then `npm run build` if present, with the pinned base image                                                            | gVisor, as nobody            | none                                                                                                       |
| 5. Assemble | `docker build --network none` from a generated Dockerfile with only `FROM <base@digest>`, `COPY` and `WORKDIR`                                                     | BuildKit, no RUN step exists | none                                                                                                       |

The fetch step is the only one with a route out, and it runs no repository or package code (install scripts are off). The lockfile check refuses git, file, link, workspace and non-registry tarball sources. Dev-only entries are skipped when the install omits dev dependencies, because they are never downloaded. Integrity hashes are checked by npm when the lockfile has them; old lockfiles often do not, which is accepted.

### Host disk and cleanup

The fetch and scripts steps mount the staged tree read-write from the host's work root, and the scripts step runs repository and package code. So their writes are bounded on three levels:

- Each jailed step runs with `RLIMIT_FSIZE` at `BUILD_MAX_FILE_BYTES` (256 MiB, configuration): no single file, sparse or not, can pass it (`truncate` to 1 TiB fails with `EFBIG`).
- After the fetch step and again after the scripts step, before the tree becomes a build context, `checkBuiltTree` walks it with `lstat` (links counted, never followed) and an explicit stack. More than `BUILT_TREE_CAPS.maxEntries` (200 000) entries, more than `maxBytes` (2 GiB, the sum of `st_size`, which is what `COPY .` writes for a sparse file), any FIFO, socket or device, or any directory the host cannot read stops the build at that step (`failed`, reason with tree-relative paths).
- **Host setup:** the work root should sit on its own filesystem or quota, so that what a step writes before the walk sees it (up to the tree caps, plus `/scratch` and `/tmp` in RAM) cannot fill the host disk. Not enforced by this code.

Build steps write into the staged tree as uid 65534, which the host user cannot delete. A jailed janitor container, as the same user, runs `chmod -R u+rwX /w` (a build script can leave `chmod 000` directories that even uid 65534 cannot descend into) and then `find /w -mindepth 1 -delete`; its exit status is checked. The host then removes the build directory. Cleanup never throws, so it cannot replace the build's real outcome. If the directory is still there afterwards, the outcome carries `leftovers` (a separate operational signal, not an error), or a process warning is emitted when the build itself threw.

### Reasons never carry host paths

Outcome reasons end up in evidence and the courtroom UI. Errors from `execFile` begin with `Command failed: <bin> <args>`, which repeats every host path in the arguments, so only their stderr is used (`execErrorText`). Every build reason then goes through `scrubPaths`, which replaces the tree, build directory, source checkout, work root, host temp directory and the Compose binary with `<tree>`, `<build>`, `<src>`, `<workRoot>`, `<tmp>` and `<compose>`.

## The fetch network

The allowlist is enforced by the network, not by name resolution. (An earlier version only withheld DNS and added a hosts entry for the registry on a bridge with egress, so a dependency fetch could still reach any IP literal, the bridge gateway and the host. That claim was wrong and is withdrawn.)

Each build gets its own setup, created and removed by `createFetchEnv` and `removeFetchEnv` in `fetch.ts`. Nothing is shared across builds or cases.

- npm joins a fresh case network: `--internal`, IPv6 off, and `inhibit_ipv4` so the host side of the bridge has no address (see `witness-jail.md`). From there an IP literal, the bridge gateway, the host, RFC 1918 and link-local addresses are all unreachable. There is no DNS server (`--dns 0.0.0.0`). The proxy is the one `/etc/hosts` name.
- The proxy joins that network and a fresh egress bridge (IPv6 off, no inter-container traffic). It is a few lines of our own Node (`PROXY_SCRIPT`), started from `FETCH_IMAGE` under gVisor. It answers only `CONNECT registry.npmjs.org:443`, and everything else gets 403 (plain HTTP, another host, another port, an IP literal). It never resolves a name. It dials only the addresses the host resolved before the build, each of which must be a public IPv4 address (`publicIpv4Problem`, so a rebinding answer such as `169.254.169.254` aborts the build). TLS runs end to end between npm and the registry.
- npm is pointed at the proxy with `npm_config_proxy` and `npm_config_https_proxy`.

The proxy is attached to the internal network with `docker network connect` before `docker start`. That two-network start under runsc has unit tests for its arguments only; it has not yet run on a sandbox host.

The proxy is bounded (`PROXY_LIMITS`, configuration): 64 concurrent connections, 8 KiB of headers within 10 s, 15 s per request, a 10 s upstream dial, and 60 s idle on either side of a tunnel. Teardown removes the proxy, then the egress bridge, then the internal network, and throws if `docker network inspect` still finds the egress bridge afterwards.

Every failure in this step (pulling `FETCH_IMAGE`, resolving the registry, creating or removing the setup) is a `failed` outcome at step `fetch`, never an exception out of `buildTarget`.

### Residual risks (need the lead's acceptance)

1. **The proxy's own network reach is not firewalled.** The egress bridge is an ordinary Docker bridge, so at the network layer the proxy container could reach the host's bridge gateway, RFC 1918 addresses and `169.254.169.254`. What stops that today is the proxy's code: it dials only the checked public addresses, on 443, and takes no address from the client. A bug in Node's HTTP parser that gave the client code execution inside the proxy would remove that check. The fix is host firewall rules in the `DOCKER-USER` chain that let traffic from each egress bridge reach only the resolved registry addresses on 443. The orchestrator runs as an unprivileged member of the docker group and cannot write iptables rules, so this needs a privileged host-setup helper (sandbox host setup, P0-10). Not done in this PR.
2. **Domain fronting.** The proxy checks the CONNECT target, not what travels inside the TLS tunnel. The registry sits behind a shared CDN, so a client that controls TLS could ask the CDN for another hostname (a different SNI or `Host`) through a tunnel opened to `registry.npmjs.org:443`. In the fetch step the only client is Lane 2's npm, with install scripts off and a lockfile that names only registry URLs, so no repository or package code is running that could do this. The risk is that npm itself is steered (a bug, or a crafted registry response), which would give a channel to other sites on the same CDN, but no route into the host or the case network.

3. **Docker's data root fills with images (follow-up).** Sidecar images can be any Docker Hub reference, with no limit on how many a compose file names or how large they are, and pulled images (sidecars, bases, `FETCH_IMAGE`) and assembled target images are never removed. That is the same disk risk as unbounded build writes, on Docker's data root instead of the work root. Needs a sidecar count and size cap and an image garbage collector (assembled images carry `affidavit.sandbox.image`). Not done in this PR.

### Why a Lane 2 npm image

The target's base image is untrusted. Running npm from it would let the target choose the npm (or a `node` binary) that runs on the one step with a route out. `FETCH_IMAGE` is `node:22.11.0-bookworm-slim` pinned by its index digest, owned by Lane 2 and bumped deliberately. It is Debian (glibc), so a target on an Alpine (musl) base may get glibc builds of platform-specific optional packages. `npm rebuild` in step 4 runs with the target's base and rebuilds native modules from source where they ship it. Packages that ship only prebuilt binaries for one libc are a known gap.

### Base allowlist and ONBUILD

The final-stage base must match `node`, `node:<tag>`, `node@sha256:<digest>` or the same under `library/` (`baseImageProblem` in `images.ts`). Anything else is `unsupported` at step `base`, before any pull. The base runs repository and package code in step 4, and it is the root of the assembled image. An allowlist of the official image keeps that root to one known publisher.

After pinning, `docker image inspect --format '{{json .Config.OnBuild}}'` must be empty. An `ONBUILD RUN` in a base would run during step 5 with BuildKit and no gVisor. A non-empty list is `unsupported`; an unreadable answer throws.

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
- `fetch`: `{ name, proxy }`. Joins a per-build case network with no DNS and one hosts entry, the proxy.
- `egress`: a per-build egress bridge (`affidavit-egress-<16 hex>`), with no DNS. Only the fetch proxy uses it.
- A run joins exactly one of a case network, a fetch network or an egress network; asking for two throws.
- Host aliases on a case network may now be dotted names, for stubs such as `payments.example.com`.

## Environment values

Compose values written in the file are used as is; `${...}` values are never resolved. A key the compose file names without a value stays unset, as it would under Compose on a host without it (for NodeGoat, `NODE_ENV` unset means its development config). Keys in `bootHints.env` that nothing else sets get `affidavit-synthetic`.

## Compose precheck

Before Compose sees the file, it is parsed into a tree with `js-yaml` (core schema) and walked to any depth. Keys that read other files are refused wherever they appear: `include`, `extends`, `env_file`, `label_file`, `secrets`, `configs`, `ssh` and `additional_contexts`. That covers `x-` extension blocks, anchors and aliases, merge keys (`<<: *base`), flow style (`{env_file: x}`) and quoted or escaped keys. Custom tags (Compose's `!reset` and `!override`), duplicate keys, several documents and unparseable text are refused (fail closed). An empty value (`secrets: []`) names no file and is allowed.

`js-yaml` and Compose are different parsers and could disagree on an edge case. So the normalized output of Compose's `config --no-interpolate` is walked again with the same check, and the recipe is refused if Compose's own reading has any of those keys. Compose has then read the file, but nothing it read reaches a container.

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

## Verified on the sandbox host (2026-11-15, owner's workstation)

This evidence predates the hardening above (the fetch proxy, the Lane 2 npm image, the base allowlist, ONBUILD refusal, the YAML precheck, the timeout clamp, `main`'s volume refusal, the host-side Compose isolation, the build write caps and the cleanup changes). `test:sandbox-host` must be re-run on the hardened tip before it counts, together with the new sandbox-host tests: the fetch step cannot reach an IP literal, cloud metadata or the bridge gateway; the proxy refuses other hosts; ONBUILD is detected; a non-node base is refused; a `.docker/cli-plugins/docker-compose` shipped in the tree never runs; a build script cannot write a 1 TiB sparse file or a tree over the byte cap; a `chmod 000` directory left by a build script is cleaned up; and failed build reasons carry no host paths.

`pnpm --filter @affidavit/sandbox test:sandbox-host` with `AFFIDAVIT_NODEGOAT_DIR` pointing at OWASP NodeGoat `c5cb68a7`:

- NodeGoat vulnerable and safe (its own documented `$where` fix) build, boot healthy with the mongo sidecar, and return their image IDs.
- A target that needs an external HTTP service boots against a stub.
- A target that connects to an outside address, and one that looks up an outside name, are `unsupported`. Each detection path was disabled in turn and its test failed.
- A target that never listens is `failed`. A lockfile pointing outside the registry is refused before any build step.

Build and boot times: [metric] until they are measured on the shared sandbox host.
