# gVisor sandbox runner (L2-02)

The runner lives in `packages/sandbox/src/gvisor/`. It runs one command in a fresh gVisor container with deny-all egress, tears the container down, proves nothing is left, and reads gVisor's syscall trace to record what the jailed process tried. Two entry points:

- `GvisorRunner` (a `JailRunner`) for the containment suite and, from L2-03, for witnesses. It always records a trace and refuses to report a run it could not observe.
- `GvisorToolRunner` (`ToolRunnerPort`) for Lane 1's scanners. Same jail and flags, no trace (see "Tools run untraced").

Status on 2026-11-14: the containment suite passes 8 of 8 on gVisor, contained and recorded, on the Lane 2 owner's workstation (`containment.md`). The shared sandbox host and CI runner do not exist yet (open decision 1 in `docs/decisions.md`).

## Host setup

A sandbox host needs Linux, Docker, and the two scripts in `docker/sandbox/`, run once as root:

```bash
sudo bash docker/sandbox/install-gvisor.sh      # runsc, checksum-verified, pinned release
sudo bash docker/sandbox/setup-runsc-audit.sh   # the traced runtime, ends with "AUDIT OK"
```

The second script registers a Docker runtime called `runsc-affidavit`: runsc with `--strace` for a fixed list of syscalls and `--debug-log=/var/lib/affidavit-runsc/%ID%.%COMMAND%.txt`. The directory is `root:docker`, mode 2770, with a docker group default ACL and the SELinux type `container_var_lib_t` so dockerd can write there. The user running the sandbox must be in the `docker` group, which can read and delete the traces. The trace is a file per container rather than a directory, because runsc creates per-container directories with mode 0750 and the group could not delete them.

Then check the host:

```bash
pnpm --filter @affidavit/sandbox test:sandbox-host   # integration tests against real gVisor
pnpm --filter @affidavit/sandbox containment         # must show 8 of 8
```

## The jail

`buildGvisorRunArgs` (`args.ts`) builds every container's flags; `args.test.ts` pins each one.

| Flag                                                                               | Why                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--runtime runsc-affidavit`                                                        | The process talks to gVisor's kernel, never the host's, and every attempt is traced                            |
| `--network none`                                                                   | No interface except loopback                                                                                   |
| `--read-only`, read-only tmpfs on `/tmp` and `/dev/shm`, tmpfs `/scratch` (64 MiB) | `/scratch` is the only writable path; containment finding 5 showed `/dev/shm` writable under the Phase 1 flags |
| `--user 65534:65534`, `--cap-drop ALL`, `no-new-privileges`                        | Unprivileged inside the jail as well                                                                           |
| `--memory 1024m --memory-swap 1024m`                                               | Swap equal to memory, so the limit cannot be stretched (containment finding 1)                                 |
| `--pids-limit 256`, `--cpus 1`, `--ulimit nofile=1024:1024`                        | Bounded resources                                                                                              |
| `--log-driver none`                                                                | Output is captured by the runner (capped at 2 MiB per stream), not stored by Docker                            |
| `--label affidavit.sandbox.run=<id>`                                               | Teardown check: after every run, `docker ps -a` filtered by that label must be empty                           |
| Image pinned by `@sha256` digest or local image ID (`sha256:...`)                  | Unpinned images are refused; both are content hashes                                                           |

Mounts go through `validateMounts` (`mounts.ts`) and are passed with `--mount`, never `-v`:

- the host path must resolve, after `realpath`, inside an allowed root (the case workspace), so `..` and symlinks cannot escape, and `/` can never be an allowed root;
- a container runtime socket is refused outright;
- paths containing `, : = " '` or control characters are refused, so a path cannot smuggle mount options;
- reserved container paths (`/`, `/proc`, `/sys`, `/dev`, `/scratch`, `/tmp`, `/etc`) are refused after normalising.

This is the allowlist that containment finding 6 recommends for `buildDockerRunArgs`.

A tool's output directory must be writable by uid 65534, because the jail runs as nobody.

## Decision for the lead: SELinux label disabled per container

gVisor cannot start under an SELinux process label (`SELinux is not supported: system_u:system_r:container_t`), so every container runs with `--security-opt label=disable`. On an SELinux host this replaces SELinux's confinement of the container with gVisor's own: the jailed process never reaches the host kernel, only gVisor's, and gVisor itself runs in its own seccomp filter. The rest of the host keeps SELinux enforcing. The alternative is a host without SELinux (for example Ubuntu with AppArmor), where the question does not arise. This needs sign-off before the shared sandbox host is chosen.

## Recording: how the trace is read

