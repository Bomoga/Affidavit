# Deployment shape: proposal

Status: **proposal for the lead**. Nothing here is built or deployed. Where I have not verified something, the line says so.

## Proposed shape

| Piece                  | Where                                                                                 | Why                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Web (`apps/web`)       | Vercel, static build (already deployed from `apps/web/vercel.json` as a fixture demo) | Static, no secrets.                                                                |
| API (`apps/api`)       | Container, next to Postgres                                                           | Needs OAuth credentials and the app database role.                                 |
| Worker (`apps/worker`) | Container, next to Postgres                                                           | Composition root. Needs the worker database role and the model key.                |
| Postgres               | Container for the pilot, managed later                                                | `docker/compose.yaml` is the dev stack only. Cost of a managed instance: [metric]. |
| Judge, sandbox, signer | Linux gVisor host only                                                                | They need gVisor and Docker. They cannot run on Vercel or any serverless target.   |

## Constraints

- Production config fails closed. No model credential means the case halts with `model-unconfigured`, and a halted case is never reported as safe.
- The API and worker never see the signing key, its path or cosign output.
- The worker reaches the Judge and signer on the sandbox host. How (same host, or a private network path to the socket) is **unknown**. A unix socket does not cross hosts, so splitting the worker from the sandbox host needs a design decision.

## Unknowns for Adrian

1. Is the worker on the sandbox host or separate? Same host is simplest and matches how Lane 2 tested. Separate needs a remote signer and Judge interface that does not exist yet.
2. Which cloud or host for the API, worker and Postgres, and who pays. [metric]
3. Domain and TLS for the API and web. Not verified what is configured on Vercel today.
4. Backups and retention for Postgres and the evidence directory. Not decided.
5. Release and rollback plan, written before the first deploy (handoff gate 9).

## Recommendation

For the demo, run the API, worker, Postgres, Judge and signer on the one Linux host (the sandbox host), with the web on Vercel pointing at the API. Split later. This avoids building a remote Judge before anything has proven the real path. It does put the signing key on the same host as untrusted code, so see `docs/lanes/lane2/key-custody.md` for the conditions.

## Decision needed

Approve single-host for the demo, or say which of the unknowns above to settle first.
