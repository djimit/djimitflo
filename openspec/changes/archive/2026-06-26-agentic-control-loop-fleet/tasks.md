# Tasks

## Phase 0: Baseline And Vocabulary

- [x] T00.1 Document that Ruflo is inspiration only; Djimitflo runtime target is Codex/OpenCode.
- [x] T00.2 Capture live Codex/OpenCode executor contracts and current auth requirements.
- [x] T00.3 Define `Agentic Control Loop Framework` glossary: goal, loop, step, worker, lease, gate, verdict, memory update.
- [x] T00.4 Create evidence folder `agent-evidence/agentic-control-loop-fleet/`.

Validation:

- [x] `openspec validate agentic-control-loop-fleet --strict`
- [x] Docs no longer imply Ruflo runtime dependency.
- [x] Codex/OpenCode capabilities are proven from local binaries or marked unavailable.

## Phase 1: Loop Contract And Goal Lifecycle

- [x] T01.1 Add loop schema and validator.
- [x] T01.2 Add goal schema: objective, constraints, acceptance criteria, risk class, budget, owner, status.
- [x] T01.3 Add `/api/goals` create/list/get/update endpoints.
- [x] T01.4 Add `/api/goals/:id/decompose` to produce loop candidates and task slices.
- [x] T01.5 Add dashboard goal view with progress, evidence, blockers and next action.

Validation:

- [x] Goal without measurable acceptance criteria is rejected.
- [x] Loop without stop conditions is rejected.
- [x] A goal can be decomposed without starting any worker.
- [x] Dashboard can show goals, loop runs, gates, leases, blockers and review events.
- [x] Dashboard can create goals, start loops, step, continue, verify, split, retry, submit verdicts, complete and stop.

## Phase 2: /loop Runtime

- [x] T02.1 Add loop run state machine: `created`, `planning`, `running`, `verifying`, `blocked`, `completed`, `failed`, `escalated`.
- [x] T02.2 Add generic loop lifecycle aliases: `/start`, `/step`, `/verify`, `/continue`, `/stop`.
- [x] T02.3 Persist loop state to Markdown/OKF and database events.
- [x] T02.4a Add retry decision for failed or rejected maker output.
- [x] T02.4b Add split decision for work that outgrows a bounded finding.
- [x] T02.4c Add escalation decision for repeated failure above threshold.

Validation:

- [x] Loop can resume from persisted state after server restart.
- [x] Generic `/loop` aliases can start, step and stop a loop run.
- [x] Persistent failure count above threshold escalates to human.
- [x] `/loop continue` cannot bypass failed gates.
- [x] `/loop retry` can supersede failed/rejected maker output without letting old output block completion.
- [x] `/loop split` creates child findings without leasing workers automatically.

## Phase 3: Fleet Orchestration

- [x] T03.1 Add worker lease model for Codex/OpenCode workers.
- [x] T03.2 Add fleet planner for maker/checker/security/memory/governance roles.
- [x] T03.3 Add worktree allocator with branch prefix `agent/loop/`.
- [x] T03.4a Add maker concurrency budget.
- [x] T03.4b Add retry budget.
- [x] T03.4c Add token budget from real runtime usage.
- [x] T03.4d Add wall-clock loop budget.
- [x] T03.5 Add backpressure when quality gates fail.

Validation:

- [x] Multiple maker workers can run in separate worktrees without file conflicts.
- [x] Checker worker is never the same lease as maker worker for the same output.
- [x] Budget exhaustion stops new worker leases.
- [x] Retry budget exhaustion stops retry worker leases.
- [x] Token budget exhaustion uses real runtime usage and stops new worker leases.
- [x] Wall-clock budget exhaustion stops new worker leases and records a budget event.
- [x] High-risk scopes require security checker verdict before completion.

## Phase 4: Loop Orchestration Skills

- [x] T04.1 Add `goal-intake-loop-skill`.
- [x] T04.2 Add `discovery-loop-skill`.
- [x] T04.3 Add `planning-loop-skill`.
- [x] T04.4 Add `execution-loop-skill`.
- [x] T04.5 Add `verification-loop-skill`.
- [x] T04.6 Add `memory-loop-skill`.
- [x] T04.7 Add `governance-loop-skill`.
- [x] T04.8 Validate skills before any active loop uses them.

Validation:

- [x] Draft skills cannot orchestrate live workers.
- [x] Validated skills include allowed actions, forbidden actions, gates and escalation.
- [x] Skill changes are treated as governance-affecting when they expand autonomy.

## Phase 5: First Closed Loop

- [x] T05.1 Implement `doc-drift-and-small-fix-loop`.
- [x] T05.2 Discovery reads docs, instructions, tests and lint output.
- [x] T05.3 Planner emits small bounded tasks.
- [x] T05.4 Maker patches in isolated worktree.
- [x] T05.5 Checker verifies diff, docs consistency and tests.
- [x] T05.6 Memory curator writes LOOP_STATE, decisions and risks.
- [x] T05.7 Expose a read-only review bundle for external audit.

Validation:

- [x] No automatic merge.
- [x] Diff threshold enforced.
- [x] Tests/lint/typecheck gates run when relevant.
- [x] Human approval required before PR merge or deployment.
- [x] Split parent findings cannot be assigned directly after child findings are created.

## Phase 6: Expand Loop Catalog

- [x] T06.1 Repo maintenance loop.
- [x] T06.2 Skill quality loop.
- [x] T06.3 MCP connector validation loop.
- [x] T06.4 Security regression loop.
- [x] T06.5 OKF synchronization loop.
- [x] T06.6 Overwatch policy drift loop.

Validation:

