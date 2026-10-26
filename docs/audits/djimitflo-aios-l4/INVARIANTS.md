# Invariants A–G

**Scope and labels.**
- Source: `a4a083ac`. Paths are under `packages/server/src/`.
- "Test" names an existing test file. None were run for this pack.
- **Enforced** = the code refuses. **Advisory** = it records or warns and lets the action pass.
- The repository's own invariant spec is [`openspec/specs/core-invariants/spec.md`](../../../openspec/specs/core-invariants/spec.md) (FR-001…FR-008). It covers verification, merge, promotion and jev. This page adds the OS-level invariants that spec does not state.

## Summary

| Inv. | Enforced today | Main gap | Package |
|---|---|---|---|
| A. Identity and authority | Route permissions, admission, fleet signatures | Machine approvals count as human; no policy versions; all users admin | B15 |
| B. Ownership | Durable leases, remote-job lease binding | No fencing outside the one process; gym runs have no lease | B2, B11 |
| C. Resource conservation | Concurrency permits, the token brake | Scheduler is advisory (constants) | B4 |
| D. Effect control | Pre-dispatch policy and approval; gates on the diff | No mediation inside the CLI (S0) | B14 |
| E. Recovery | Boot settle, task `unknown` + hold | No resume, sweep or cancel channel; no effect states | B2, B7, B9, B12 |
| F. Result truth | ELIGIBLE_GATED, FR-002/FR-003, cost ledger | Economy endpoint; tokens recorded as 0 | B1, B2, B3 |
| G. Learning truth | Pre-registration, holdout validity, FR-001 | No inheritance; cards not adopted | B5, B8 |

## Detail per invariant

### A. Identity and authority

**Invariant.** Every acting principal is authenticated. Its authority comes from deterministic policy, never from a model verdict.

**Mechanism.**
- `middleware/auth.ts:55` `requirePermission`; `services/authorization-service.ts:73`.
- Runtime admission at `execution/execution-engine.ts:324,630`.
- `services/fleet-event-signatures.ts:33` (enforce since 21-10, plan).
- Workstream F repairs #963–#968.

**Enforced vs advisory.**
- Enforced: route permissions, admission, signed fleet outcomes.
- Advisory or conflicting:
  - The LLM checker satisfies the `checker_verdict` gate.
  - `autonomy:*` / `inherit:*` approvals count as the human approval. The grant query excludes only `system` and `auto` (`execution/execution-engine.ts:1623-1629`, behind LOOP_REVIEWER_APPROVAL_INHERIT).
  - `no_automatic_merge` reports pass.
  - These are listed in [AUTHORITY_GRAPH](../../research/authority/AUTHORITY_GRAPH.md), "Operator decisions needed".

**Tests.** `route-permission-contract.test.ts`, `route-permissions-http.test.ts`, `runtime-admission.test.ts`, `fleet-event-signatures.test.ts`.

