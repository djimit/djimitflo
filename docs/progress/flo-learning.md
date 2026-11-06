# Progress: Levering 1 — from a recurring failure to a reusable skill (L1)

Status: **M1 built** (`scripts/skills/oracle-gate.mjs`, not wired into any maker). M2–M8 open. Baseline: origin/main
**0b7b801d** (prod `/health` on the same sha, 2026-11-06). Raw prod rows, transcripts and maker diffs stay in the
operator evidence dir; this file carries only counts and decisions.

## Decisions

| Item | Decision |
|---|---|
| Chosen failure | Mutation-gap lane, opencode maker, attributed "maker failed after changing files": 13/18 mutation runs since 10-31. In 12 of those 13 the maker was stopped by the token brake (`OPENCODE_MAX_RUN_TOKENS`, 1 M counted tokens). |
| Why this one | The brake stops makers **after** their work already passes the lane oracle: 7 of the 13 decidable brake-killed diffs pass `test:mutation:grounded`, and 5 of those makers had seen `"pass":true` themselves (step 20–23) before re-running checks the daemon runs anyway. About 69 % of the budget goes to environment discovery before the first edit; the brake counts cache reads (median fresh 86 k of 1.03 M counted). A killed maker's diff is never checked (`deterministic_checks: []`). Highest frequency × value lost, and the oracle is already executed, not an LLM. |
| Repair | An executable stop rule the maker runs in one call: `oracle-gate` runs the goal's declared acceptance command, then `LOOP_DAEMON_CHECK_SCRIPTS` (default `test:changed,lint,type-check`), and prints one `ORACLE_GATE {…}` line plus `PASS → stop working, report done` or `FAIL: <check> → fix only that`. `--doctor` lists configs and deps and installs nothing. |
| Oracle | Exit codes of the daemon's own scripts; for the mutation lane `scripts/mutation-gain.mjs` `pass:true` (gain ≥ 10 or ≥ 90). No LLM or jev score (NE-001). |
| Second task | A test-gap `#exports` task: oracle command `npx vitest run src/__tests__/X.exports.test.ts` from `packages/server` instead of `mutation-gain`, artifact = a new test file instead of a strengthened one, a different module. Runtime stays opencode (the only runtime whose transcript shows an invocation). |
| NE-013 | The gate never echoes child output. Of a mutation run it keeps only the score (`status`, `before`, `after`, `gain`): no mutant list, mutator, replacement, location or diff, on PASS or FAIL. A test feeds Stryker-shaped leaks through the gate and asserts none reach the output. No retry path is added; the lane's existing proposal text is unchanged. |
| NE-016 | Not ts-build-error-repair-v1 and not static procedure lines: an executable command whose invocation can be observed, on fresh tasks, under its own pre-registration (below). |
| NE-002 / EXP-3 | No credit for delivery or reads. "Helped" only from a holdout contrast (M4). |
| Timing | No `OPENCODE_MAX_RUN_TOKENS` change before 12-16 (MAKER-DEPS-001 treatment env). Live use only after ACE-001 / STE-001 stop (11-15) with an M8 boundary row, or earlier only as its own randomised arm declared in the experiment registry. |

## Pre-registered success levels

| Level | Test | Pass |
|---|---|---|
| 1. Created | M1 replay: gate verdict vs lane oracle on stored diffs | all decidable cases agree — **met** (23/23 mutation, 5/5 exports) |
| 2. Selected + delivered | first mutation goal and first exports goal in the treatment arm | event with digest + sha on both |
| 3. Invoked | transcript scan | ≥ 1 applied on a mutation task and ≥ 1 on an exports task |
| 4. Verified | daemon checks exit 0, lease completed, run verified | both tasks of level 3 |
| 5. Credited | `skill_outcomes.capability_id` only on level-4 runs | 0 credits without invocation |
| 6. Helped (later) | holdout contrast, mutation lane: completed-without-brake share (baseline 2/19 since 10-31) | Fisher one-sided, ~20 per arm; exports arm non-inferior |

