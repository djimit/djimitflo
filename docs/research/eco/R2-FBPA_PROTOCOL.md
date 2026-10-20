# R2 — fail-before / pass-after as a shadow deterministic check (pre-registration)

Status: **pre-registered before any code or data** (2026-10-20). Operator approval: 2026-10-20 (experiment R2).
Flag: `FAIL_BEFORE_PASS_AFTER_MODE=off|shadow` (default `off`). Code (after this commit):
`packages/server/src/services/fail-before-pass-after.ts`, evidence section `fail_before_pass_after` in
`/api/health/evolution-evidence`.

## What the check is, and what it is not

- A **shadow** deterministic check named `test:fail-before-pass-after`, recorded in the maker lease's
  `deterministic_checks` like `test:assertion-strength` in shadow: `mode: 'shadow'`, `status: 'skipped'`, the verdict in
  `shadow_status` (`pass` | `fail` | `skipped`), `exit_status: null`.
- **Never a gate.** A `skipped` status passes every gate that reads `deterministic_checks`; the record is additionally left
  out of everything a checker, a second-opinion judge or a PR reader sees (reviewer check summary, checker second-opinion
  state, draft PR body) and out of the proof-run "all checks pass" rule. No enforce mode exists in this experiment.
- In-house, no model. No new mutation engine: the "before" of a test-only change is the graded-fitness seeded mutants
  (`gym-failure-tasks.targetMutants`, the same seeds `recordMakerGraded` uses).
- Runs offline: `npx --no-install vitest run` inside the maker worktree's package (the scripted checks already run there);
  no dependency install, no new host.

## Population

- Maker leases of oracle-lane goals whose proposal carries a `test-gap:` (incl. `#exports`), `mutation-gap:` or
  `finding-fix:` evidence ref, after their deterministic checks **completed** (lease status `completed`, the same entry
  point and condition as graded fitness: the daemon's `grade()` step, first maker and evolve contenders).
- The diff must add or change at least one test file (`*.test|spec.[cm]?[jt]sx?`), all inside one `packages/<pkg>/`.
  Otherwise the check is not recorded (no test change) or recorded `skipped` (multi-package).
- **Unit of analysis: the loop run.** Its latest maker lease that carries the record and is **not superseded**
  (`metadata.superseded_by_maker_lease_id` unset). Superseded evolve losers are excluded.

## Definitions (frozen)

Let T = the changed test files, S = the other changed files in the same package, S_src = the files of S that are not
under a `__tests__/` or `test/` directory (production source). Parent = the worktree's `HEAD` (makers leave their change
uncommitted).

- **FAIL-BEFORE**
  - S_src non-empty (the change edits source, e.g. finding-fix): T run with every file of S_src restored to its parent
    version (files new in the change removed) must **fail**.
  - S_src empty (test-gap / exports / mutation-gap: the target is unchanged): "before" = a seeded mutant of the target.
    FAIL-BEFORE holds when at least one of the ≤ 3 `targetMutants(original, runId, target)` makes T fail. When the lease
    already has a graded `mutant_kill` result (`metadata.graded`, GRADED_FITNESS_MODE=shadow), its `killed ≥ 1` is reused
    instead of re-running. Target: the grounding target if a `services/*.ts` file, else the `mutation-gap:<service>`, else
    `services/<test name>.ts` (as graded fitness and assertion strength do). No target / no mutant → unknown.
- **PASS-AFTER**: T passes with the full change (one vitest run of all of T).
- **PASS_TO_PASS**: E = test files of the package that exist at parent, are not in T, and import (relative specifier) a
  file of S or the target; at most 10, sorted. E run with the change must pass. If it fails, E is re-run at parent (every
  changed file restored, new files removed): parent green → **violated**; parent red too → unknown (pre-existing, not
  attributable). E empty → holds vacuously (`p2p_tests: 0`, reported).
- **Budget**: `GRADED_KILL_BUDGET_MS` (120 s) for the whole check per lease. A timeout makes its component unknown.
- **Verdict** (`shadow_status`): `fail` if any component is measured false; `pass` if all three are true; else `skipped`
  with the reason. Unknown is never counted as pass or fail (E2). The worktree is restored in a `finally`.
- **Arms**: `pass` vs `fail`. `skipped` is excluded from the primary analysis and reported.

## Outcome

- 14-day merge survival of the run's PR (`merge-survival.ts` `loopPrSettlements` / `settlementState`):
  `SETTLED_SURVIVED` = survived, `SETTLED_REGRESSED` = not survived. Open, closed-unmerged, pending and anomaly states are
  not settled (counted descriptively, never in the primary).

## Hypothesis, primary endpoint and decision rule

- **H-R2:** runs whose maker passes the check survive 14 days more often than runs whose maker fails it.
- **Primary:** difference in 14-day survival rate, pass arm − fail arm, in percentage points; two-sided Fisher exact test
  (`evolution-evidence.fisherExact`) on [[pass survived, pass regressed], [fail survived, fail regressed]].
- **Analysis set:** the first **40** settled runs with the check recorded (pass or fail), ordered by `pr_outcome.settled_at`
  then run id. One analysis, on that frozen set.
- **INSUFFICIENT** below 40 settled runs. Before n = 40 only descriptive counts are shown (per arm: runs, settled,
  pending); no rate difference, no p-value, no decision.
- **FALSIFIED** if, at n ≥ 40, the difference is < 10 points or p ≥ 0.05.
- **SUPPORTED** if, at n ≥ 40, the difference is ≥ 10 points and p < 0.05.
- If an arm has 0 settled runs in the analysis set the difference is undefined: reported as INSUFFICIENT (arm empty),
  never as FALSIFIED or SUPPORTED.

## What happens with the result

- Report-only. Neither verdict turns the check into a gate; an enforce mode would need its own protocol and operator
  approval. A FALSIFIED result is recorded as negative evidence.
