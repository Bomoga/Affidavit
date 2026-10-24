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

This repo is scaffolding only. Every package is an empty stub; core logic comes later.
