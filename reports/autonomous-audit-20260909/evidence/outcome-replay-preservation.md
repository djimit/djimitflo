# Outcome projection replay: independent correction

Scope: isolated audit worktree; real disposable SQLite and loopback HTTP event-bus fixtures. No provider execution, production writes, promotion, or causal-improvement claim.

## Reproduced before correction

`outcome-replay-preservation-red.log` records three failing assertions and six passing controls:

- Replaying an unchanged three-event batch erased operator title, description, objective, approval annotation and `converted_to_goal_at`, despite preserving the leased status and parent goal ID.
- A new critical-risk observation increased the assessment sample count but left an existing high-risk work item at high risk.
- A contradictory fourth observation changed the assessment from a reported SUPPORTED signal to UNDETERMINED, while the linked work item still reported SUPPORTED with three replications.

These are projection/ownership errors, not evidence of improved agent intelligence.

## Correction and measured result

`OutcomeLearningService.process()` now preserves existing scope, lifecycle and operator fields. On an existing candidate it replaces only its derived `metadata.outcome_learning` namespace, updates reported confidence and takes the maximum of existing and observed risk. New-candidate defaults remain unchanged. Inconclusive assessments refresh an existing candidate but cannot create one on their own.

The same immutable regression inputs now preserve all tested operator fields, escalate high to critical, and keep assessment/candidate aligned at four observations with an UNDETERMINED signal. No replay creates an additional work item or goal. This is the measured before/after product correction; there is no measured provider-outcome improvement.

## Execution evidence

- `outcome-replay-preservation-green.log`: 15/15 tests across outcome HTTP/SQLite chain and event ingestion.
- `outcome-replay-preservation-scoped.log`: 37/37 tests across those two files plus work-item conversion and swarm-intelligence routes.
- `outcome-replay-preservation-typecheck.log`: server type-check exit 0.
- `outcome-replay-preservation-lint.log`: edited service/test lint exit 0.
- Added real `start()`/`stop()` recurrent polling test: at least two actual HTTP poll cycles, stop and settle, file-backed database close/reopen, new service and at least two more cycles. Final durable totals remain three observations, one assessment, one candidate and zero goals, with stable candidate identity.
- Existing injected SQLite failure test proves event insertion, assessment and cursor rollback together; retry consumes the same batch.

Authority remains explicitly advisory: sender-supplied causal labels, reported confidence and repeated observations are not independent causal evidence. The linked historical goal is not rewritten when the assessment changes, and this correction does not implement automatic strategy execution, containment or promotion.
