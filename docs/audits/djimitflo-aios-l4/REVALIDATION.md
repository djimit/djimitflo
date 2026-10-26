# Revalidating the 8 earlier findings

**Scope.** The earlier findings were made at source `e796f3ae` (#1009). I re-read them at origin/main `57182e9f` (12 commits later), then re-pinned them to `a4a083ac` (#1015, which merged during writing and touched only the engine and skill-outcome files).
- Of the finding files, only `services/resource-scheduler.ts` and `services/loop-daemon.ts` (+2 lines) changed in between (#1014).
- `routes/swarms.ts` changed too, but only for the mission-detail route.
- Paths are under `packages/server/src/` unless stated otherwise.
- Callers were found with `git grep` at `a4a083ac`. Test files are excluded unless named.

## Verdicts

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | ResourceScheduler uses a fixed capacity | **PARTIAL** | SOURCE_VERIFIED; shadow rows UNKNOWN-BLOCKED |
| 2 | Completed maker leases count as `verifiedArtifacts` | **STILL_PRESENT** (fix in flight) | SOURCE_VERIFIED |
| 3 | Missing usage becomes 0 | **PARTIAL** (engine part FIXED by #1015) | SOURCE_VERIFIED; deploy UNKNOWN |
| 4 | ToolBroker does not mediate CLI-internal tools | **STILL_PRESENT** | SOURCE_VERIFIED; S0 is OBSERVED (#948, 22-10) |
| 5 | Concurrency and ownership registrations are process-local | **STILL_PRESENT** (single-controller assumption) | SOURCE_VERIFIED; single instance INFERRED |
| 6 | Checkpoints exist, but nothing generally resumes external processes | **STILL_PRESENT** (path-specific settlement only) | SOURCE_VERIFIED |
| 7 | Memory fan-out has no proven durable delivery | **STILL_PRESENT** | SOURCE_VERIFIED |
| 8 | Skill distillation records cards that nothing adopts | **STILL_PRESENT, by design** | SOURCE_VERIFIED |

## Detail

### 1. Fixed scheduler capacity (PARTIAL)

**What still decides.** The decision still comes from constants:
- `checkAvailability` returns `cpu_available: 8` and `mem_available_mb: 16384` (`services/resource-scheduler.ts:133-141`).
- `canSchedule` (`:152-155`) uses them, and its only caller is `services/loop-daemon.ts:507`.

**What #1014 added.**
- `recordShadow` (`:162-181`, called at `loop-daemon.ts:509`) writes a `scheduler_capacity` judgment when the observed decision differs from the constant one.
- The rows are read only by evidence (`services/evolution-evidence.ts:507`).
- The plan reports RESOURCE_SCHEDULER_MODE=shadow live since the 57182e9f deploy (25-10, 20:03Z).

**The scope mismatch is still open.**
- `cpus` can be the cgroup limit (`:71-75`), but `load1` is the host-wide `os.loadavg()` (`:78`). They are combined at `:96` as `max(0, cpus − load1)`.
- In a CPU-limited container on a busy host, this understates the capacity that is free.
- Whether the prod container has a CPU limit is UNKNOWN (#1014 lists it as unverified).
- The Orca delta notes that Orca removed the same cap the day it added it.

### 2. Completed leases counted as verified (STILL_PRESENT)

**The query.** `services/loop-budget-service.ts:140-142` counts `role='maker' AND status='completed'`.

**The money side of the same function:**
- Tokens come only from `runtime_usage.total_tokens` (`:134-135`).
- When that is missing, the result is 0 tokens, so $0 and `efficiency: 0` (`:146`).
- An unknown runtime price falls back to $2/M (`:103`).
- The runtime defaults to `'codex'` (`:130`).

**Caller chain.** `services/loop-service.ts:794-795` → `routes/swarms.ts:406` (`GET /swarms/economy`, `recent_runs`).

**Fix.** It is in flight on `fix/economy-metric-truth`. That branch was not pushed when this was written.

### 3. Missing usage becomes 0 (PARTIAL)

**Fixed:**
- `services/cost-ledger.ts:15-16` (unknown is null);
- `services/maker-token-accounting.ts:5-28` (#818: null, never 0);
- `services/loop-worker-executor-service.ts:306,457,715` (`usage_source:'unknown'`);
- #706 (resource ledger) and #1012 (account usage);
- **engine outcomes, by #1015 (merged at `a4a083ac`).** `execution/execution-engine.ts:1187,1209,1264` now pass `reportedTokens(...)`, which is null when nothing was reported (`:84-86`). Success requires `test_result` evidence (`:1388-1395`), and the model is the effective model, not the runtime (`:1397-1411`). The `skill_outcomes.tokens_used` NOT NULL rebuild runs at boot (`services/skill-evolution-engine.ts`, `relaxTokensNotNull`). Whether it has deployed is UNKNOWN.

**Still open:**
- **Gym.** `scripts/gym-worker.mjs:545` sends `tokens: tgm?.tokens ?? 0`, and `services/remote-gym-service.ts:289` stores `Math.max(0, Number(result.tokens) || 0)`. The column can now hold null, but the gym path still writes 0. The gym outcome truth PR is in flight.
- **Finding 2.** `loop-budget-service.ts:135`.

### 4. ToolBroker does not mediate CLI tools (STILL_PRESENT)

**Code.**
- The header says so: `services/tool-broker.ts:4-6`.
- The broker is constructed only at `execution/execution-engine.ts:158`.
- Its getter `getToolBroker` (`:133`) has no caller.
- No production code calls `evaluateToolCall`.

**Consequences.**
- This is S0: makers share the control plane's uid and its DB (#948, plan 22-10).
- The closing design is sandbox-runner #950 (a draft).
- The Orca delta (b) rates Codex app-server approval routing as the only per-tool channel, as an experiment, not now.

### 5. Process-local registrations (STILL_PRESENT)

**In-memory state that carries ownership or permits:**
- `services/concurrency-semaphore.ts:11,50`: the permit Set is a module singleton. It is used by `execution/execution-engine.ts:482` and `services/runtime-command-service.ts:403`.
- `services/loop-recovery-service.ts:44`: `RuntimeLeaseRegistry`, a static Map of stop handles.
- `services/loop-daemon.ts:171,173`: `activeGoals` is persisted and restored. `executing` is in-process only.
- `execution/execution-engine.ts:94-95`: `activeSessions` and `pendingExecutions`.
- `execution/executors/runtime-process.ts:19`: `liveGroups`.

**What is durable.** `worker_leases`, plus `remote_maker_jobs` with its lease binding (`services/remote-maker-queue.ts:55-77`).

**Why it holds today.**
- `git grep` finds no instance lock or leader lease for the server.
- Correctness depends on one server process per database. The code says this itself: "single-server-per-DB model" (`execution/execution-engine.ts:199`).
- Today that is one `djimitflo-live` container, so the guarantee comes from deployment, not from code.

### 6. No general resume (STILL_PRESENT)

**No resume path.**
- `resumeInterruptedRun(s)` (`services/loop-recovery-service.ts:209,257`; facade `services/loop-service.ts:479,489`) has no production caller. Only the tests call it (`__tests__/g10-crash-recovery.test.ts`).
- The comment at `services/loop-daemon.ts:124` is stale.

**What boot does instead.**
- `index.ts:109` → `recoverInterruptedRuns` (`:156`). It settles deploy-restart zombies (#880, `:123,187,194`), skips remote gym runs (`:190-193`), and marks the rest `interrupted`.
- `index.ts:213` → `recoverInterruptedTasks` (`execution/execution-engine.ts:203-239`) gives `execution_recovery_outcome:'unknown'` plus a hold. That is correct.

### 7. Memory fan-out without durable delivery (STILL_PRESENT)

**The trigger.** `execution/execution-engine.ts:1176-1177` is fire-and-forget into `services/memory-sync-service.ts:69-85`, which uses `Promise.allSettled` across three legs.

**Per leg:**
- **UAMS:** 3 in-process attempts with backoff (`:88-130`).
- **Qdrant:** one upsert and no retry (`:132-203`, upsert at `:190`).
- **OKF:** a file write.

**Same pattern elsewhere.** `services/reasoning-bank-service.ts:124-180` does a file write plus one upsert.

**What is missing.**
- Failures only `console.warn`.
- There is no receipt row, no outbox and no replay.
- Point ids are idempotent (`utils/qdrant-point-id.ts`), so a replay would be safe if one existed.
- DKF-EVOLUTION #971 (OBSERVED 22-10) found that the reasoning bank is write-only and that two Qdrant instances had diverged.

### 8. Skill cards are not adopted (STILL_PRESENT, by design)

- **Record-only by design.** `services/skill-distillation.ts:8-13,141` states it.
- **Readers.**
  - `services/lane-playbook.ts` and `services/dream-evidence-sources.ts:45` feed the epoch-1 genome trial genes (g-d14c1156 playbook, g-a187f81f strategy lines) under the #962 pre-registration.
  - `services/evolution-feedback.ts:93-99` reads them into a count digest.
  - No reader puts them into a prod maker context.
- **Adoption gate.** Cards reach prod makers only after ACE-001 (readout 15-11) and an operator OK.
- **Count.** The plan gives 113 cards (OBSERVED 25-10).