- [x] Each loop declares mode, risk class, trigger, state, gates and stop conditions.
- [x] Open loops have explicit time/token/context budgets.
- [x] Policy-modifying loops can propose but not apply changes without human approval.

## Phase 7: Workstation Swarm Resource Utilization

- [x] T07.1 Add canonical `work_items` backlog in Djimitflo DB.
- [x] T07.2 Add work-item create/list/get/update and convert-to-goal API.
- [x] T07.3 Add swarm reality status API for registry agents, live agents, worker leases, active executions, open work and resource snapshot.
- [x] T07.4 Add auto-propose scheduler tick that projects completed loop findings to backlog candidates without leasing workers.
- [x] T07.5 Add dashboard view for workstation swarm resources and backlog.

Validation:

- [x] Registry agent count is not treated as live worker count.
- [x] Active execution count requires runtime evidence on running worker leases.
- [x] Scheduler creates idempotent backlog candidates from loop findings.
- [x] Scheduler tick creates no leases in auto-propose mode.
- [x] Dashboard build includes the swarm resources route.

## Phase 8: Agent Handoff And Memory Harness

- [x] T08.1 Add machine-readable assignment packet per maker lease.
- [x] T08.2 Include assignment packet path in worker lease metadata and review bundle.
- [x] T08.3 Add memory candidate governance for operational memory, engineering rules and policy rules.
- [x] T08.4 Reject secret-like memory candidates before durable memory writes.
- [x] T08.5 Show memory candidates in the swarm resources dashboard.
- [x] T08.6 Add explicit promotion flow from reviewed memory candidate to OKF, with UAMS/Qdrant sinks guarded from automatic writes.
- [x] T08.7 Add retrieval harness that proves a promoted memory can be found through `/api/memory/search`.

Validation:

- [x] Maker leases write `ASSIGNMENT_PACKET.json`.
- [x] Assignment packets include allowed actions, forbidden actions, expected artifacts and stop conditions.
- [x] Operational memory can be proposed without auto-promotion.
- [x] Policy memory requires human approval before promotion.
- [x] Secret-like memory candidates are rejected.
- [x] Promoted OKF memory is searchable through `/api/memory/search` fallback.
- [x] Scheduler can convert triaged backlog candidates into goals without creating worker leases.

## Phase 9: Specialist Swarm Panel Harness

- [x] T09.1 Add a bounded specialist catalog with systems, security, runtime, memory, skill, logic, behavioral, philosophy, biology and physics profiles.
- [x] T09.2 Add persistent specialist panel and specialist review tables.
- [x] T09.3 Enforce high-risk panels with `security_reviewer`.
- [x] T09.4 Add independent review submission with support, oppose, uncertain and needs_evidence stances.
- [x] T09.5 Compute consensus level, decision, confidence and preserved dissent.
- [x] T09.6 Project consensus-ready panels to canonical backlog without worker leases.
- [x] T09.7 Show specialist panels in the swarm resources dashboard with review and backlog actions.

Validation:

- [x] Unknown specialist ids are rejected.
- [x] High-risk panels without `security_reviewer` are rejected.
- [x] Dissent is retained in consensus output.
- [x] Backlog projection is idempotent by panel source reference.
- [x] Specialist panels do not create worker leases in auto-propose mode.

## Phase 10: Agent Assurance Harness

- [x] T10.1 Add causal trace span storage for goals, loops, workers, tools, memory, evals, capabilities, checkpoints and reflections.
- [x] T10.2 Add checkpoint snapshots for loop state, gates, findings and historical worker leases.
- [x] T10.3 Add replay branch creation from checkpoints without copying worker leases.
- [x] T10.4 Add deterministic assurance eval scorecards for memory/skill/swarm/loop/capability targets.
- [x] T10.5 Add least-privilege capability token references with high-risk approval enforcement and no stored bearer secret.
- [x] T10.6 Add governed reflection candidates that require review for policy/security/autonomy lessons.
- [x] T10.7 Show assurance counts and latest evals in the swarm resources dashboard.

Validation:

- [x] Trace spans form a DAG and reject secret-like evidence.
- [x] Checkpoint replay branches start as new loop runs and copy zero worker leases.
- [x] Memory assurance evals store deterministic scorecards with zero external writes.
- [x] Wildcard capability scopes are rejected.
- [x] High-risk capability scopes require explicit approval.
- [x] Capability responses expose token references, not bearer secrets.
- [x] Security-sensitive reflection lessons become review-required candidates.

## Phase 11: Real Worker Spawn Bridge

- [x] T11.1 Add `/api/loops/runs/:id/execute-worker` as the generic worker execution bridge.
- [x] T11.2 Add runtime adapter dispatch for Codex, OpenCode and deterministic mock workers.
- [x] T11.3 Preserve maker lease lifecycle `prepared -> running -> completed|failed`.
- [x] T11.4 Capture stdout, stderr, exit status, timeout state, diff size and runtime token usage.
- [x] T11.5 Write causal worker trace spans for spawn and completion/failure.
- [x] T11.6 Write loop checkpoints before and after worker execution.
- [x] T11.7 Enforce timeout, diff threshold, no-merge and token budget gates.
- [x] T11.8 Add dashboard action to run prepared non-manual maker leases.

Validation:

- [x] Mock runtime execution completes a prepared worker lease and stores artifacts.
- [x] Worker execution writes before/after checkpoints with lease status evidence.
- [x] Worker execution writes trace spans with running and ok/error status.
- [x] Runtime usage is parsed from stdout and stored on the worker lease.
- [x] Timed-out Codex execution marks the lease failed and blocks the loop.
- [x] Dashboard build includes the worker run action.
