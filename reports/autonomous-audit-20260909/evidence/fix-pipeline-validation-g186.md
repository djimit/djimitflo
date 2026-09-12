# G186 targeted fix pipeline validation

Date: 2026-09-10

The repaired `/swarms/fix` contract was revalidated after exposing an explicit runtime choice. A request creates a bounded target finding for a relative file, prepares maker/checker leases, executes the requested runtime (`mock` by default; real adapters such as `codex` are accepted when available), runs deterministic checks, executes an independent checker, and runs normal verification gates. The result is `success: true` only for a technically verified run and reports `ready_for_human_merge` plus `requiresHumanApproval: true`; no merge, push or deploy is performed.

Evidence:

- `integration-core-flow.test.ts`: targeted pipeline and repository traversal rejection pass; the disposable run reaches `ready_for_human_merge` with all gates passing.
- `critical-http-contracts.test.ts`: empty single requests, malformed batches and invalid runtimes return 400; intentional empty batch remains 200.
- `/loops` self-check: 23 files, 291 passed, 1 skipped.
- route inventory: 614 registrations, 608/608 anonymous auth denials; 581 source routes and 286 contract-tested routes.
- authenticated malformed-input replay: all 285 mutating routes exercised; no unexpected 5xx responses. Explicit 503 unavailable/degraded boundaries remain classified.
- build, type-check and lint pass; full workspace tests pass and mutation testing remains 100% (71/71 killed, 0 survivors).

Remaining boundary: default proof uses the deterministic `mock` runtime. Real provider execution, human approval/merge and production deployment remain governed separate steps.
