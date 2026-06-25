# Tasks

## Phase 12.1 Runtime Contract Harness

- [x] T12.1.1 Add runtime contract service for Codex/OpenCode.
- [x] T12.1.2 Probe `codex exec --help` and assert `--json` plus `--cd`.
- [x] T12.1.3 Probe `opencode run --help` and assert `--format json` plus `--dir`.
- [x] T12.1.4 Store runtime contract probe results in SQLite and expose via API.
- [x] T12.1.5 Block real worker execution when the runtime contract is `drifted` or `unavailable`.
- [x] T12.1.6 Add tests that fail if Codex adapter regresses to `--format json --dir`.

Validation:

- [x] Unit test proves Codex uses `exec --json --cd`.
- [x] Unit test proves OpenCode uses `run --format json --dir`.
- [x] Live probe returns current local Codex/OpenCode versions and adapter status.
- [x] Drifted fake runtime blocks `/execute-worker` before spawn.

## Phase 12.2 Token Budget Reduction

- [x] T12.2.1 Add a low-context `djimitflo-worker` runtime profile contract.
- [x] T12.2.2 Add per-loop default token ceilings for low-risk doc/small-fix runs.
- [x] T12.2.3 Add `tokens_per_diff_line` and `tokens_per_successful_worker` metrics.
- [x] T12.2.4 Add budget escalation when small low-risk work exceeds configured token-per-diff thresholds.
- [x] T12.2.5 Add dashboard visibility for worker token efficiency.

Validation:

- [x] Runtime usage remains parsed from JSONL and stored on worker lease.
- [x] Over-budget worker blocks additional leases.
- [x] Dashboard renders token efficiency without requiring stdout inspection.

## Phase 12.3 Checker Worker Bridge

- [x] T12.3.1 Add `/api/loops/runs/:id/execute-checker`.
- [x] T12.3.2 Add checker runtime adapter dispatch with read-only prompt and no file mutation allowance.
- [x] T12.3.3 Feed checker the maker diff, assignment packet, stdout/stderr paths and deterministic check output.
- [x] T12.3.4 Normalize checker output into existing checker verdict shape.
- [x] T12.3.5 Preserve checker stdout/stderr artifacts, runtime usage, traces and before/after checkpoints.
- [x] T12.3.6 Add dashboard action to run prepared checker leases.

Validation:

- [x] Checker cannot run before linked maker lease is completed.
- [x] Checker verdict pass moves run toward verification.
- [x] Checker verdict reject marks maker output revision-required or blocked.
- [x] Checker execution writes trace spans and checkpoints.

## Phase 12.4 Control Artifact Isolation

- [x] T12.4.1 Move `LOOP_WORK.md` and `ASSIGNMENT_PACKET.json` into `.djimitflo/`.
- [x] T12.4.2 Add worktree-local exclude/ignore for `.djimitflo/`.
- [x] T12.4.3 Update worker prompts, review bundles and tests to use the new control paths.
- [x] T12.4.4 Ensure diff gates count patch files only, not control files.

Validation:

- [x] Prepared maker worktree shows no untracked control files in `git status --short`.
- [x] Review bundle still links assignment packet and work instructions.
- [x] Existing historical packets remain readable.

## Phase 12.5 Runtime Warning Gate

- [x] T12.5.1 Add runtime warning parser for Codex/OpenCode stdout/stderr.
- [x] T12.5.2 Store `runtime_warnings` on worker lease metadata.
- [x] T12.5.3 Add advisory warning gates for low-risk loops.
- [x] T12.5.4 Add blocking warning gates for high-risk loops when warning class affects trust boundary.
- [x] T12.5.5 Show warning count and latest warning classes in dashboard.

Validation:

- [x] Plugin hook parse warning is captured as structured warning.
- [x] Skill context budget warning is captured as structured warning.
- [x] Low-risk warning remains advisory.
- [x] High-risk trust-boundary warning blocks completion.

## Phase 12.6 Auto-Verify Closure

- [x] T12.6.1 Add `ready_for_human_merge` loop status.
- [x] T12.6.2 Add auto-verify transition after maker completion.
- [x] T12.6.3 Run deterministic checks before checker execution where package scripts exist.
- [x] T12.6.4 Require checker pass before ready-for-human-merge.
- [x] T12.6.5 Require security checker pass for high-risk scopes.
- [x] T12.6.6 Prevent `completed` for mutating work until human approval is recorded.

Validation:

- [x] Maker success alone cannot complete a mutating loop.
- [x] Deterministic check failure blocks checker pass.
- [x] Checker pass plus deterministic gates moves run to `ready_for_human_merge`.
- [x] High-risk runs remain blocked without security checker verdict.

## Phase 12.7 Dashboard And Operator Flow

- [x] T12.7.1 Add runtime contract cards to Goals/Loops dashboard.
- [x] T12.7.2 Add worker warning, token efficiency and checker execution controls.
- [x] T12.7.3 Add batch goal import preview for `goals.batch.json`.
- [x] T12.7.4 Add status copy that distinguishes prepared, running, verifying and ready-for-human-merge.

