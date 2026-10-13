# TG-001 — explain the gym → production transfer collapse (pre-registration)

Operator directive 2026-10-11. Code: `packages/server/src/services/tg-001.ts`, `remote-gym-service.ts` (claim/record),
`scripts/gym-worker.mjs` (`prompt_override`), evidence section `tg_001` in `evolution-evidence`. Flag `TG_001_MODE=on` (default off).

## Observation that motivates it

The workstation maker (`atomic@llama-router`) succeeds 78.8 % on gym tasks and 7.0 % as a production maker (30 d, CODEX_REPORT).
Gym fitness is therefore not a demonstrated proxy for production capability, and selection on gym fitness cannot show real
capability gains. This experiment tests the first, cheapest explanation before anything else changes.

## Hypotheses

- **H1** — the production assignment representation causes a substantial part of the collapse.
- **H0** — with task, environment and oracle held constant, the assignment representation does not materially change success.
- **Falsifier** — if A (gym goal) and B (production assignment) perform similarly on the same tasks (A–B effect CI includes 0
  and excludes ≥ 20 points), reject representation as the dominant cause and go straight to the harness/environment ablation
  (below). A falsified H1 is a result, not a reason to re-run until significant.

## Arms (same task instance in every arm)

Every task is a failure-derived `write_test` task (#677/#686): a real production test-gap/exports proposal whose maker regressed.
Base commit, target, test file, oracle (vitest green on the real target **and** red on ≥ 1 of the seeded mutants), and production
gates (`GYM_PROD_GATES`: lint / type-check / test:changed / diff limit) are identical across arms. Only the prompt differs.

| Arm | Name | Prompt |
|---|---|---|
| A | MINIMAL_GYM | today's gym goal (`gymGoal(task, true, [])`; `armAGoal` must equal it — tested) |
| B | FULL_PRODUCTION | the failed run's own production `LOOP_WORK.md` (`renderWorkAssignment`, the function `writeWorkAssignment` writes), with production's control context (no ACE-001/STE-001 arm, memory rules + examples as production would select them), flattened with the same `oneLine` a production remote maker job gets (#609) |
| C | CONTROLLED_PRODUCTION | B minus the parts that should not matter for solving: `ids` (Loop run / Runtime target / Finding id lines), `advisory` (Advisory Past Experience block), `policy` (the fixed maker rules template: merge/push/deploy/secrets, npm ci, checker approval). Kept: title, File + scope line, Finding, Evidence, Suggested Fix, Proven Examples, Engineering Rules |
| D | STRUCTURED_MINIMAL | A + only the production finding message and suggested fix (the production information hypothesised to be necessary) |

All four prompts are rendered once at freeze time and stored verbatim (plus sha256 of the flattened text) in the manifest.
Rendering B is read-only: rule sealing and memory-read logging inside `assignmentContext` run in a rolled-back transaction.

## Frozen manifest (`tg_experiments`, written at the first capable claim)

commit (deploy checkout HEAD), species (the first claiming species, e.g. `atomic@llama-router`; other species are not served),
harness = `scripts/gym-worker.mjs@sha256:<hash of the deploy checkout's copy>` (the workstation installs it from origin/main),
evaluator (`WRITE_TEST_ORACLE` + `prodGatesConfig()`), relevant flags (GYM_PROD_GATES, GYM_FAILURE_TASKS_ENABLED,
LOOP_MEMORY_RULES_ENABLED, LOOP_SKILL_CARDS_ENABLED, MEMORY_HOLDOUT_RATE, LOOP_DAEMON_CHECK_SCRIPTS,
EVOLUTION_GYM_REMOTE_MAX_PER_DAY, GYM_MAKER_TIMEOUT_MS), seed `11102026`, the task list (key, lane, source run, base, source,
target, prior gym attempts) and the four prompts per task. The worker records the model id the router actually serves per attempt.

Not frozen by the server (recorded per attempt instead): the router's loaded model, atomic-agent version (fixed in the runner
image `djimitflo-gym-runner:atomic-0.6.5`).

## Task set

20 failure-derived `write_test` tasks, stratified by lane in proportion to availability (prod 11-10: 26 available, exports 19 /
test-gap 7 → ~15 / ~5), never a frozen holdout key, tasks no species has tried first (their arm-A rate is unknown), then a seeded
order. Tasks whose production run or finding no longer exists are skipped (listed in `manifest.skipped`). Fewer than 10
renderable tasks → nothing is frozen. Frozen tasks are reserved: never served as ordinary gym work afterwards.

Note: 24 of the 26 available tasks already have earlier gym attempts (arm-A-like, 19 success / 6 failure / 4 discards); those
attempts are **not** data for this experiment (different time, no paired design) — `prior_gym_attempts` is recorded only.

## Execution

- Latin square: seeded task order; task *i* runs the seeded base arm order rotated by *i*, so each arm takes each position equally
  often (20 tasks → each arm 5× in each position). No arm systematically runs first.
- Served before ordinary gym work while `TG_001_MODE=on`, inside the existing remote gym daily cap (20/day).
  80 attempts ≈ 4 days. TG attempts earn no gym skill outcome (they are not gym fitness).
- Infra discards re-queue the attempt (≤ 2 retries; every attempt kept in `history_json`); a task discard (`task:` reason, e.g.
  test already green at base) makes the attempt invalid and drops its pairs.

## Measurements per attempt

success/failure, failure category, tokens (only if the agent prints a total — atomic-agent normally does not → null), wall-clock
duration, maker duration, tool calls / failed tool calls (**not available** from atomic-agent output → null, never 0), files
modified (git), files inspected (**not observable** → null), retries (0: one maker run per attempt), context size (prompt chars),
model actually served by the router, termination (`exit:<code>` / `timeout` / `error`), oracle result, production-gate results.

Failure categories (deterministic, `classifyTgFailure`): TIMEOUT (termination timeout), INFRASTRUCTURE_FAILURE (`infra:`),
EVALUATOR_FAILURE (`task:` discard), CONTEXT_FAILURE (out-of-scope files), IMPLEMENTATION_FAILURE (`prod_gate_failed:`),
TEST_FAILURE (oracle red / no mutant killed / test gaps), TOOL_FAILURE (failed tool calls and no diff — only if counts exist),
UNDERSTANDING_FAILURE (clean exit within 60 s and no change — the #609 "Ready. What would you like me to do?" pattern),
UNKNOWN otherwise. PLANNING_FAILURE has no defensible signal yet and is never assigned.

## Analysis (pre-registered)

- **Primary:** A vs B on tasks with a scored result in both arms. Report the paired table (both pass / A only / B only / both
  fail), discordant pairs, absolute effect (A − B success) with 95 % CI (Tango score interval — paired Wald until the B27 pre-data fix), exact two-sided McNemar p, n pairs.
- **Secondary (decomposition):** C vs B (does removing ids/advisory/policy recover success?), D vs B (does a structured minimal
  prompt with the production finding beat B?). Exploratory, no multiplicity claim.
- Percentages are never reported without n and CI.

## Stopping rule

Start with 20 tasks (≈ 80 attempts). Extend to 40 tasks (a second frozen set, never the same tasks again) **only** if the A–B CI
spans both 0 and a 20-point effect. No other extension; no re-testing until significant.

## Power (rough)

With 20 pairs and a true effect of ~45 points (e.g. A 75 % vs B 30 % with typical concordance), expected discordant pairs ≈ 10 vs 1
→ exact McNemar p ≈ 0.01. An effect under ~20 points will be inconclusive at n = 20 (hence the stopping rule).

## Next experiment if H1 is falsified (environment ablation, one dimension at a time)

Same task + same prompt, then vary: max steps (gym worker `--max-steps 40` vs production maker job `--max-steps 60` — a known
harness difference), time budget, production checker + reviewer path vs gym oracle, worktree state, memory/knowledge context.

## Implications (to fill in after the result)

What the gym measures; which fitness signals can support selection; the minimal code change (only after the cause is known);
the next falsifiable experiment. Until then gym fitness must not drive promotion (genome trials stay off).

## Integrity addendum (pre-data, 2026-10-11)

Written before any TG-001 outcome exists (the gym worker that can take TG attempts was not installed yet). Arms and prompts are
unchanged; this fixes the analysis.

- **Experimental unit:** `(task_id, arm)`. Task is the block; TG-001 is a paired randomized block/crossover design, never 80
  independent samples. Every physical attempt is kept in `tg_attempts.history_json`; retries collapse into one observation, the
  first non-infra result. If every permitted attempt (1 + 2 retries) is an infra discard → **INFRA_CENSORED**: neither success nor
  failure, reported per arm, excluded from paired tables (excluded tasks counted per comparison). A task discard is **INVALID**.
- **Frozen analysis manifest** (`manifest.analysis`, stored with its sha256 in `tg_experiments.analysis_sha256` in the freeze
  transaction): experiment id, commit, worker version (gym-worker hash), task ids, task fingerprints, prompt fingerprints, seed,
  condition order, retry and exclusion policy, scoring gates, primary and secondary comparisons, tests, minimum practically
  relevant effect, interpretation rules, prior exposure per task. The evidence section refuses analysis
  (`status: invalid_manifest`) when the plan is missing, its fingerprint no longer matches, or it is dated after the first outcome.
- **Primary:** A (MINIMAL_GYM) vs B (FULL_PRODUCTION): discordant pairs, exact two-sided McNemar, absolute paired difference A − B
  with 95 % CI, n. **Minimum practically relevant effect: 20 points.** α = 0.05.
- **Secondary:** Cochran's Q over the four arms on complete blocks (chi-square approximation, df = 3 — not the exact permutation
  distribution; descriptive at ~20 blocks), then only the predeclared contrasts C vs B and D vs B. No other pairwise tests.
- **Prior exposure:** per task `prior_exposure`, `prior_attempt_count`, `prior_condition_if_known` (ordinary gym attempts ran
  the arm-A goal). Earlier attempts are never observations. Because most tasks were seen under A, TG-001 is **diagnostic evidence
  about prompt sensitivity under the gym harness — not a generalization benchmark and not a promotion holdout**; TG task keys are
  excluded from every holdout freeze.
- **Step budget:** every arm runs the gym's 40 steps. TG-001 estimates the effect of assignment representation *conditional on
  the gym harness*, not the full gym → production causal effect (production remote makers run 60 steps).
- **Telemetry:** tool calls, files opened and tokens are stored as null when the agent does not report them and shown as
  UNKNOWN, never 0. TOOL_FAILURE requires observed failed tool calls; otherwise UNKNOWN_FAILURE.
- **Order effects:** success by execution position (1–4) and Cochran's Q over positions, reported descriptively.
- **Interpretation (frozen):** A − B ≥ 20 pt with p < 0.05 → representation supported → prompt-component ablation (C vs B,
  D vs B) before any gym redesign. Upper 95 % bound of A − B < 20 pt → representation rejected as the dominant explanation within
  this environment → next: 40 vs 60 max-steps with task, prompt, model, worker, runtime and evaluator fixed. Otherwise
  inconclusive → extend to 40 tasks. The evidence reports what TG-001 falsified, supported, did not test, and the next experiment.
- **No evolutionary fitness change based on TG-001 alone.**

## Pre-run integrity (2026-10-11, B27 — pre-data, before the first physical attempt)

- **Interval defect fixed:** the paired Wald interval collapsed to [0, 0] at zero discordance and was anti-conservative for small
  one-sided counts (b = 4, c = 0, n = 40 gave upper 0.193 → REJECTED although A won 4 tasks and B none). Replaced by the Tango
  (1998) score interval, which like the exact McNemar test depends only on (b, c, n). The MDE (20 pt), α (0.05), the three rules
  and the extension rule are unchanged. The verdict is computed on unrounded values. Full enumeration:
  `TG-001_DECISION_SURFACE.md`.
- **Plan before the first physical attempt:** a claim records `tg_attempts.first_claimed_at`; the analysis is invalid unless the
  plan's `frozen_at` is strictly earlier than the first claim or result. The claim that freezes the plan starts no TG attempt.
- **Isolation by provenance:** TG attempts run as `loop_runs.loop_name = 'tg-001'`, never `'evolution-gym'`, so no gym statistic,
  circuit breaker, IRT/difficulty fit, hack rate, graded pool, trial deciding set or estimator can count them; no skill outcome;
  no copy in `gym_attempt_diffs` (the diff's sha256 stays on the TG run); no effort events. A run whose report is lost settles
  its TG attempt as an infra discard (re-queued ≤ 2×, then INFRA_CENSORED) instead of leaving it `claimed`.
- **Censoring** is reported by arm × execution position (`censoring`, `order_effects.positions[].infra_censored`).
- **Frozen in the analysis plan as well:** `ci_method`, `classifier_version` (`tg-classifier-v2`), `step_budget` (40).
- **Go-checklist:** `tgGoChecklist(db, { commit, build_id, worker_sha256 })` records experiment id, commits, build id, worker
  hash, analysis / task-set / per-arm prompt fingerprints, seed, gate version, classifier version, retry policy, step budget,
  model/router, flags and timestamp, and checks frozen, analysis valid, plan predates the first attempt, worker hash and deploy
  commit equal the manifest's.
- **Known, not changed (operator rule):** INCONCLUSIVE at 20 tasks extends to 40 and re-applies α = 0.05 — two looks, so the
  overall false-SUPPORTED rate is above 0.05 (Bonferroni bound 0.10). Reported, not corrected, because the stopping rule is
  pre-registered by the operator.
