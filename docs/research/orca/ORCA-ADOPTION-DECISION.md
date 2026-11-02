# Orca adoption decision

**Executive verdict.** Do not adopt Orca: not as a dependency, not as a runtime, and not as an IDE. DjimitFlo stays the control plane. About 90 % of Orca's code serves interactive, human-steered PTY sessions (attach and scrollback, terminal-title heuristics, trust-dialog pre-writes, mobile pairing, SSH push). DjimitFlo has superseded that model with headless one-shot leases, a pull-only fleet and evidence gates.

One Orca mechanism addresses a **verified** DjimitFlo defect: process-group termination of runtime trees (`src/packages/process-host`). It is adapted, not copied, behind a default-off flag: **ADAPT_ORCA_PATTERN, implemented (ORCA-PG)**. Two more patterns are worth a later bounded change. Everything else is REUSE_EXISTING or REJECT.

## Rubric

Each candidate is scored on:
- **benefit**, **complexity**, **integration cost**, **maintenance**, **failure risk**: H (high), M (medium), L (low)
- **testability**: Y = deterministic local test possible
- **reversibility**: F = flag, R = revert-only

| # | Candidate (Orca source) | DjimitFlo status | Benefit | Cplx | Integr. | Maint. | Fail risk | Test | Rev. | Decision |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | Process-group termination: detached spawn, `kill(-pgid)`, SIGKILL escalation, exit-grace reap (`process-host/src/process-tree-termination.ts`, `run-process.ts`) | **BROKEN**, measured | **H**: a stopped or timed-out lease frees its permit at the deadline instead of whenever an orphan exits; a cancelled maker's tool child can no longer keep writing to the worktree | L: about 70 LOC in one module | L: one call-site swap per executor | L | M (detached loses terminal SIGINT; mitigated by an exit hook; group kill hits only groups we created) | Y | F | **ADAPT_ORCA_PATTERN, done** |
| C2 | Look up an existing PR instead of failing on "already exists" (`github/client/create/create-github-pull-request.ts`) | EXISTS_UNVERIFIED gap (`loop-draft-pr-service.ts:108-114`) | M: only matters after an ambiguous earlier create; frequency UNKNOWN | L | L | L | L | Y | F | **ENHANCE_EXISTING, next candidate** (needs a prod count of `draft_pr_failed` with `GitHub 422` first) |
| C3 | Positive-proof orphan worktree deletion and reuse validation (`worktree-removal-safety.ts`, `worktree-orphan-gitdir-proof.ts`) | PARTIAL (`worktree-manager.ts:36-38`, `155-221`) | M: prevents deleting or reusing a directory we can't prove is ours; no incident documented | M | M (the loop path is shared with ASG-001's executor) | L | M | Y | F | **EXPERIMENT later**: write the gap test first; coordinate with ASG-001 |
| C4 | Transcript-JSONL usage parse with a session-free dedupe key and one owner file per key (`claude-usage/scanner.ts`, `codex-usage/*`) | PARTIAL (L6 14) | M once claude/codex makers run again; L today (idle or broken per L3-v2 §3a) | M | M | M (CLI transcript formats drift) | M | Y | F | **EXPERIMENT**, gated on claude/codex makers carrying volume |
| C5 | Fail-open version floors per major (`agent-cli-version-probe.ts`) | EXISTS (`runtime-admission.ts`, stricter) | L | L | L | L | L | Y | F | **REUSE_EXISTING** |
| C6 | Durable write: fsync, rename, dir fsync (`durable-file-write.ts`) | SQLite is the authority; files are evidence only | L | L | L | L | L | Y | R | **REUSE_EXISTING** |
| C7 | Spawn admission token bucket (`host-spawn-admission.ts`) | EXISTS (semaphore + daily caps) | L | M | M | M | M | Y | F | **REUSE_EXISTING** |
| C8 | SSH reconnect ladder, liveness with timer-lateness re-probe | SUPERSEDED (pull model, operator rule 2026-09-29) | — | H | H | H | H | — | — | **REJECT** |
| C9 | PTY daemon, scrollback, attach/detach | SUPERSEDED (headless) | — | H | H | H | H | — | — | **REJECT** |
| C10 | Hook-based turn status and trust pre-writes | SUPERSEDED (exit code + structured output) | L | H | H | H | M | — | — | **REJECT** |
| C11 | Browser (CDP) and computer use | MISSING, no demand | L | H | H | H | **H** (trust surface) | — | — | **REJECT** (revisit only with a lane that needs it) |
| C12 | Issue-linked workspaces, rrule automations | SUPERSEDED (goals/loops/schedulers) | L | M | H | M | M | — | — | **REJECT** |
| C13 | Three-point redaction (sink, bundle, ingest) | PARTIAL (secret redaction at PR body and evidence) | L to M | L | M | L | L | Y | F | **REUSE_EXISTING**; note for the L6-06 observability work |

## Why C1 and not another candidate

The task allowed one change, and it had to meet five criteria:
1. **Verified deficiency.** Reproduced locally on unmodified `2a0bff5b` code. Stop resolved after the grandchild's own lifetime (6 002 ms for a 6 s grandchild), and the grandchild was alive 1 s after the stop (`evaluation-data.json`, `pre_change`).
2. **Falsifiable hypothesis.** Stated in IMPLEMENTATION-PLAN.
3. **Measurable baseline.** Stop latency, descendant survival and permit hold, each n ≥ 5.
4. **Clear integration point.** `execution/executors/runtime-process.ts`, the single stop path every executor already uses, plus the spawn line at each call site.
5. **Rollback.** Unset `RUNTIME_PROCESS_GROUP_KILL`. With the flag off the spawn options are byte-identical (tested).

How the other candidates fall short:
- C2 has no verified occurrence.
- C3's integration point overlaps the loop worker executor that ASG-001 owns.
- C4's consumer is idle.

## Boundaries respected

- No Orca code or dependency was added.
- No change to `assignment-context.ts`, the skill model, `loop-worker-executor-service.ts`, `gym-worker.mjs`, `tg-001.ts` or `remote-gym-service.ts`.
- No prod flag, credential, deploy or experiment change. The new flag is default-off and documented in the runbook flag table.
