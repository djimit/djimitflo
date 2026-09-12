# G185 targeted fix pipeline validation

Date: 2026-09-10

The previously incomplete `/swarms/fix` path was repaired and tested against a disposable Git repository. A request now creates a bounded target finding for the requested relative file, prepares maker/checker leases, executes the requested runtime (`mock` by default; real adapters such as `codex` are accepted when available), runs deterministic checks, executes an independent checker, and runs the normal verification gates. The result is `success: true` only for a technically verified run and reports `ready_for_human_merge` plus `requiresHumanApproval: true`; no merge, push or deploy is performed.

Evidence:

- `integration-core-flow.test.ts`: targeted pipeline and repository traversal rejection pass (2/2 focused; full file 8/8).
- `critical-http-contracts.test.ts`: empty single fix requests and malformed batch requests return 400; intentional empty batch remains 200 (15/15 combined contract tests).
- `/loops` self-check: 23 files, 291 passed, 1 skipped.
- route inventory: 614 registrations, 608/608 anonymous auth denials; 581 source routes and 286 contract-tested routes.
- authenticated malformed-input replay: all 285 mutating routes exercised; 0 unexpected 5xx responses. Six 503 responses are explicit unavailable/degraded boundaries (plugin/skill activation, skill reload, Telegram webhook). 66 successful responses are parameterless/default or asynchronous contracts; empty `/swarms/fix/batch` is intentionally one of them.
- build, type-check, lint, full workspace tests and mutation testing pass; mutation score remains 100% (71/71 killed, 0 survivors).

Remaining boundary: the default fix service runtime is the deterministic `mock` proof runtime. Real provider execution, human approval/merge and production deployment remain governed separate steps.
