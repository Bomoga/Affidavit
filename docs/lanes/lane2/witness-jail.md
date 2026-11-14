# Witness jail (L2-03)

Code: `packages/judge/src/jail/` (harness, attempt directory, executor, containment adapter) and `packages/sandbox/src/gvisor/network.ts` (per-case network). The jail itself is the L2-02 runner (`sandbox-runner.md`).

The Judge runs every witness attempt through `JailExecutor`, the real `WitnessExecutor`. Each attempt is a fresh gVisor container from the fixed runner image, on the case's own network next to the target, with no credential, no handle to the evidence store and no route to the host. The Judge reads the result only after the container is gone.

Status on 2026-11-14, on the Lane 2 owner's workstation (same host as `sandbox-runner.md`):

- the containment suite passes 8 of 8 with every probe run as a witness (`containment.md`, "Witness jail");
- a hand-written witness family against a stub target is admitted on the differential rule end to end (`jail.integration.test.ts`);
- malformed and oversized artifacts are rejected by `schema`, never crash the Judge.

## One attempt

1. The executor asks a `TargetProvider` where the target for this variant is: a case network, the target's address, and a base URL. Booting real targets is L2-04; the tests start a stub target with `startJailedService`.
2. It makes a fresh attempt directory (mode 0700) holding:
   - `witness/runner.mjs`: the harness (fixed code, `HARNESS_SHA256`);
   - `witness/witness.mjs`: the witness source (untrusted);
   - `witness/input.json`: the ParamSpace and the target URL;
   - `result.json`: an empty file, mode 0666.
3. It runs the jail with `witness/` mounted read-only at `/witness` and `result.json` mounted alone at `/out/result.json`, on the case network, with `target` in `/etc/hosts`, and `RLIMIT_FSIZE` of 1 MiB.
4. When the container has exited (or was killed at the hard timeout), it is removed and teardown is checked. Only then is `result.json` read, as untrusted bytes.
5. The attempt directory is deleted. The Judge parses the artifact (`artifact.ts`) and applies the rules.

### The result mount

A single-file mount was chosen over a writable directory after checking on gVisor what the jail can do with it (as uid 65534):

| Attempt                          | Result                             |
| -------------------------------- | ---------------------------------- |
| Write the result file            | allowed                            |
| Write more than 1 MiB to it      | `EFBIG` (`RLIMIT_FSIZE`)           |
| Create a sibling file            | `EACCES`                           |
| Create a directory               | `EROFS`                            |
| Unlink or rename the result file | `EACCES`, `EXDEV`                  |
| Replace it with a symlink        | impossible (it cannot be unlinked) |

A writable directory would let a witness fill the host disk and leave files owned by uid 65534 that the Judge cannot delete. The file stays owned by the Judge's user.

`readArtifact` reads it with `O_NOFOLLOW | O_NONBLOCK`, refuses anything that is not a regular file (symlink, FIFO, directory), and reads at most the Judge's artifact limit plus one byte, so an oversized artifact reaches the Judge as oversized and is rejected by `schema`.

The witness runs in the same process as the harness and could write the artifact itself. That gives it nothing: the witness already decides its own pass or fail, and the Judge parses the artifact as untrusted whoever wrote it. What the jail must prevent is the artifact reaching beyond itself (host files, size, format), and that is what the mount and the reader enforce.

## The case network

`createCaseNetwork` creates a Docker bridge network per case:

- `--internal`, so it has no route out;
- `com.docker.network.bridge.inhibit_ipv4=true`, so the host bridge gets no IPv4 address;
- labelled with the run id, so `removeCaseNetwork` can remove the network and anything left on it, then check that nothing is left.

The second option matters. On a plain `--internal` network a witness under gVisor fetched from a host listener through the bridge gateway (containment finding 9). With the option set, the witness reached none of the host's addresses and still reached the target. `createCaseNetwork` also refuses a network whose subnet contains an address of any host interface.

Names did not resolve through Docker's embedded DNS under gVisor (observed 2026-11-14; the lookup timed out), so the target is named through `/etc/hosts` (`--add-host target:<ip>`). The jail also gets `--dns-search .`, so the host's search domains, which can name a private network, are not copied in.

Connections inside the case subnet are the witness doing its job and are not egress. Everything else that is not loopback is counted by the trace parser as an egress attempt and fails `no-egress`.

## The harness and the witness format (until L2-05)

A witness is an ES module whose default export is `async (params, ctx)`. `params` maps each parameter name to one value, and `ctx.target.url` is the target's base URL. A parameter passes when the function resolves to anything but `false`; it fails when it throws or returns `false`. The harness walks the ParamSpace with the last parameter varying fastest (the order `artifact.ts` defines) and writes one artifact at the end.

A module without a default export function writes no artifact and fails `completes`. A witness that leaves a timer running keeps the process alive after the artifact is written, and is killed at the hard timeout (fails `completes`).

L2-05 replaces this format with a TypeScript test run by Vitest inside the runner image. The jail, the mounts, the network and the artifact stay the same.

## Containment, run as witnesses

`pnpm --filter @affidavit/judge containment` runs the L2-01 suite with `WitnessJailRunner`: each probe becomes a witness (its source plus `export default () => true`), runs through the harness in the witness jail, on its own case network. The table is in `containment.md`.

## A tampered trace fails `no-egress`

The jailed process can write into gVisor's syscall trace through its command name and paths (`sandbox-runner.md`). The executor passes the parser's `tampered` flag to the Judge as `RawAttempt.traceTampered`, and `no-egress` rejects any evidence with a tampered attempt: a trace that may hide an attempt cannot show that there was none. A trace cut off at its size cap counts as tampered; such a run is also killed, so it usually fails `completes` first.

The executor reads the artifact up to the limit the Judge sends in each `ExecutionRequest` (`maxArtifactBytes`), so the two can never disagree.

## Open items

- Booting real targets on the case network (L2-04), including `ExternalStub` services.
- The Vitest witness format (L2-05).
- The target runs on gVisor without the trace (`startJailedService`). Whether target egress should also be recorded, and counted against anything, is for L2-04.
- Same host caveat as L2-02: verified on the owner's workstation, not yet on the shared sandbox host or CI.
