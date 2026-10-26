# ORCA-PG: runtime process-group termination

## Deficiency (verified)

Every executor (opencode, claude, codex, gemini, pi, hermes, editor, atomic) and `RuntimeCommandService.executeRuntimeCommand` work the same way:
- They spawn the agent CLI with piped stdio and no `detached` flag.
- They stop it by signalling **only the CLI's pid**: `stopRuntimeProcess`, or `child.kill('SIGKILL')` on a runtime-command timeout.

An agent CLI's own children inherit its stdout pipe: the test runner it invoked, a shell, an MCP server, an LSP. Two things follow:

1. **Those children keep running after cancel or timeout.** They may keep mutating the worktree of a lease that is already `cancelled`.
2. **`close` waits for the last pipe holder.** In `RuntimeCommandService`, `close` → `finalize` → `cleanupLease` is what releases the `runtimeConcurrencySemaphore` permit and removes the `RuntimeLeaseRegistry` entry. For the engine executors, the session's `closed` promise is what `cancel()` awaits. The lease therefore stays open until the orphan exits, which is never for a watch process.

Baseline, measured on unmodified code (`evaluation-data.json`):
- The root died in about 1 ms.
- `stopRuntimeProcess` resolved at 6 002–6 004 ms, which is exactly the grandchild's 6 s lifetime (5/5 trials).
- The grandchild was alive 1 s after the stop.

## Hypothesis (falsifiable)

**H1.** With `RUNTIME_PROCESS_GROUP_KILL=on`:
- (a) A stop of a runtime whose descendant ignores SIGTERM and holds stdout resolves within min(stop grace 5 s, exit grace 2 s) plus scheduling. It does not depend on the descendant's lifetime.
- (b) The descendant is dead when the stop resolves.
- (c) A `RuntimeCommandService` timeout finalises the lease and releases its permit at the timeout (≤ timeout + 100 ms). Its descendant is dead.

**H0** (rejected if any of these happens): flag-on stop latency tracks the descendant's lifetime; the descendant survives; or the permit is still held 1 s after the timeout.

**Equivalence claim.** With the flag off, behaviour is unchanged: the same spawn options, no negative-pid signal, and the same latencies.

## Design (adapted from Orca `process-host`, not copied)

The change is in `execution/executors/runtime-process.ts`:

**`runtimeProcessGroupKillEnabled(env, platform)`**
- True only for `RUNTIME_PROCESS_GROUP_KILL=on` on a platform other than win32.

**`spawnRuntime(command, args, options, exitGraceMs = 2000)`**
- A drop-in for `spawn`.
- Flag off: passes `options` through untouched.
- Flag on: adds `detached: true`, so the child calls setsid and becomes the leader of a new group whose pgid equals its pid.
- Records the child in a `WeakSet` of group leaders.
- After the root's `exit`, waits `exitGraceMs` (Orca's `PROCESS_EXIT_GRACE_MS`), then SIGKILLs whatever is left in the group, so `close` can fire.
- Safe against PID reuse: the kernel does not reassign a PID that is still in use as a pgid.

**`signalRuntimeProcess(child, signal)`**
- Calls `kill(-pid)` only for a recorded group leader.
- Falls back to the handle on ESRCH or for any foreign child. This mirrors Orca's kill gate: refuse the group, kill the root.

**`stopRuntimeProcess(child, {graceMs = 5000})`**
- Grouped: SIGTERM the group; after the grace, SIGKILL the group if it still exists.
- A stop after the root already exited still reaps a non-empty group.
- Duplicate stops join the first stop's promise (unchanged).

**Server exit hook**
- `process.once('exit')` SIGKILLs all live groups. `index.ts`'s SIGTERM handler ends in `process.exit(0)`, so this covers prod shutdown.
- A detached group no longer receives the terminal's SIGINT. So when no one else listens for SIGINT or SIGHUP, a relay kills the live groups, removes itself and re-raises the signal, keeping the default termination.
- `LifecycleManager.initSignalHandlers` has no caller on `2a0bff5b`.

