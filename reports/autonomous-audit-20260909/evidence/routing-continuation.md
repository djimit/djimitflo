# Routing continuation: observed truth and bounded correction

Status: **PARTIAL capability-aware orchestration; verified local recommendation/explicit-runtime boundary.** No provider was started by this tranche. No benchmark opt-in was executed against the repaired source.

## Reconstructed chain

`POST /loops/runs/:id/continue` → `LoopLifecycleService.continueLoopRun` → explicit runtime or `manual` → runtime admission and worker budget → `LoopService.planLoopRun` advisory findings → isolated worktree/assignment → durable maker lease and `worker_leases_prepared` event → explicit `execute-worker` → existing maker execution path.

The existing review-bundle API returns the persisted lease metadata and event; no separate routing registry, scheduler, model selector or execution authority was introduced.

## Executed defects

The historical [red run](routing-continuation-red.log) contains nine failing assertions against the pre-correction source. In particular:

- With a real `MetaOrchestrationService` and no history, `getRoutingOptimization()` returns `workstation-litellm/coding`; `continueLoopRun()` previously translated this unmatched model string to **mock**. Thus an omitted runtime changed from manual to simulated execution preparation merely because meta-orchestration was enabled.
- `planLoopRun()` had no production caller. Its output was not associated with the actual prepared lease.
- Its capability finder fell back to the first unrelated capability and did not honor live-routing eligibility, forbidden spawn action or the run's recorded risk ceiling.
- Capability-wide token counts selected OpenCode and capability-wide success metadata selected Codex without attributing those observations to either runtime. Mock history could also win the runtime comparison.

## Correction

- An explicit requested runtime remains authoritative. No runtime request means `manual`; a model name is never parsed into an executor and never converted implicitly to mock.
- The existing planner now filters the existing capability registry's computed `live_route_allowed`, spawn action and recorded risk ceiling, and requires an actual finding-type/ID match. Missing, unrelated or inadmissible capability evidence yields no capability recommendation.
- Runtime advice uses the existing per-runtime completion observations, excluding mock/manual and unsupported runtime identifiers. Missing usable observations yields manual selection. Coarse capability-wide price/quality metadata no longer selects a provider.
- Continue invokes that planner and stores each selected finding's `routing_recommendation` in its maker lease, alongside separate `requested_runtime` and `effective_runtime`; the preparation event carries the same recommendation list.
- A recommendation is deliberately **not** written to `worker_leases.capability_id`: doing so would falsely record actual governed capability use and contaminate completion/competence statistics. There is no newly added auto-routing opt-in.
- Continue/retry/split call the shared `assertOperatorNotPaused` before mutations. The exact pause flags on the run or owning goal block work; an unrelated blocked goal without an operator-pause flag is not silently reclassified as paused.

## Evidence

- [Targeted green run](routing-continuation-green.log): 28 tests across four files, including 15 new actual-service regressions. Fixtures use temporary Git repositories, migrated SQLite and existing services. The explicit mock test launches the repository's real local Node mock child and verifies its stored runtime and stdout artifact while retaining the different advisory runtime. This is execution-boundary proof, **not provider or engineering-quality proof**.
- [Existing loop regression](routing-loop-regression.log): **44/44 passed** across existing loop-service, security-checker and child-stop suites after the change.
- `npx eslint` passed for the changed planning/lifecycle sources and tests. The first server typecheck was blocked by concurrent edits elsewhere; the subsequent server typecheck passed after integration. Full-repository verification remains the parent integration responsibility.
- Three obsolete G11 expectations were corrected explicitly: unmatched/unattributed evidence must not default to Codex/OpenCode. Their replacement assertions require manual selection; the new regressions independently prove matching, admitted, runtime-attributed advice and explicit dispatch precedence.

## Remaining boundaries

Automatic capability-driven runtime/model dispatch is **not implemented or claimed**. There is no existing explicit auto-selection contract to activate safely; this tranche exposes advisory evidence through an existing response surface while preserving manual/explicit selection. Actual capability injection, revocation-at-dispatch and capability-specific outcome attribution are separate requirements before that recommendation may become execution authority.

Per-runtime completion rate is historical status evidence, not independent quality verification or causal economic evidence. Existing measurement refresh may update aggregate capability cost-model metadata. There is no model-level optimizer, new Astra/prestige heuristic or asserted price advantage.

Sovereign/Pi advice remains advisory. It does not prove local model availability, offline configuration or zero egress, and cannot override an explicit manual runtime choice. Runtime availability is enforced at the actual explicit preparation/execution boundary; advice alone is not a live runtime probe.

## Independent operator-pause continuation review

The quiescent-pause implementation was checked beyond its primary UI route. Two alternative admission chains had concrete bypasses:

- [Nested-root probe](operator-nested-pause-probe.json): an actually paused goal/run still acquired a prepared root lease. `createRoot` and shared `prepareNestedLease` now reject before worktree/lease/tree effects; a nested child request uses the existing audited `gated_out` denial with reason `operator_paused`, without consuming budget. [Red](nested-operator-pause-red.log) had two failing regressions; [green](nested-operator-pause-green.log) has **50/50** across routing, nested-spawn and operator-chain tests. A denied request's existing `budget_granted` is NULL (no grant), not a fabricated zero-valued grant.
- [Generic executor probe](operator-task-pause-probe.json): a previously completed loop task started again through the common task executor while its owning goal was paused. Admission now checks current run/goal pause flags before queueing, after acquiring capacity and before each fallback attempt. Canonical worker pointers are resolved by task ID even if historical editable task metadata was erased. Task PATCH restores server-created loop/lease bindings from that same worker pointer while retaining ordinary editable metadata. No `LoopService` instance or new pause subsystem was added to the execution engine.

[Initial executor red](execution-operator-pause-red.log) has seven failing assertions and one unrelated-task positive control. [Historical erased-binding red](execution-operator-pause-canonical-red.log) independently demonstrates the canonical lookup requirement. The focused tests exercise actual migrated SQLite, actual `OperatorInterventionService`, `ExecutionEngine`, Express task PATCH and the shared concurrency semaphore, using a local in-process executor fixture. They do **not** prove provider execution or process draining. Normal operator pause rejects nonterminal/busy tasks; the capacity-race test deliberately simulates an independently persisted pause flag while dispatch is waiting, rather than claiming that the ordinary pause route permits pausing busy work.

[Executor green](execution-operator-pause-green.log): **61/61 passed**, comprising nine new pause/binding regressions plus the existing execution-engine and task-recovery suites. Server typecheck, scoped ESLint and `git diff --check` also passed after the canonical lookup correction.

An ordinary goal marked `blocked` without `operator_paused: true` remains executable where previously allowed. The intervention still offers quiescent pause only, not durable CLI checkpointing, automatic continuation, or authority to override verifier gates or approve merges.