## Done

- **M1 skill** `scripts/skills/oracle-gate.mjs` + `oracle-gate.test.mjs` (12 tests, in the root `npm test` chain).
  Machine line `ORACLE_GATE {"pass":…,"checks":[{name,exit,ms}],"digest":"sha256:<hex>"}`, exits 0/1/2, unknown flag 2,
  only test/lint/type-check commands allowed (no install, push or arbitrary command), `--doctor` read-only.
- **Replay harness** `scripts/skills/oracle-gate-replay.mjs` (operator, offline; dry run unless `--apply`) +
  `oracle-gate-replay.test.mjs` (5 tests). Per stored maker diff: throwaway worktree at the last origin/main commit
  before the lease's `created_at` (approximation: the real base is not stored), node_modules linked from the installed
  checkout whose lockfile is closest to the base (remaining version differences recorded per row), diff applied, gate run
  with `test:changed,lint,type-check` (timeout 600 s each), worktree removed. No diff is written to its output.
- **Replay result (2026-11-06, gate digest `sha256:e8488417…`)**, 29 stored diffs from prod lease metadata:

  | Lane | Cases | Reference | Agreement |
  |---|---|---|---|
  | mutation-gap (24 diffs since 10-31: 16 failed opencode makers — 14 brake, 1 wall timeout, 1 `test:changed` timeout — 2 completed opencode, 6 remote) | 24 | the earlier lane-oracle replay (`mutation-gain`), or prod's recorded oracle exit | **23/23** decidable; 1 undecidable (`baseline_unavailable`, the oracle never ran in prod) |
  | test-gap `#exports` (5 diffs: 2 that prod failed on `test:changed`, 3 completed) | 5 | prod's recorded daemon checks | **5/5** |

  Failed opencode mutation makers whose diff passes the acceptance command: **9 of 16**; of those, **8 pass the full gate**
  (acceptance + `test:changed` + `lint` + `type-check`): work thrown away by the token brake. The 9th (the one stopped by a
  `test:changed` timeout in prod) fails `test:changed` here too.
- **Second, non-identical task**: the same script decides the exports lane with no change to it. What changed: lane
  (mutation-gap → test-gap/exports), oracle command (`npm run test:mutation:grounded` with `MUTATE_*` env from the repo
  root → `npx vitest run src/__tests__/X.exports.test.ts` from `packages/server`), artifact (a strengthened existing test
  → a new test file), target module (5 different services). The 2 FAILs are real assertion failures in the new test
  file (checked by hand), matching prod's `test:changed` exit 1.
- `scripts/host-scripts-dry-run.test.mjs` scans `.sh` files only, so neither new `.mjs` script needs a listing; both
  follow its convention anyway (the harness is a dry run by default, an unknown flag exits 2).

## Open dependencies

| # | Connection | Where |
|---|---|---|
| M2 | Register `skill:oracle-gate@1` as a validated capability with `artifact_digest` = sha256 of the script at the merge sha | #1168 (`feat/skill-route-credit`) |
| M3 | Select by lane (`cap.lanes ∩ aceLane(goal)`), not by file | same PR |
| M4 | Delivery receipt (digest, block and assignment sha) and a deterministic per-goal 50 % holdout | same PR |
| M5 | Transcript scan for a bash `tool_use` running the script, plus the worktree digest check | same PR |
| M6 | The daemon's check exit codes stored with the capability id; lease `completed`, not brake-killed or rescued | same PR |
| M7 | Credit only when invoked ∧ checks pass ∧ verified; new credit kind `capability`; no `capability_id` for shown-only | same PR |
| M8 | Boundary row when a capability is validated or deprecated; register L1-OG-001 | same PR |
| — | `swarm_tasks` foreign-key fix | its own PR |

## Next action

Merge M1. Then M2–M8 behind a default-off flag; switch on only per the timing rule above, and check level 2 on the
first mutation and the first exports goal of the treatment arm.