**Gap.**
- All 4 users are admin, so any least-role escalation is latent.
- The event bus and agent registry are unauthenticated (S3, #948).
- No promotion, merge or deploy records its policy version.

### B. Ownership

**Invariant.** At most one live owner holds a unit of work at a time. A stale owner's result is refused.

**Mechanism.**
- `worker_leases`.
- `services/remote-maker-queue.ts:55-77` (`leaseActive`; a late result is marked `late_result`).
- The gym refuses a second report (`GYM_RUN_ALREADY_SETTLED`, `services/remote-gym-service.ts:253`).

**Enforced vs advisory.**
- Enforced for remote maker results.
- Process-local for everything else: `RuntimeLeaseRegistry` (`services/loop-recovery-service.ts:44`) and `services/loop-daemon.ts:173`.

**Tests.** `remote-maker.test.ts`, `lease-failure.test.ts`, `remote-gym.test.ts`.

**Gap.**
- There is no instance lock or fencing epoch. Single controller holds by deployment only (REVALIDATION #5).
- Gym runs have no lease. `record()` writes the outcome (`:288`) and settles (`:310`) without a transaction (gap matrix).

### C. Resource conservation

**Invariant.** Admitted work never exceeds the measured capacity or the budgets.

**Mechanism.**
- Permits: `services/concurrency-semaphore.ts:10-50` (RUNTIME_MAX_CONCURRENCY, default 4).
- Goal cap: `services/loop-daemon.ts:176`.
- Token brake: `OPENCODE_MAX_RUN_TOKENS` (`execution/executors/opencode-executor.ts:110-115`).
- Gym daily cap.
- Scheduler: `services/resource-scheduler.ts:152`.

**Enforced vs advisory.**
- Permits, caps and the brake are enforced.
- The capacity check is **advisory**: constants 8 CPU / 16 GB, and the #1014 observation is shadow-only.

**Tests.** `runtime-semaphore.test.ts`, `resource-scheduler-observed.test.ts`.

**Gap.**
- The scheduler cannot defer on real load.
- The shadow mixes a cgroup CPU count with the host-wide load (`:78/96`).
- Permits are released on `close`, which waits for the child pipes.

### D. Effect control

**Invariant.** No effect reaches the repo, the network, credentials or the DB unless policy decided it.

**Mechanism.**
- Risk → policy → governance gate → approval before dispatch (`execution/execution-engine.ts:332-393`).
- Diff gates and the scope gate (`services/policy-violations.ts:36`, shadow log).
- Codex `workspace-write` on the subscription path (`execution/executors/codex-executor.ts:211-216`).
- An opt-in `DockerSandboxExecutor` (`execution/execution-engine.ts:633-646`; prod use UNKNOWN).
- The ASG effect ledger (`services/asg/effects.ts`, harness only).

**Enforced vs advisory.** Enforced before dispatch and on the resulting diff. Nothing is enforced **during** a run.

**Tests.** `subscription-executor-permissions.test.ts`, `asg-executor.test.ts`. There is no test for in-run mediation, because none exists.

**Gap.**
- S0: the maker uid owns the DB (#948).
- ToolBroker is unused (`services/tool-broker.ts:4-6`).
- Network egress of CLI children is unscoped (admission G5).
- Every provider key reaches every runtime (`execution/executors/executor-env.ts:6-17`).

### E. Recovery

**Invariant.** After a crash, every effect is classified as done, not done or unknown, and nothing is blindly repeated.

**Mechanism.**
- `services/loop-recovery-service.ts:156` (boot; #880 settle `:123`).
- `execution/execution-engine.ts:203-239` (task `unknown` + hold).
- Gym runs are settled at the next claim (`services/remote-gym-service.ts:142-150`).

**Enforced vs advisory.** Boot classification is enforced. A hold needs an operator to reconcile it.

**Tests.** `loop-recovery-deploy-restart.test.ts`, `loop-recovery-awaiting-approval.test.ts`, `task-recovery.test.ts`. `g10-crash-recovery.test.ts` tests a resume that has no caller.

**Gap.**
- No resume of external processes.
- No time-based sweep for a host that never claims again.
- No cancel reaches a running remote worker.
- No per-effect states outside the ASG harness.
- A remote result after a VPS restart is dropped (CONFORMANCE).

### F. Result truth

**Invariant.** "Success" means independently verified. Unknown is never 0, never pass and never fail.

**Mechanism.**
- FR-002/FR-003: `services/loop-verification-service.ts:202`.
- The gym `verdict` (`scripts/gym-worker.mjs:99-104`) and ELIGIBLE_GATED (`services/genome-registry.ts:258`).
- `services/cost-ledger.ts:15-16`.
- `services/maker-token-accounting.ts`.
- Outcome attribution.

**Enforced vs advisory.** Enforced on the verification and gym paths. **Not** enforced on `/swarms/economy` or in gym outcome tokens. Engine skill outcomes were fixed by #1015 (merged at `a4a083ac`).

**Tests.** `loop-verification-completion.test.ts`, `cost-ledger.test.ts`, `maker-token-accounting.test.ts`, `outcome-attribution.test.ts`. The economy tests `g13-dollar-economy.test.ts` and `g18-economy-endpoint.test.ts` pin the current behaviour.

**Gap.**
- `services/loop-budget-service.ts:140`.
- `services/remote-gym-service.ts:289`.
- CAUSAL-EVOLUTION-003 #969 found a mutation check that does nothing and is recorded as pass (57/57).

### G. Learning truth

**Invariant.** A capability is promoted or inherited only on a pre-registered, valid, controlled comparison.

**Mechanism.**
- FR-001 and FR-006: `services/genome-promotion.ts:20,44`.
- The rule chooser `DREAM_PROMOTION_RULE` (`services/dream-evolution.ts:70`).
- Holdout freeze and the reuse block.
- Skill cards are record-only (`services/skill-distillation.ts:8-13`).
- Memory holdout (`services/assignment-context.ts:28-34`).
- The NE registry.

**Enforced vs advisory.**
- Promotion is enforced.
- Inheritance into prod: **no path exists**, so there is nothing to enforce.

**Tests.** `genome-registry.test.ts`, `holdout-reuse-block.test.ts`, `holdout-manifest-freeze.test.ts`, `skill-distillation.test.ts`.

**Gap.**
- 0 promotions from 415 attempts on epoch 0 (#969).
- No procedure reaches a fitting task (gap matrix).
- The epoch-1 readout is low-powered (0.17–0.31, prereg).
