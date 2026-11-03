# Tasks

## Phase A: Commit Gate

- [ ] T13.1 Review dirty worktree and identify scoped paths.
- [ ] T13.2 Run `git diff --check`.
- [ ] T13.3 Re-run targeted validation for server, dashboard and OpenSpec.
- [ ] T13.4 Selectively stage only scoped implementation and OpenSpec files.
- [ ] T13.5 Confirm `.env.example`, local env files, generated outputs and unrelated artifacts are not staged.
- [ ] T13.6 Commit with a scoped message.
- [ ] T13.7 Record post-commit `git status --short` and remaining unrelated dirty files.

Validation:

- [ ] `git diff --cached --stat` contains only intended files.
- [ ] Commit hash is recorded.
- [ ] No secrets or local env values are staged.

## Phase B: Workstation Live Smoke

- [ ] T13.8 Deploy/restart the committed server on the workstation execution node.
- [ ] T13.9 Verify server health and version.
- [ ] T13.10 Verify `/api/loops/runtime-contracts`.
- [ ] T13.11 Verify `/api/swarms/status` including `fleet_pools`.
- [ ] T13.12 Verify dashboard Fleet Cockpit from the MacBook cockpit.
- [ ] T13.13 Verify Goals/Loops prepared maker/checker controls.
- [ ] T13.14 Run scheduler tick in safe mode and optional prepare mode without starting workers.

Validation:

- [ ] Runtime contract output is captured for Codex/OpenCode.
- [ ] Swarm status distinguishes registry agents, prepared leases, running leases and active execution.
- [ ] Dashboard matches API data.
- [ ] No worker starts unless explicitly requested.

## Phase C: Real Codex/OpenCode Smoke

- [ ] T13.15 Create temp DB and temp git repo smoke harness.
- [ ] T13.16 Run real Codex contract probe.
- [ ] T13.17 Run bounded real Codex maker/checker smoke.
- [ ] T13.18 Run real OpenCode contract probe.
- [ ] T13.19 Run bounded real OpenCode maker/checker smoke when available.
- [ ] T13.20 Store smoke evidence: run id, lease ids, gates, stdout/stderr paths, trace ids, checkpoint ids and token usage.
- [ ] T13.21 Stop temp server and prove no smoke listener remains.

Validation:

- [ ] Real runtime smoke completes or blocks before spawn with actionable contract evidence.
- [ ] Loop reaches `ready_for_human_merge` only after deterministic checks and checker verdict pass.
- [ ] Token and wall-clock budgets are enforced.
- [ ] No merge, push or deploy happens.

## Phase D: Policy-Gated Worker Pool Runner

- [ ] T13.22 Add worker-pool planning service for eligible, blocked and running lease decisions.
- [ ] T13.23 Add policy checks for risk class, human approval, runtime availability, capacity, token budget and wall-clock budget.
- [ ] T13.24 Add `start-next`, `drain`, and `stop` API routes.
- [ ] T13.25 Add runner trace spans, loop events and decision evidence.
- [ ] T13.26 Add dashboard Worker Pool Runner panel.
- [ ] T13.27 Add tests for low-risk allowed, high-risk blocked, runtime unavailable, low capacity, token exhausted and timeout stop.
- [ ] T13.28 Run end-to-end drain smoke with at least two prepared low-risk leases and bounded concurrency.

Validation:

- [ ] Runner never starts high-risk work without required approval/security gate.
- [ ] Runner respects recommended concurrency.
- [ ] Failed workers remain auditable.
- [ ] Dashboard shows exact policy/capacity reason for every blocked lease.
