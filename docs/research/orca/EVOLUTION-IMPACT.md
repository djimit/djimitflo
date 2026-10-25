# Evolution impact of the Orca assimilation

What this work changes in DjimitFlo's ability to run, measure and improve its agents. Demonstrated results and hypotheses are kept apart.

## Demonstrated (local tests and measurements; `evaluation-data.json`)

| # | Claim | Evidence |
|---|---|---|
| D1 | On origin/main `2a0bff5b`, a runtime descendant that holds the CLI's stdout survives a stop or timeout. The lease's `close` (finalise, permit release, registry removal) waits for that descendant to exit. | Pre-change probe: 6 002 ms for a 6 s descendant. Flag-off arm: 7 998 ms for an 8 s descendant; 5/5 runtime permits still held 1 s after a 1 s timeout. |
| D2 | With `RUNTIME_PROCESS_GROUP_KILL=on`, stop and timeout reap the whole process group. Lease finalisation is bounded by the timeout plus ≤ 2 s exit grace, independent of the descendant. | 2 004 ms (stop) and 1 004 ms (1 s timeout); 0/10 and 0/5 descendants alive; 0/5 permits held |
| D3 | With the flag off, behaviour is unchanged | Identical spawn args; no `process.kill` call; 207/207 related tests pass in both flag states |
| D4 | Server shutdown (SIGINT, `process.exit`) takes the detached groups along | Subprocess tests in `runtime-process-group.test.ts` |
| D5 | The suite detects removal of each new safeguard | 3/3 mutants killed |
| D6 | No other Orca mechanism addresses a verified DjimitFlo deficiency today | ORCA-ADOPTION-DECISION: C2–C4 lack a verified occurrence or an active consumer, or overlap ASG-001; C8–C12 are superseded or have no demand |

## Hypotheses (not measured; each with the measurement that would test it)

| # | Hypothesis | Why plausible | How to test it (read-only first) | Expected direction |
|---|---|---|---|---|
| H-E1 | Some prod maker or checker timeouts (`timed_out=true`, `token budget exceeded`) finalise late, because an orphaned tool child holds the pipe | Agent CLIs run test suites and shells as children; DjimitFlo had no tree kill anywhere | In prod, compare `runtime_stop_requested_at` (lease metadata) with the lease's terminal timestamp for cancelled and timed-out leases over 30 d. A gap > 2 s identifies the cases this fix addresses. Separately, run `ps -o pid,ppid,pgid,etime,args` in the container for node-reparented processes. Both need operator approval for the read. | If gaps > 2 s exist, enabling the flag removes them |
| H-E2 | Orphaned children hold `RUNTIME_MAX_CONCURRENCY` permits and so lower the effective maker throughput | D1 shows the mechanism; prod frequency is UNKNOWN | Read-only: permits in use (`runtimeConcurrencyInUse`) while no lease is `running` | More completed leases per day at equal caps; small unless H-E1 is frequent |
| H-E3 | A cancelled maker's orphaned child can modify the worktree after cancellation, which contaminates evidence for a re-attempt or a checker cut from that worktree | Grandchild survival (D1) plus the shared worktree path | Fixture test: an orphan writes to the worktree after the stop; mtime is later than `runtime_stop_requested_at`. In prod: compare mtimes on cancelled leases' worktrees, read-only. | Flag on removes post-cancel writes from in-group descendants |
| H-E4 | Gym, evolve and bandit fitness is slightly cleaner when a stopped species can't leave state behind | Follows from H-E3 | Only if H-E3 is confirmed. The frozen TG/gym surface was not touched, and `gym-worker.mjs` uses `spawnSync` on its own host, so this change doesn't reach the remote gym. | Not expected to be measurable at the current gym volume (L3-v2: 7/16 per day on 21-10) |

## What does not change

- **Learning and selection logic.** No change to the skill model, assignment context, lease recovery, gates, bandit, evolve selection, memory, experiments or the admission ledger.
- **Remote and gym paths.** The remote maker, gym worker and host agent run on other hosts with their own process handling, so they are unaffected.
- **Prod.** The flag is off. No deploy, flag, credential or experiment change.

## Next actions, in order

1. **Operator: run the read-only H-E1 probe.** Activation is justified only if H-E1 shows gaps > 2 s or `ps` shows node-reparented runtime descendants.
2. **If confirmed, roll out step by step.** Set `RUNTIME_PROCESS_GROUP_KILL=on` on the workstation or staging first, then in prod `runtime.env` alone in one deploy. Watch the signals listed in IMPLEMENTATION-PLAN "Activation".
3. **Re-assess the admission ledger.** Re-evaluate opencode `lifecycle: PASS` (`runtime-admission.ts:158`) through review, citing `runtime-process-group.test.ts`, since the cited `loop-runtime-stop.test.ts` covers only a single process.
4. **Next bounded candidate: C2** (look up the existing draft PR instead of failing on 422). First count `draft_pr_failed` events with `GitHub 422` in prod, read-only.
5. **Orphan-proof GC: C3, deferred.** Coordinate with ASG-001, which owns the loop worker executor that calls `createWorktree`/`repairWorktree`. Write the gap test first.
