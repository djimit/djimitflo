# G191 — self-modification and SBOM route semantics

Date: 2026-09-10

Focused command:
`npm --workspace @djimitflo/server test -- --run src/__tests__/critical-http-contracts.test.ts src/__tests__/self-modification.test.ts`

Result: **17 passed / 0 failed**.

Verified behavior:

- `self-modification/status` returns persisted counters.
- `self-modification/analyze` discovers opportunities when launched from the npm workspace context.
- `self-modification/plan` creates a durable plan and rejects missing/unknown opportunity IDs with typed 400/404 responses.
- `self-modification/execute` remains fail-closed with explicit `451 SELF_MODIFICATION_DISABLED`.
- `sbom/generate` returns a CycloneDX 1.6 document and download disposition.
- `sbom/summary` returns a derived dependency summary.

Root cause repaired: `SelfModificationPipeline` now walks upward from `process.cwd()` to the monorepo containing `packages/server/src`, avoiding the previous silent no-op when started from `packages/server`.