**Difference from Orca.** Orca waits for group quiescence by polling `ps` states. DjimitFlo does not, because a container with node as PID 1 may keep killed grandchildren as zombies, and those still answer `kill(-pgid, 0)`. Completion stays bound to `close`; zombies have closed their fds.

**Call sites.** `spawn(` becomes `spawnRuntime(` in 8 executors and in `runtime-command-service.ts`. The runtime-command timeout's `child.kill('SIGKILL')` becomes `signalRuntimeProcess(child, 'SIGKILL')`.

`deep-agent-executor.ts` and `docker-sandbox-executor.ts` are deliberately unchanged:
- deep-agent is not a loop maker.
- docker-sandbox removes its container with `docker rm -f`.

## Not done (scope)

- Descendants that call `setsid` themselves (daemonising tools) leave the group and are not reaped. Orca has the same limit on POSIX.
- No change to the runtime-admission ledger. `opencode lifecycle: PASS` cites a single-process test, and re-assessing it goes through review.
- No lease-recovery or stale-lease change. That belongs to ASG-001.

## Tests (`src/__tests__/runtime-process-group.test.ts`, 14 cases, POSIX only except the flag test)

| Concern | Test |
|---|---|
| Flag parsing / Windows | off unless `on`; `true` is not `on`; win32 never |
| Documented legacy gap | flag off: the grandchild survives the stop; stop latency ≥ grandchild lifetime |
| Timeout + SIGKILL escalation | flag on: a SIGTERM-ignoring grandchild is reaped; latency ≥ grace (proves the escalation) and < 2 s |
| Cooperative termination | flag on: dies on SIGTERM well before the 5 s escalation |
| Partial failure: root exits alone | flag on: a pipe-holding grandchild is reaped after the exit grace; `close` fires |
| Cancel races a finished CLI | flag on, exit grace 60 s: a stop after the root exited still reaps the group |
| Duplicates | a second stop returns the same promise; a stop after close resolves immediately |
| Unauthorized op | a child not spawned as a group leader is never group-signalled (no negative pid passed to `process.kill`) |
| Flag-off equivalence | no `process.kill` call at all on stop; spawn args unchanged |
| Already-gone group | the ESRCH fallback does not throw |
| Lease + permit (integration) | `RuntimeCommandService` 1 s timeout: flag off holds about 4 s (documented gap); flag on finalises < 2.5 s, no permit leaked, grandchild dead |
| Restart / shutdown | the real module in a `node --import tsx` subprocess: on SIGINT (relay) and on `process.exit` the subprocess's detached runtime group is reaped |

Mutation check: three mutants were each killed by the suite:
- no group kill in the exit hook: 2 tests fail
- no `detached`: 9 tests fail
- no exit-grace reap: 1 test fails

The existing suites run unchanged with the flag both off and on (EVALUATION-REPORT).

**Restart.** Groups are process-local; nothing is persisted. On SIGINT and on `process.exit` the hook kills live groups (both tested in a subprocess). SIGTERM is covered because `index.ts`'s handler ends in `process.exit(0)`; that path itself is not exercised here. A crash (SIGKILL of node) leaves detached groups alive outside a container; in the prod container they die with the PID namespace (I). Before this change, an un-detached child survived a SIGKILL of node too (it was reparented), so this is not a regression.

## Rollback

Unset `RUNTIME_PROCESS_GROUP_KILL`, or set any value other than `on`. No data, schema or persisted state is involved. Reverting the commit is also clean.

## Activation (operator decision; not done here)

1. Staging or the workstation first. The tests above already cover the mechanism; this step checks the CLIs in the real environment.
2. Then `runtime.env` on prod, with no other change in the same deploy.
3. Watch for:
   - `runtime_stop_*` metadata on cancelled leases
   - `timedOut` maker results whose `close` comes ≤ timeout + 2 s
   - `RUNTIME_MAX_CONCURRENCY` permits in use returning to 0 between runs
   - no new `task.failed` from the CLIs (detached children have no controlling tty; all executors use pipes)
