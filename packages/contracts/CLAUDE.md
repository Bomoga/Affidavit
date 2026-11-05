Read docs/plan.md, then docs/implementation-plan.md sections 3 and 4 before working in this package.

# @affidavit/contracts

**Owner:** Lead (Adrian). Shared by all three lanes; every change follows docs/implementation-plan.md section 3.4.

**Mission:** Zod schemas and types for every boundary object. Changes need the lead to approve.

## Commands

Run from this directory, or add `--filter @affidavit/contracts` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Notes

- Zod 4. JSON Schema comes from `z.toJSONSchema`: `pnpm --filter @affidavit/contracts export:schema`.
- Add a sample to `src/samples.ts` for every new schema; the tests require one.
- A contract change updates every affected fixture and fake in the same PR (`pnpm --filter @affidavit/testing generate:fixtures`).
- Record every change in CHANGELOG.md.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
