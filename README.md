# Affidavit

Affidavit is an independent auditor that proves findings and proves fixes against the running app. It finds candidate vulnerabilities with deterministic tools, proves them with exploits that run against the live app, proves the fixes, and hands back a replayable verdict.

## Develop

Requires Node 22 (see `.nvmrc`) and pnpm.

```bash
pnpm install
```

Scripts fan out to every package with `pnpm -r`:

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format` and `pnpm format:check`
- `pnpm test`

## Plan

The canonical build plan is [docs/plan.md](docs/plan.md). Read it before starting work.

## Status

Phase 0 (lead setup) is in place: contracts v1.0, ports, fakes, and fixtures. Every other package is still an empty stub. See [docs/implementation-plan.md](docs/implementation-plan.md) for the lane tasks and [docs/decisions.md](docs/decisions.md) for open decisions.
