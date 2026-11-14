# Witness protocol (L2-05)

A witness is a small parameterized TypeScript test over a finite `ParamSpace`. The Judge runs it with Vitest inside the fixed runner image, in the witness jail (`witness-jail.md`), against the target's internal hostname, and reads one result per parameter.

Status on 2026-11-14, on the Lane 2 owner's workstation: a hand-written witness family runs every parameter in the jail, reports per-parameter results, and is admitted on the differential rule with `familyResults` for every parameter (`packages/judge/src/jail/jail.integration.test.ts`).

## Writing a witness

```ts
import { expect } from 'vitest';
import { witness } from '@affidavit/witness';

interface Params {
  payload: string;
}

witness<Params>(async ({ payload }, { target }) => {
  const res = await fetch(`${target!.url}/item?id=${encodeURIComponent(payload)}`);
  expect(res.status).toBe(500);
  expect(await res.text()).toContain('SQL syntax error');
});
```

with the family's ParamSpace in `Witness.params`, for example `[{ "name": "payload", "values": ["'", "1' OR '1'='1", "1'--"] }]`.

- `witness(fn)` is called exactly once. `fn` runs once per combination of the ParamSpace, each as its own Vitest test named `affidavit param <index>`.
- A parameter passes when its test passes: no failed `expect` and no throw. It fails otherwise, including when it exceeds the per-parameter timeout.
- `params` maps each parameter name to one value. `target.url` is the target's base URL on the case network (`http://target:<port>`), or `target` is null when the run has no target.
- Types are stripped, not checked. A witness that does not parse fails `completes`.
- Imports available: `vitest`, `@affidavit/witness`, and Node built-ins. Nothing else is installed in the image, and the jail has no network to fetch anything.

The types are in `docker/sandbox/witness-runner/witness-api.d.mts`.

## The runner

`docker/sandbox/witness-runner/` builds the image:

| File                                   | Role                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                           | Pinned `node:22-alpine` base; installs Vitest with `npm ci` from the lockfile; runs as uid 65534; `NO_COLOR=1` so stdout, which the Judge hashes, has no colour codes |
| `package.json`, `package-lock.json`    | Vitest 5.1.0, the same version the repo tests with, and nothing else                                                                                                  |
| `run.mjs`                              | Starts Vitest on `/runner/witness/witness.test.ts` and writes the artifact                                                                                            |
| `witness-api.mjs`, `witness-api.d.mts` | `@affidavit/witness`                                                                                                                                                  |

`buildRunnerImage()` (`packages/judge/src/jail/harness.ts`) builds it with `docker build` on the host, which needs network for `npm ci`; the image then only ever runs in the jail, with none. The Judge runs it by image ID (`sha256:...`), a content hash of the image, which the sandbox accepts as pinned. A bundle (L2-08) will record that ID. Rebuild with `pnpm --filter @affidavit/judge runner-image`. The build passes `--provenance=false --sbom=false` and `SOURCE_DATE_EPOCH=0`: without them every build of an unchanged context produced a new image ID (the build time in the image config and BuildKit's provenance attestation), so the same witness could have run on a different ID each time. With them, three builds in a row gave one ID. Reproducing the ID on another machine is not claimed yet; that is L2-08's replay check.

The witness directory is mounted at `/runner/witness`, inside the image's `/runner`, so the witness resolves `vitest` from the image's `node_modules`. Vitest runs with its module cache off (the root filesystem is read-only), its Vite cache in `/scratch`, one worker process, and files not in parallel.

### Input and output

`/runner/witness/input.json` (`HarnessInput`):

```json
{ "schemaVersion": 1, "params": [...], "target": { "url": "http://target:4000" }, "testTimeoutMs": 120000 }
```

`/out/result.json` is the result artifact defined in `packages/judge/src/artifact.ts` and `rules-of-evidence.md`:

```json
{ "schemaVersion": 1, "results": [{ "paramIndex": 0, "passed": true }, ...] }
```

`paramIndex` follows the cartesian product with the last parameter varying fastest. The Judge turns the vulnerable variant's first attempt into `ExhibitResult.familyResults`.

`run.mjs` writes the artifact only when every index from 0 to n-1 was reported exactly once. Each of these writes nothing, so the Judge rejects the run as `completes`:

- the witness never calls `witness()`, or calls it twice;
- it does not parse;
- it declares its own test named like a parameter, which would duplicate an index or add one out of range.

A witness can still write `/out/result.json` itself, for example and then kill the runner. That gives it nothing (it already decides its own pass or fail), and the Judge parses the artifact as untrusted: a malformed or oversized one is rejected by `schema` (tested).

### Timeouts

`testTimeoutMs` is the Judge's hard timeout, so Vitest never ends a parameter before the jail would. The jail's hard timeout bounds the whole run, Vitest's startup included (about 1.2 s under gVisor on the owner's workstation).

## What changed in the containment suite

The `bounded-wall-clock` probe used to rely on a timer to stay alive. Under Vitest that is not enough: Vitest closes a worker with only a timer left once its tests are done, so the run ended without the jail's timeout and the attempt was not recorded. The probe now also blocks on a top-level `await` that never settles, which no harness can finish, so only the jail's timeout stops it. All three runners (gVisor, witness jail, plain Docker) still stop it at its timeout.

## Open items

- Lane 3's Defense prompts must produce this format; the example above and `witness-api.d.mts` are the reference. Not changed here (Lane 3 files).
- Witnesses for real targets (NodeGoat) arrive with L2-04 and the gate witness.
