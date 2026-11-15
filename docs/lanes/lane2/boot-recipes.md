# Boot recipes (L2-04)

`packages/sandbox/src/boot` builds a target from its checkout and boots it on a case network. Entry points: `buildTarget(srcDir, bootHints, { workRoot })` and `bootTarget(caseNetwork, imageId, recipe)`.

## Why a split build

A target's Dockerfile usually runs `npm install`, which needs the network and runs package install scripts. `docker build` runs RUN steps with runc and full egress, outside gVisor, which the threat model does not allow ("Docker alone is not the boundary"). A Remedy patch would have its code built the same way. So the target's RUN steps are never executed as written (decision 2026-11-15, chosen by the Lane 2 owner):

| Step        | What runs                                                                                                                                                             | Where                        | Network                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| 1. Stage    | Copy of the checkout: regular files only. No `.git`, `node_modules`, `.env*`, `.npmrc`, symlinks                                                                      | Host (our code)              | n/a                                                                             |
| 2. Recipe   | Boot hints, compose file (`docker compose config --no-interpolate`) and Dockerfile are read, never run. The lockfile must only point at `https://registry.npmjs.org/` | Host (our code)              | none                                                                            |
| 3. Fetch    | `npm ci --ignore-scripts` (`--production` unless the app has a `build` script), npm from the pinned base image                                                        | gVisor, as nobody            | Fetch network: only `registry.npmjs.org` resolves (`--add-host`, no DNS server) |
| 4. Scripts  | `npm rebuild` (dependency install scripts), then `npm run build` if present                                                                                           | gVisor, as nobody            | none                                                                            |
| 5. Assemble | `docker build --network none` from a generated Dockerfile with only `FROM <base@digest>`, `COPY` and `WORKDIR`                                                        | BuildKit, no RUN step exists | none                                                                            |

The fetch step is the only one with a route out, and it runs no repository or package code. The lockfile check refuses git, file, link, workspace and non-registry tarball sources, so npm has nowhere else to go. Dev-only entries are skipped when the install is `--production`, because they are never downloaded. Integrity hashes are checked by npm when the lockfile has them; old lockfiles often do not, which is accepted.

Build steps write into the staged tree as uid 65534, which the host user cannot delete. A jailed janitor container, as the same user, empties the tree before the host removes the build directory.

## Boot

`bootTarget` starts, all on the case network and all under gVisor with the usual jail flags:

1. A stub for each `ExternalStub` (`http` and `s3` answer anything on port 80, `smtp` on port 25). HTTPS is not stubbed: the target would not trust a stub certificate.
2. Each compose sidecar (for NodeGoat, `mongo:4.4`), pinned by digest, with a capped tmpfs over every VOLUME the image declares (otherwise Docker would create a host-backed anonymous volume).
3. The seed script, if the hints name one (`kind: script`; SQL seeds are not supported yet).
4. The target, with the compose command, else Dockerfile ENTRYPOINT and CMD, else `npm start`.
5. A probe container polls `http://target:<port><healthRoute>` until it answers 2xx or 3xx.

If the target never becomes healthy, it runs once more under the syscall trace. A connect outside the case network, or a failed name lookup in its output (inside gVisor only `/etc/hosts` names resolve, so a lookup fails before any connect), makes it `unsupported`. Anything else is `failed`.

## Jail flags added for services and builds

All opt-in; witness runs keep the L2-03 flags (checked by the containment suite, 8 of 8 on 2026-11-15).

- `writableTmpMb`: a capped writable `/tmp` (MongoDB puts its socket there). Witnesses keep a read-only `/tmp`.
- `tmpfs`: capped writable tmpfs mounts, for image volumes. Reserved paths (`/`, `/proc`, `/sys`, `/dev`, `/etc`, `/scratch`, `/tmp`) are refused.
- `env` and `workdir`. `HOME` and `TMPDIR` stay `/scratch`.
- `fetch`: the fetch network, `affidavit-fetch`, a plain bridge with egress, labelled `affidavit.sandbox.fetch` (not the run label, so teardown checks ignore it).
- Host aliases on a case network may now be dotted names, for stubs such as `payments.example.com`.

## Environment values

Compose values written in the file are used as is; `${...}` values are never resolved. A key the compose file names without a value stays unset, as it would under Compose on a host without it (for NodeGoat, `NODE_ENV` unset means its development config). Keys in `bootHints.env` that nothing else sets get `affidavit-synthetic`.

## Limits of the MVP

- npm only (`package-lock.json` v1 to v3). Yarn and pnpm targets are `unsupported`.
- Base and sidecar images must be plain Docker Hub names (no registry host, which could point the Docker daemon at an internal address).
- The final Dockerfile stage cannot build on an earlier stage, and compose build args are not supported.
- Compose keys that read other files (`include`, `extends`, `env_file`, `secrets`, `configs`) are refused before Compose parses the file.

## Verified on the sandbox host (2026-11-15, owner's workstation)

`pnpm --filter @affidavit/sandbox test:sandbox-host` with `AFFIDAVIT_NODEGOAT_DIR` pointing at OWASP NodeGoat `c5cb68a7`:

- NodeGoat vulnerable and safe (its own documented `$where` fix) build, boot healthy with the mongo sidecar, and return their image IDs.
- A target that needs an external HTTP service boots against a stub.
- A target that connects to an outside address, and one that looks up an outside name, are `unsupported`. Each detection path was disabled in turn and its test failed.
- A target that never listens is `failed`. A lockfile pointing outside the registry is refused before any build step.

Build and boot times: [metric] until they are measured on the shared sandbox host.