Validation:

- [x] Dashboard build passes.
- [x] Operator can see why a worker cannot start before reading raw logs.
- [x] Operator can run maker and checker from dashboard without bypassing gates.

## Phase 12.8 End-To-End Real Smoke

- [x] T12.8.1 Run a temp DB/temp repo live Codex maker smoke.
- [x] T12.8.2 Run a temp DB/temp repo live checker smoke.
- [x] T12.8.3 Verify stdout/stderr artifacts under `.data/agent-evidence`.
- [x] T12.8.4 Verify token budget gate uses real runtime usage.
- [x] T12.8.5 Verify trace spans and checkpoints for maker and checker.
- [x] T12.8.6 Stop temp server and prove no listener is left behind.

Validation:

- [x] `openspec validate real-worker-fleet-functionality-scale --strict`
- [x] `npm test --workspace=@djimitflo/server -- src/__tests__/loop-service.test.ts`
- [x] `npm run type-check --workspace=@djimitflo/server`
- [x] `npm run build --workspace=@djimitflo/dashboard`
- [x] Live smoke evidence includes run id, lease ids, gates, trace spans, checkpoints, artifact paths and real token usage.

## Phase 12.9 Worker Pool And Queue Model

- [x] T12.9.1 Add fleet pool status model by runtime: Codex, OpenCode, mock and manual.
- [x] T12.9.2 Count prepared, queued, running, completed and failed leases separately.
- [x] T12.9.3 Add queue depth and blocked capacity reasons per runtime and risk class.
- [x] T12.9.4 Add scheduler selection for next executable lease without exceeding concurrency budgets.
- [x] T12.9.5 Expose pool status through API.

Validation:

- [x] Prepared leases do not count as active execution.
- [x] Running leases require runtime evidence.
- [x] Pool status explains why no more workers can start.
- [x] Multiple independent prepared leases can be visible without spawning workers.

## Phase 12.10 Fleet Scale Dashboard Cockpit

- [x] T12.10.1 Add topology view: goal -> loop -> lease -> runtime -> artifact -> gate.
- [x] T12.10.2 Add worker pool cards with queue depth, running count, recommended concurrency and blocked reasons.
- [x] T12.10.3 Add throughput metrics: completed workers, failed workers, average runtime, token burn and tokens per useful diff.
- [x] T12.10.4 Add bottleneck panel for missing runtime, budget exhaustion, blocked gates, missing checker and missing human approval.
- [x] T12.10.5 Add next-safe-action controls that call guarded API routes.

Validation:

- [x] Dashboard build passes.
- [x] Dashboard shows scale truth from API data, not static assumptions.
- [x] Operator can identify the next bottleneck without reading raw stdout.

## Phase 12.11 Workstation Resource-Aware Scaling

- [x] T12.11.1 Add recommended concurrency calculation from CPU threads, load average, free memory, runtime availability and configured budgets.
- [x] T12.11.2 Add hard stop reasons when resources are below threshold.
- [x] T12.11.3 Add API response fields for recommended concurrency and resource gate explanations.
- [x] T12.11.4 Add dashboard capacity panel for workstation execution node.

Validation:

- [x] Low capacity simulation blocks new running workers.
- [x] Capacity response explains the blocked reason.
- [x] MacBook dashboard can observe workstation capacity without pretending to execute locally.

## Phase 12.12 Backlog To Fleet Execution Flow

- [x] T12.12.1 Batch convert selected triaged backlog items into goals.
- [x] T12.12.2 Decompose goals into loop runs without spawning workers.
- [x] T12.12.3 Prepare maker/checker leases for selected bounded work items.
- [x] T12.12.4 Start workers only through capacity scheduler and policy gates.
- [x] T12.12.5 Update backlog status from lease and loop outcomes while preserving failed/rejected artifacts.

Validation:

- [x] Batch planning can create goals and loop candidates for multiple backlog items.
- [x] Multiple low-risk items can be prepared in separate worktrees.
- [x] Concurrency-limited execution starts only allowed workers.
- [x] Backlog progress remains auditable from source finding to final gate.

## Phase 12.13 GitHub Co-Creation Loop

- [x] T12.13.1 Add idempotent GitHub issue import into canonical `work_items`.
- [x] T12.13.2 Schedule imported issues through the existing triage -> goal -> loop -> lease flow.
- [x] T12.13.3 Make planned work items runnable as direct maker/checker assignments even when repo scanners find no separate finding.
- [x] T12.13.4 Add worker-pool drain command for real runtime execution through existing resource-aware scheduler gates.
- [x] T12.13.5 Add PR bundle generation from loop run, gates and worker lease evidence.

Validation:

- [x] CLI self-test passes for issue parsing, work item conversion and PR body generation.
- [x] GitHub issue work item prepares maker/checker leases with the issue as direct assignment.
- [x] Existing swarm scheduler and worker-pool regression tests pass.
- [x] `npm run type-check`
- [x] `openspec validate real-worker-fleet-functionality-scale --strict`
