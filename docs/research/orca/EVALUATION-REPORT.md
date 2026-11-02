# ORCA-PG evaluation: baseline vs modified

**Verdict: IMPROVED** for the mechanism (H1 a, b and c all hold; H0 rejected). **EQUIVALENT** with the flag off.

Production effect is **not measured**: the flag is off in prod, and no prod run or probe was made. See EVOLUTION-IMPACT for what is demonstrated and what is still a hypothesis.

## Setup

| Field | Value |
|---|---|
| Machine | MacBook, darwin, node v22.23.2, vitest 4.1 (server workspace) |
| Code | Baseline: `runtime-process.ts` on origin/main `2a0bff5b`. Modified: branch `research/orca-assimilation`, measured twice, flag off and flag on. |
| Fixture | An "agent" node process spawns a grandchild with `stdio: inherit`, so the grandchild holds the agent's stdout pipe. The grandchild installs a no-op SIGTERM handler, then writes its own pid, then lives 8 s (6 s in the pre-change probe). This stands in for an agent CLI's test runner, shell or MCP server that ignores or outlives SIGTERM. |
| Graces | Production values: stop grace 5 s; exit grace 2 s (new, flag on only). |
| Raw data | `evaluation-data.json` (every trial) |
| Probe | A temporary vitest file, deleted after the runs. The committed tests in `runtime-process-group.test.ts` assert the same quantities with shorter graces. |

## Results

### A. `stopRuntimeProcess` (all engine executors' cancel and timeout path), n = 10 per arm

| Arm | Stop resolves (median, range) | Grandchild alive 1 s after the stop | Grandchild alive when the stop resolves |
|---|---|---|---|
| Pre-change code (n = 5, 6 s grandchild) | 6 002 ms (6 002–6 004) | yes | no (it exited by itself) |
| Flag off (8 s grandchild) | **7 998 ms** (7 992–7 999) | **10/10** | 0/10 (it exited by itself) |
| Flag on (8 s grandchild) | **2 004 ms** (2 003–2 005) | 10/10 (inside the grace, by design) | **0/10** |

**Reading.**
- Flag off and pre-change: stop latency equals the descendant's lifetime. It is unbounded for a descendant that never exits.
- Flag on: latency is bounded by the exit grace, not by the descendant. The root dies on SIGTERM, and 2 s later the group is SIGKILLed.
- A root that ignores SIGTERM instead hits the 5 s SIGKILL escalation. That case is covered by the test "stop SIGTERMs then SIGKILLs the whole group" with a 300 ms grace, where elapsed ≥ 250 ms proves the escalation fired.

### B. `RuntimeCommandService.executeRuntimeCommand` with a 1 s timeout (loop runtime path; lease and permit), n = 5 per arm

| Arm | Result finalised (median, range) | Runtime permit still held at 2 s | Grandchild alive at 2 s | `timedOut` |
|---|---|---|---|---|
| Flag off | **8 046 ms** (8 044–8 047) | **5/5** | 5/5 | 5/5 |
| Flag on | **1 004 ms** (1 003–1 004) | **0/5** | **0/5** | 5/5 |

**Reading.** On the legacy path a timed-out lease keeps its `RUNTIME_MAX_CONCURRENCY` permit and its `RuntimeLeaseRegistry` entry for 7 s past its own timeout, which is until the orphan exits. With the flag on, it finalises 4 ms after the timeout.

### C. Regression checks

| Check | Result |
|---|---|
| New suite `runtime-process-group.test.ts` | 14/14 pass. Run 3× during development: no flakes. |
| Mutation check on the new code | 3 of 3 mutants killed: no exit-hook kill → 2 fail; no `detached` → 9 fail; no exit-grace reap → 1 fail |
| Related suites, flag off: 19 files (executors ×9, executor-cancellation, executor-env, loop-runtime-stop, runtime-semaphore, loop-maker-failure-reasons, subscription-executor-permissions, agent-lifecycle-boundary, runtime-admission, remote-maker, new suite) | 207/207 pass |
| Same 19 files with `RUNTIME_PROCESS_GROUP_KILL=on` exported for the whole run | 207/207 pass |
| Full server suite, flag off | 5 637 pass. 2 fail, both unrelated to this change (next two rows). 22 skipped. |
| ↳ `shipped-code-scan.test.ts` "typescript-parser alias" | Also fails on a clean origin/main worktree with the same symlinked node_modules: environmental |
| ↳ `g16-opencode-openai.test.ts` "inspects the canonical environment config" | 30 s timeout under full-suite load. Passes 9/9 in isolation on this branch and on origin/main. It does not use `runtime-process`. |
| `npm run type-check` (server) | clean |
| `npm run lint` (server) | 0 errors. 1 pre-existing warning in `github-pr-review-llm.test.ts`. |
| `node scripts/gen-agent-docs.mjs --check` (after the runbook flag row) | fresh |

## Verdict per hypothesis

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H1a: flag-on stop latency is independent of the descendant's lifetime | **IMPROVED** | A: 2 004 ms against 7 998 ms. The unit test's 30 s grandchild is reaped in under 2 s. |
| H1b: the descendant is dead when the stop resolves | **IMPROVED** | A: 0/10 alive. Every flag-on unit test asserts death. |
| H1c: a timed-out lease releases its permit at the timeout | **IMPROVED** | B: 1 004 ms and 0/5 permits held, against 8 046 ms and 5/5 |
| Equivalence with the flag off | **EQUIVALENT** | Flag-off latencies track the descendant's lifetime exactly as pre-change; spawn args unchanged and no `process.kill` call (test); 207/207 related tests pass |
| Prod effect (fewer stuck leases, less permit starvation, no post-cancel worktree writes) | **INCONCLUSIVE** | Not measured: flag off and no prod probe. How often runtime descendants outlive their CLI in prod is UNKNOWN. |

## Threats to validity

- **Synthetic fixture.** The fixture is a node grandchild. Real CLIs (opencode, claude, codex) may already forward SIGTERM to their own children. This change only matters for descendants that don't get it, or that ignore it. The share of real stops that hit this case is UNKNOWN.
- **Platform.** Measured on darwin. Linux (prod) has the same POSIX group semantics. One prod-specific difference: zombies under node-as-PID-1 still count as group members for `kill(-pgid, 0)`. The design never waits on group emptiness for that reason; completion stays bound to `close`.
- **Self-daemonising descendants.** A descendant that calls `setsid` leaves the group, and this change does not reap it.
