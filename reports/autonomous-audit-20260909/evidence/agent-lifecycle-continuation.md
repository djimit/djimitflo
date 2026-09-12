# Core-agent lifecycle: local executable boundary proof

2026-09-09, isolated audit checkout. No provider, production account, external registry or real OKF data was modified. Heartbeat fixtures use newly allocated temporary OKF directories and disposable SQLite; Dennis fixtures point Paperclip import at a nonexistent temporary path.

## Reproduced chain breaks

- A checker with `write:evidence` could heartbeat any paused, offline or pending-approval agent into active status, then the common engine would admit work. Heartbeat metadata also replaced operator-owned configuration. All three actual HTTP/SQLite/engine regressions failed before correction.
- Agent POST used `INSERT OR REPLACE`: same-ID registration reset metrics/current-task ownership and triggered SQLite FK deletion behavior; a new ID reusing another agent's name replaced that identity. Actual tasks/messages were affected in the fixture.
- Retirement ignored its agent argument when cancelling prepared leases. It then attempted an unsupported `status='retired'` against the real schema, after partial changes. Knowledge-transfer code read a nonexistent `capabilities_json` column and never stored knowledge; pre-retirement checking was not enforced. Unknown agents could still cancel unrelated work and acquire archives.
- Deleting a running or retired agent detached task ownership or failed through audit constraints instead of giving a controlled refusal. Dennis's internal heartbeat independently reset paused/offline/pending-approval state to active and continued importing work.

## Existing-boundary correction

Agent registration now updates the existing row in place, preserves lifecycle/counters/current-task/configuration defaults and rejects another identity's name with409. Existing foreign-key children remain intact. Heartbeat stores observations under `metadata.heartbeat` and updates timestamps without granting execution status or changing existing top-level configuration. Lifecycle status remains operator-owned.

Retirement uses one immediate SQLite transaction: validate the existing agent and exact assigned work, refuse live/nonterminal/recovery-held work with409, store an actual agent/task/lease snapshot in existing `agent_archives`, cancel only owned prepared leases, persist `status='offline'` with existing `retired_at`/`retirement_reason`, and append a canonical audit attributed to the authenticated actor. A worker is associated through `worker_leases.metadata.execution_task_id` → `tasks.agent_id`; merely spawning a lease is not executor ownership. Anonymous and unrelated leases are not cancelled. Retries preserve one archive/audit. Audit failure rolls everything back.

No CHECK migration was added: `offline` is the existing operational non-dispatchable state and `retired_at` is the durable retirement marker. Retirement status/list derive logical retired from that marker. Registration, heartbeat, direct status and NL approval cannot revive it. Deletion refuses retained task/message/audit history or retirement markers instead of deleting lineage. Parent-owned engine admission independently checks the marker even if an old/internal writer left an inconsistent operational status.

Dennis heartbeat preserves current lifecycle status and does not automatically import Paperclip work while inactive/retired. Initial registration still creates the existing active Dennis record. No additional agent registry or background scheduler was introduced. The old separate `agent_lifecycle` subsystem was not silently merged with core `agents`.

## Executed evidence

- [Initial red](agent-lifecycle-boundary-red.log): **12/12 failed** before correction.
- [Deletion red](agent-deletion-boundary-red.log): **2 failed / 14 passed** before deletion protection.
- [Dennis red](dennis-heartbeat-lifecycle-red.log): three new heartbeat lifecycle failures before correction.
- [Integrated green](agent-lifecycle-integration-green.log): **93/93 passed** across five suites, including17 new core-agent tests, three new Dennis regressions, existing NL/phase4 tests and common engine tests. Actual Express/JWT middleware, SQLite foreign keys, injected SQLite audit failure and runtime-registry ownership are exercised. No real provider is used.
- Server typecheck, scoped ESLint and `git diff --check`: exit0.

The previous four retirement tests used an empty database and asserted only that a plan/steps existed. Their setup now uses the actual migrated schema and an actual registered agent; production does not gain a fallback for missing tables or nonexistent agents.

## Explicit limits

Retirement is quiescent deactivation and retained evidence, **not** process draining, cancellation of unknown external work, knowledge promotion, automatic reassignment, worktree deletion or a reactivation protocol. Existing archives are local snapshots, not independently verified backups. Unattributed loop leases cannot be claimed as owned by a core agent. No arbitrary historical data is deleted or repaired by this tranche. Whole-repository and actual browser validation remain separate parent integration evidence.