`parseTrace` (`trace.ts`) reads only syscall exit lines, which carry the result:

| Observation                   | From                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `egressAttempts`              | `connect`, `sendto`, `sendmsg`, `sendmmsg` to an IPv4 or IPv6 address that is not loopback, whether or not it failed                                                                                     |
| `deniedReads`, `deniedWrites` | Opens, creates, renames, links, unlinks and truncates refused with `EPERM`, `EACCES` or `EROFS`; any failed attempt on a sensitive host path (credential file, evidence store) counts even with `ENOENT` |
| `pidsLimitHit`                | A fork or clone refused with `EAGAIN`, or gVisor's warning that the host refused it a process (below)                                                                                                    |
| `oomKilled`, `timedOut`       | Docker's container state and the runner's own timer                                                                                                                                                      |

The runner throws, rather than reporting a clean run, when Docker or the runtime is missing, the trace is missing or empty, or a container is left behind. The trace file is deleted after reading.

### The trace is capped while the run goes

gVisor writes the trace to the host's disk during the run. Measured on 2026-11-14: one thread opening files in a loop wrote 67 MiB in 5 s, so a witness left to run to its 120 s timeout could write well over a gigabyte per attempt. The runner checks the trace size every 250 ms and kills the run when it passes 64 MiB (`DEFAULT_MAX_TRACE_BYTES`). The largest trace from a normal containment run was 1.4 MiB. A run cut off this way is reported as `tampered`: it cannot be shown to be clean, so a witness fails, and the containment runner refuses it.

The same watcher enforces the wall-clock timeout and retries `docker kill` on every tick until the Docker client exits, because a kill sent before Docker has created the container fails and would otherwise leave the run unbounded.

### The jailed process can write into the trace

Verified on runsc release-20261109.0: gVisor prints two things the jailed process controls without escaping them, its command name (up to 15 bytes, set with `prctl` or `process.title`) and path arguments.

- **Command name.** Renaming the process to `a b` made the parser skip its `connect` line, hiding the attempt. Now any syscall line whose command name contains whitespace, that does not parse, or that continues onto a line without gVisor's log prefix marks the trace `tampered`, and `GvisorRunner` refuses the run. A witness run is never judged on a tampered trace. Multi-line messages that are not syscall lines (gVisor dumps the OCI spec at startup) are ignored.
- **Paths.** A path containing a newline can add lines that look like gVisor's own. Most such paths split a syscall line and are caught as tampering, but a carefully built one can complete the line it splits. What it can do is add attempts (making its own run look worse) and misreport the one syscall that carries the path. It cannot hide a connect, because a connect line carries no path. Remaining limit: a witness could hide one of its own refused writes this way; the write is still refused, only its record is affected.

Fixing both at the source needs gVisor's structured trace points (seccheck) instead of the text strace. That is a candidate for L2-03 if the remaining limit matters for a verdict; today no verdict uses `deniedWrites`.

### The pids limit applies to gVisor, not to the jail

Docker's `--pids-limit` is enforced on the host, where it counts gVisor's own threads and the host stub process gVisor needs per address space. At the limit gVisor cannot create a stub, the jailed `execve` fails with `ENOMEM`, and gVisor logs `task_image.go: Failed to create new memory manager`, which the parser records as `pidsLimitHit`. With 256 the probe started 113 children before refusal. The bound holds; the number of jailed processes it allows depends on gVisor's thread count. gVisor also logs an internal `BUG` warning at that point; the sandbox kept running and reported normally in every run so far.

## Tools run untraced

`GvisorToolRunner` uses the plain `runsc` runtime with the same flags. Tool results are not judged, and tracing every file a scanner opens in a large repo would be slow and could exceed the trace cap, which would let a repo block its own scan. A repo file name with a newline would also mark the trace tampered. Only the image allowlist (optional), the mount allowlist and the jail apply. Exit codes: 124 when the runner's timeout stopped the tool, 137 when it was OOM-killed.

## Open items

- Shared sandbox host and CI runner (P0-10, open decision 1). Until then `runner.integration.test.ts` is skipped in `pnpm test` (see `PROGRESS.md`).
- Per-case internal network: done in L2-03 (`network.ts`, see `witness-jail.md`). Booting real targets on it is L2-04.
- gVisor logs `SECCOMP WARNING: host filesystem enabled: syscall filters less restrictive` on this host. To evaluate with `--directfs=false` on the audit runtime before the shared host is signed off.
- Lane 1's `LocalDockerToolRunner` can switch to `GvisorToolRunner` once the lead signs off the SELinux decision above.
