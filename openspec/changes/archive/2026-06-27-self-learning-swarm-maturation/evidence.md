# Evidence — Verified Baseline (on `origin/main` through `450edce`)

All items below were verified live on the workstation with a real codex runtime.

## Green real-runtime swarm
- `proof-1782504558762-6fcd607a` (and successors): runtime codex, status completed,
  `passed: true`, `proof_class: production`, `production_passed: true`,
  `production_missing: []`.
- Worker leases: maker, checker, planner, memory_curator — all completed, all real codex.

## Host isolation (sandbox)
- Worktrees created OUTSIDE the host repo (`/home/djimit/workspace/.djimitflo-loop-worktrees/…`).
- codex `--sandbox workspace-write -c approval_policy=never`: verified a sandboxed codex
  CANNOT write `/home/djimit/workspace/djimitflo/…` ("Read-only file system") but CAN write
  its worktree sentinel.
- Host `tracked-changed: 0` across multiple full real codex swarm runs.

## Parallel specialists
- planner + memory_curator created ~50ms apart; memory_curator completed BEFORE planner →
  overlapping execution windows (concurrent, not sequential).

## Knowledge injection
- Maker `LOOP_WORK.md` contains `## Context (Swarm + Knowledge)` with retrieved OKF
  knowledge + DjimitKBWiki entries + swarm memory.
- Qdrant api-key wired (`context-injection-service`); OKF store has 78 points; djimitkb
  has 36,369 points.

## Learning flywheel (write → retrieve → accumulate)
- Proof A: `djimitflo_swarm` 0 → 1 point (768d, nomic-embed-text), promoted memory
  embedded + upserted with the Qdrant api-key.
- Proof B: `djimitflo_swarm` 1 → 2 points; Proof B's assignment RETRIEVED Proof A's
  memory ("Runtime codex proof run created persisted capabilities…"), score 0.778.

## Efficiency
- `--ignore-user-config`: 325,369 → 87,249 input tokens on the same task (~73% reduction),
  verified live.

## Commits
`883888a` DB guard · `97223b3` build chain · `a3bc140` worktrees outside repo ·
`fdf188a` cwd-boundary alignment · `ca4bb6e` headless approval · `b323007` bounded tasks ·
`a1e3d2b` `--ignore-user-config` + real-runtime budget + honest diff · `48bde6c` ignore
bridged node_modules symlink · `f9d2d4d` concurrent nested specialists · `fa46fb3` sandbox
codex workers · `2f2c9d2` inject swarm memory + OKF knowledge (+ qdrant api-key) ·
`57e4bb7` close the learning flywheel · `8d96ff2` bound flywheel network + revert wiki-md ·
`839f42d` gate flywheel network in tests · `450edce` vitest 30s timeout config.

## Open (not yet fixed — see `tasks.md` Phase 0)
- `proof-run-service.test.ts` bridge tests flaky (timeout) on the workstation; vitest
  30s config on `origin/main` but not yet verified applied (concurrent-edit collision).
- Workstation has uncommitted co-edits to `proof-run-service.test.ts` +
  `memory-candidate-service.ts` blocking deploy.
