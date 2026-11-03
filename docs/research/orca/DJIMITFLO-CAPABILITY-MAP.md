# DjimitFlo counterparts to Orca's mechanisms

## Sources and limits

| Field | Value |
|---|---|
| Source revision | origin/main `2a0bff5b` (#997), worktree `research/orca-assimilation`. Paths below are relative to `packages/server/src/` unless noted. |
| Reused inventories | `docs/research/l3-forensics/L3-REPORT-v2-20261021.md` (cited "L3-v2"), `capability-inventory-v2.json`. `docs/research/aw0/CAPABILITY_INVENTORY.md` (branch `docs/aw0-forensics`, PR #998; cited "AW0"). `docs/audits/djimitflo-l6/` and `docs/audits/agent-commons/` exist only in the main checkout (untracked, pinned to deployed `f957b552`, 24-10; cited "L6"). These were not redone. Spot-checks below confirm or correct them against current source. |
| Runtime facts | Only documented read-only prod facts, with their date. No host, container or DB was queried by this work. Anything else is **UNKNOWN**. |
| ASG-001 boundary | `assignment-context.ts`, the skill model, and the macro/recovery code in `loop-worker-executor-service.ts` belong to the parallel builder (branch `feat/asg-001-adaptive-granularity`). They were read where needed and **not modified**. |
| Frozen TG surface | `scripts/gym-worker.mjs`, `tg-001.ts` and `remote-gym-service.ts` were read only. |

**Status legend.**
- **EXISTS_AND_VERIFIED**: code on main plus a test that exercises the claim.
- **EXISTS_UNVERIFIED**: code on main, but the claim is not covered by a test I found.
- **PARTIAL**: covers part of the mechanism.
- **MISSING**: no counterpart.
- **SUPERSEDED**: DjimitFlo deliberately does it differently.
- **BROKEN**: demonstrated wrong behaviour.
- **UNKNOWN**: no evidence either way.

## Map

### 1. Worktree orchestration: EXISTS_AND_VERIFIED for create and repair; PARTIAL for orphan GC and idempotency

**Counterpart.** `services/worktree-manager.ts`:
- `createWorktree`: retries on git lock errors, 3 attempts, 250·n ms.
- `repairWorktree`: re-registers a worktree after a fresh-clone deploy (prod 2026-09-25).
- `pruneOrphanedWorktrees`.
- `isPathAllowed` / `sanitizeFindingId`.
- Tests: `worktree-identity.test.ts`, `worktree-repair.test.ts`, `worktree-retry.test.ts`, `council-failure-and-worktree-health.test.ts`.

**Evidence and gaps (spot-checked):**
1. `createWorktree:36-38` returns any existing directory at the target path **without checking** that it is a git worktree on the expected branch.
   - Orca checks ownership through the lock reason, and refuses to reuse paths that a pending removal still owns.
   - The repair path partly covers a broken link (`loop-worker-executor-service.ts:201` calls `repairWorktree`). A stale non-worktree directory is not covered.
2. `pruneOrphanedWorktrees:155-221` deletes any directory under `LOOP_WORKTREE_ROOT` that has no lease in `prepared|running` and whose *top-level* mtime is more than 24 h old. That mtime does not change when files deeper down change.
   - Orca deletes an orphan only with positive proof: a `.git` file pointing back at this repo.
   - No incident is documented. Whether a waiting non-`prepared/running` lease's worktree was ever pruned is **UNKNOWN**.
3. Branches (`agent/loop/<run>-<finding>`) are never deleted after `worktree remove`. The ref count in prod is **UNKNOWN**.

### 2. PTY and session lifecycle: SUPERSEDED for PTY; BROKEN (now fixed behind a flag) for process-tree termination

**Counterpart.** DjimitFlo runs one-shot headless CLIs (`opencode run`, `codex exec`, `claude -p`, …) on pipes, with no PTY, attach or scrollback.
- All executors and `RuntimeCommandService.executeRuntimeCommand` stop through `execution/executors/runtime-process.ts` `stopRuntimeProcess` (SIGTERM, then SIGKILL after 5 s), or through `child.kill('SIGKILL')` on a runtime-command timeout.

**Evidence of BROKEN** (measured, see EVALUATION-REPORT):
- Children were spawned without `detached`, and only the root pid was signalled.
- A grandchild that inherits stdout and ignores SIGTERM survived the stop **10/10**.
- `close`, which finalises the lease and releases the runtime permit (`runtime-command-service.ts:288-330`, `registerRuntimeLease`), fired only when the grandchild exited by itself: 7996–8006 ms for an 8 s grandchild.
- With an unbounded grandchild (watch-mode test runner, MCP server, dev server), the lease and its `RUNTIME_MAX_CONCURRENCY` permit are held indefinitely.

**Process-tree grep.** No server source used `detached`, `process.kill(-pid)` or any tree kill (grep on `2a0bff5b`).
- `deep-agent-executor.ts` and `docker-sandbox-executor.ts` have their own root-only kill. They are not changed here; docker-sandbox removes its container with `docker rm -f`.

**Admission ledger caveat.** `execution/runtime-admission.ts:158` records opencode `lifecycle: PASS` ("wall-clock timeout and kill … stop/cancel via engine"). Its evidence test is `loop-runtime-stop.test.ts`, whose fixture is a single process, so the PASS does not cover descendants. The ledger is review-governed and is not edited here.

**Deployed reality.**
- The prod image runs `docker-entrypoint.sh` → `exec node …` with no `init:` in `docker-compose.yml` (read on `2a0bff5b`). Node is PID 1, so reparented, killed grandchildren may remain zombies (I).
- Whether orphaned runtime descendants exist in `djimitflo-live` today is **UNKNOWN** (not probed).

### 3. SSH remote exec and reconnect: SUPERSEDED (pull model)

**Counterpart.** Operator rule 2026-09-29: "the host pulls, Djimitflo never connects to it".
- `scripts/djimit-host-agent.py`: polls `/api/host-agent/poll`. Shell commands are handed out only after human approval, and the agent re-checks their sha256.
- `scripts/gym-worker.mjs`: claims via `/api/gym-worker/claim`.
- `services/remote-maker-queue.ts`: the host returns only a patch; claim-timeout and cancel reasons per #699.
- Reconnect is the next poll. Fencing of late results is in #699/#719.

**Status.** EXISTS_AND_VERIFIED: `remote-maker.test.ts`, `gym-worker.test.mjs`.
- L3-v2 §2 still records the edge `remote_maker_jobs → worker_leases` as missing (no lease id); `remote-maker-queue.ts:14-15` now carries `loop_run_id`/`lease_id`, nullable.
- Orca's reconnect ladder and timer-lateness re-probe have no use in a pull model.

### 4. Agent CLI adapters and provider abstraction: EXISTS_AND_VERIFIED

**Counterpart.**
- Executors under `execution/executors/`: opencode, claude, codex, gemini, pi, hermes, editor (cline), atomic, deep-agent, docker-sandbox, remote-maker, mock. Each has a test file.
- `RuntimeCommandService.buildRuntimeCommand` / `getRuntimeContract`, with a `--version` + help contract probe (`runtime-command-service.ts:188-195`).
- `runtime-admission.ts`: an evidence-backed admit/hold ledger per runtime@version.
- Structured output parsing into `tool.call`/`tool.result` events.

**Delta vs Orca.**
- Orca's per-major minimum-version floors are fail-open; DjimitFlo's admission ledger is stricter.
- Hook-based turn status and trust pre-writes are interactive-only.

### 5. Concurrent agents and admission: EXISTS_AND_VERIFIED

**Counterpart.**
- `services/concurrency-semaphore.ts` `runtimeConcurrencySemaphore` (`RUNTIME_MAX_CONCURRENCY`; `runtime-semaphore.test.ts`).
- Gym caps: local 12, remote 24, subscription 5 (AW0).
- Bandit share cap `LOOP_BANDIT_MAX_SHARE` (L3-v2: 0.8 since 20-10).
- Evolve sibling makers (max 2).

**Delta.** Orca's token bucket for automatic work offers nothing that daily caps plus the semaphore don't already cover.

### 6. Diff collection and review: EXISTS_AND_VERIFIED for gates; EXISTS_UNVERIFIED for PR-create idempotency

**Counterpart.**
- `worktree-manager.applySourceWorkingTreeDiff` (`git diff --binary HEAD` + untracked copy with traversal guards).
- Maker diff caps, deterministic checks, checker and security checker (SEC-F1 KEEP, L3-v2).
- `services/loop-draft-pr-service.ts`.
- `scripts/merge-train.sh`: claimed intents, live re-read, head-pinned merge (`merge-train*.test.ts`).

**Gap.** `loop-draft-pr-service.ts:108-114` POSTs `/pulls`. A non-2xx response, including GitHub's 422 "A pull request already exists" after an ambiguous earlier attempt, returns `fail('GitHub <status>')` and records no `pr_url`.
- Orca looks up the existing PR instead of retrying.
- Whether this ever happened in prod is **UNKNOWN**.

### 7. Task → agent assignment: EXISTS_AND_VERIFIED (out of scope here)

**Counterpart.** Proposal → panel → goal → loop run → maker/checker leases; bandit species selection; evolve contest (`services/evolve-selection.ts`, `evolve-*.test.ts`); `assignment-context.ts`.
- Assignment context is owned by ASG-001, so it was not assessed for change.
- Orca's issue-to-worktree linking is a human workflow.

### 8. Browser and computer use: MISSING (by choice)

**Counterpart.** None in the runtime. Playwright MCP exists for development only (`.vscode/mcp.json`).
- No lane needs a browser (no evidence of demand in L3-v2 or L6).

### 9. Persistent session state: EXISTS_AND_VERIFIED

**Counterpart.** SQLite (`better-sqlite3`) is the single authority: `worker_leases`, `loop_runs`, `remote_maker_jobs`, `llm_model_calls`.
- `RuntimeLeaseRegistry` is in-process (`loop-recovery-service.ts`).
- Restart recovery is `recoverInterruptedRuns` (ASG-001-adjacent; not touched).
- Orca's `BEGIN IMMEDIATE` + revision fence is analogous to DjimitFlo's fenced claims (for example `discovery_relevance_backlog`, per the runbook).

### 10. CLI automation: EXISTS_AND_VERIFIED

**Counterpart.** REST API (JWT), `packages/mcp-server`, operator scripts (`scripts/*.mjs`, `merge-train.sh`).

### 11. Usage tracking: PARTIAL

**Counterpart.**
- `llm_model_calls` (`database/migrate.ts:1373`).
- `services/cost-ledger.ts`, `usage-accounts.ts`, `usage-telemetry.ts`.
- Opencode step-token parsing plus `OPENCODE_MAX_RUN_TOKENS`.
- Maker token accounting, measured vs estimated (#818).

**Coverage gap** (L6 14, 24-10):
- 30 d: 1 604 maker leases; opencode 295 leases, of which 71 have measured tokens.
- Claude and codex provider token records exist, but `cost_known` is 0.
- Orca's transcript-JSONL parser with a session-independent dedupe key would fill claude/codex coverage, but those makers have been idle since 19-10 (claude) or broken (codex) per L3-v2 §3a.

### 12. UI and observability: EXISTS, with known PARTIALs

**Counterpart.** Dashboard, `/api/health/*` (config, evolution-evidence, knowledge, schedulers), provenance DAG (`services/provenance-dag.ts`; tests), audit log.

**Known gaps** (L6 06, 15 G03, 24-10): `task.failed` noise from tool-call events, a false-empty Audit Loop, and no runtime-descendant visibility.

## Classification summary

| Mechanism | Status | Primary evidence |
|---|---|---|
| Worktree create/repair | EXISTS_AND_VERIFIED | worktree-manager.ts; worktree-{identity,repair,retry}.test.ts |
| Worktree orphan GC / reuse proof | PARTIAL | worktree-manager.ts:36-38, 155-221 |
| PTY sessions | SUPERSEDED | headless one-shot executors |
| Runtime process-tree termination | **BROKEN → fixed behind `RUNTIME_PROCESS_GROUP_KILL`** | runtime-process.ts; runtime-process-group.test.ts; evaluation-data.json |
| SSH push + reconnect | SUPERSEDED | djimit-host-agent.py, gym-worker.mjs, remote-maker-queue.ts |
| Agent adapters / provider abstraction | EXISTS_AND_VERIFIED | executors/*, *-executor.test.ts, runtime-admission.ts |
| Concurrency / admission | EXISTS_AND_VERIFIED | concurrency-semaphore.ts, runtime-semaphore.test.ts |
| Diff + review gates | EXISTS_AND_VERIFIED | checkers, merge-train*.test.ts |
| Draft-PR create idempotency | EXISTS_UNVERIFIED (gap) | loop-draft-pr-service.ts:108-114 |
| Task assignment | EXISTS_AND_VERIFIED (ASG-001 owns changes) | evolve-selection.ts, assignment-context.ts |
| Browser / computer use | MISSING (no demand) | — |
| Persistent state | EXISTS_AND_VERIFIED | SQLite, RuntimeLeaseRegistry |
| CLI automation | EXISTS_AND_VERIFIED | REST, mcp-server, scripts |
| Usage tracking | PARTIAL | L6 14; #818 |
| Observability | EXISTS (PARTIALs in L6) | L6 06/15 |
| Orphaned runtime descendants in prod | UNKNOWN | not probed |
