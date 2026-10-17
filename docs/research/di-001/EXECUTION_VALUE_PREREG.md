# DI-001 execution value: offline challenger pre-registration

Status: **frozen before any per-feature outcome, model fit or policy metric is computed.**
The sha256 of this file is quoted in the commit message of the results commit. The analysis script refuses to run
against any other version (`EXECUTION_VALUE_PREREG_SHA256` in `packages/server/src/scripts/execution-value-offline.ts`).
This is offline only. No scheduler, routing, flag or prod-write change follows from this document, whatever the result.

## 0. Question

The capability matrix (2026-10-14, 30 d) found that 57.6 % of goal-linked lease tokens went to runs that never verified,
and 46.1 M tokens went to failed maker leases. Challenger: schedule by expected execution value

    EV(run) = P(success | lane, kind, target dir, history) · V − λ · E[cost]

with uncertainty. Would that have produced more independently verified work per token than what actually ran, without
starving difficult or novel work?

- **A** (existing): what actually ran, in the order it ran.
- **B** (cost-aware): the highest-EV runs first, under the same token budget.
- **C** (B with protected exploration): B, but at least X = 20 % of the budget is spent first on protected runs
  (uncertain, difficult or novel). Protected runs are ranked by uncertainty, never by predicted success, so a
  difficult task is never dropped just because its predicted success is low.

## 1. Disclosure of prior data contact

Before this was written, the author had seen:

- the aggregate figures in the capability matrix: 38 merged loop PRs in 30 d, 2 settled survived, attribution counts
  34 verified / 33 reviewer_failure / 23 environment_failure / 12 maker_failure, 282 bandit_selected and
  110 effort_decision events, and the token totals;
- one schema probe: table DDLs, row counts, loop_name × status counts, event-type counts, and one raw row of the newest
  loop run and of the newest proposal.

No outcome rate was computed by lane, kind, file, species or time, and no model was fitted. This contact can bias the
choice of population (doc-drift dominates), but it cannot bias the model, the split or the thresholds below.

## 2. Population and unit

- **Unit**: one loop run, meaning one execution attempt. Its task is the proposal `goals.improvement_id`.
- **Included**: runs with `loop_name` in {`doc-drift-and-small-fix-loop`, `repo-maintenance-loop`, `research-loop`}
  that have a goal with a non-null `improvement_id` and at least one `maker` worker lease, and that are in a terminal
  status (completed, failed, blocked, ready_for_human_merge, escalated, cancelled, interrupted).
- **Excluded**:
  - pull-request review runs, where the maker is the PR itself (a gate's evidence names "pull-request review");
  - `evolution-gym`, `tg-001` and `legacy-evidence-recovery` runs, which are R&D or recovery, not the task path;
  - runs that are still created, planning, running or verifying.
- **Snapshot**: one read-only extraction from prod `djimitflo-live` (`{readonly:true}`) at time T_snap. Everything
  observable after T_snap is censored.

## 3. Labels (independent of any controller; never an EV input)

Attribution class = `attributeOutcome()` (#707, unchanged), computed from the stored run, its leases and annotations.

**Y_merge (primary).** This is human merge plus CI, with merge survival where it has settled.
- y = 1: `pr_outcome.state = merged` and `survived` is not false.
- y = 0: any of
  - `survived = false` (settled regressed);
  - closed unmerged, unless `not_scored = stale_loop`;
  - attribution `maker_failure` with no merged PR.
- NA (not a failure, excluded from success and failure counts, but its cost is still spent):
  - attribution `reviewer_failure` or `environment_failure` with no merged PR;
  - PR still open;
  - verified without a PR;
  - anything else.

**Y_oracle (secondary).** This is the executed deterministic oracle on the active maker lease, with no LLM reviewer in
the label.
- y = 1: maker completed, `changed_files` is non-empty, at least one deterministic check, and every check has
  exit_status 0.
- y = 0: `changed_files` is non-empty and either some check exited with a status other than 0 or 127, or the maker
  ended non-completed after changing files.
- NA:
  - attribution `environment_failure` (no change, infra, a missing tool with exit 127, never ran);
  - no checks recorded;
  - anything else.
- A checker rejection does not make Y_oracle = 0.

**Label time** (when a label became observable):
- Y_merge: `merged_at`, else `settled_at`, else `checked_at` for closed PRs, else the run's completion time for a
  maker_failure.
- Y_oracle: the run's completion time (`completed_at`, else `updated_at`).

**Cost** c = Σ `worker_leases.metadata.runtime_usage.total_tokens` over all leases of the run (maker, checker,
security_checker), in M tokens. If no lease of the run reports tokens, the cost is *unknown*. For budget accounting it
is imputed with the model's expected cost and flagged. Sensitivity analysis: unknown-cost runs are excluded.

**Latency** = completion time − `created_at`, in hours. This is descriptive only. Reordering cannot be shown to change
it (see §7).

## 4. Temporal split (no look-ahead)

1. Sort the included runs by `created_at` (ties broken by id).
2. The cutoff t* is the `created_at` of the run at index ⌊0.6·N⌋.
3. **Fit set**: runs created before t* whose label time is also before t*. A fit-period run whose label only became
   observable after t* is NA for fitting.
4. **Eval set**: runs created at or after t*.

The model is fitted once, on the fit set, per label. Eval labels and eval realised costs never enter `fitEvModel()`.
This is enforced by the function signature (the fit takes labelled rows filtered by label time < t*) and by a test:
permuting eval labels and costs leaves every prediction and every B and C ranking unchanged.

## 5. EV model (deterministic, no randomness)

**Features.** All features are known before the run starts.
- lane = `loop_name`.
- kind = prefix before ':' of the proposal's first `evidence_refs_json` entry, else the proposal `type`.
- dir = first 3 path segments of the target. The target is `grounding_json.target`, else `findings_json[0].file`,
  else 'unknown'.

**Hierarchy.** Beta-binomial shrinkage with pseudo-count m = 4 at each level:

    global → lane → lane|kind → lane|kind|dir
    p_level = (k + m·p_parent) / (n + m)

- The global prior is the fit-set success rate, with a Beta(1,1) fallback.
- p̂ is p at the deepest level.
- Uncertainty is sd = sqrt(p̂(1−p̂) / (n_deepest + m + 1)).
- n_cell is the fit count at the deepest non-empty level.

**Expected cost.** ĉ is the cell-mean realised cost (fit runs with known cost), using the same hierarchy with m = 4 on
means.

**EV.** EV = p̂·V − λ·ĉ.
- V = 1.
- λ = fit successes / fit M tokens, with known-cost fit runs as the denominator, per label. λ is therefore the
  break-even rate of the average past run.

**Ranking.** B sorts by EV descending. Ties are broken by `created_at` ascending, then by id.

## 6. Policies under a budget

The budget is Bud = f · (Σ realised cost of the eval set), with unknown costs imputed.
- Primary: f = 0.5.
- Secondary: f = 0.25 and f = 0.75.
- At f = 1 every policy selects everything, so f = 1 is not a test.

The evaluator walks an ordering. It includes a run if cumulative cost + c ≤ Bud, otherwise skips it and continues.
Realised cost is used only by the evaluator, never by the ranking.

- **A**: chronological order (`created_at`).
- **B**: EV order.
- **C**:
  - Protected pool P = eval runs that are any of:
    - *novel*: n_cell at lane|kind|dir is 0, or the (lane, target) pair has no fit-period run;
    - *uncertain*: sd ≥ the eval median sd;
    - *difficult*: p̂ is in the bottom tercile of eval p̂.
  - Phase 1 walks P by sd descending (ties: `created_at`) under a sub-budget of X·Bud, with X = 0.2.
  - Phase 2 walks all remaining runs by EV under the remaining budget.
  - **Invariant**: protected spend ≥ X·Bud − max cost of a protected run, unless every protected run fits. There is a
    test for this.

The difficult stratum for M3 is the same as P's *difficult* criterion: bottom tercile of eval p̂.

## 7. Identifiability

- **Task selection (which proposal runs, and when)** was deterministic in prod: `ORDER BY priority DESC` in
  `self-improvement-service.ts`, plus approvals and lane caps. No propensity was logged for that decision. A
  counterfactual where B or C picks tasks that never ran, or uses a larger budget, therefore has no support:
  **BLOCKED_CAUSAL_IDENTIFICATION**.
- **What is estimable.** The *restricted replay* is estimable: which subset of the runs that actually executed a policy
  would choose under a budget below what was spent. Each candidate's outcome is observed. This estimate rests on two
  stated, untestable assumptions:
  - no interference between runs;
  - order invariance, meaning a run's outcome does not depend on when it ran.

  It answers "would ranking have concentrated the same token spend on the runs that succeeded". It does not answer
  "what would B have achieved in prod".
- **Maker species** (the bandit) has logged propensities (`bandit_selected` posterior → `propensities()`, RX-15). That
  identifies the species dimension only. It is reported as a diagnostic (propensity range, ESS of a uniform target) and
  is not used for B or C.
- **effort_decision** events are shadow. They acted on nothing, so they carry no counterfactual. X1, F2, ACE-001,
  STE-001 and the memory holdout are randomised experiments on other decisions. They are analysed as arm membership
  (selection bias, §8 M7) and never altered.

## 8. Metrics

Each metric is computed per policy, per label and per f.

| ID | Metric |
|---|---|
| M1 (primary) | Successes per M tokens = Σ y(selected, y = 1) / Σ c(selected). |
| M2 | New-capability discovery: selected runs with y = 1 whose (lane, target) pair has no fit-period run; also the distinct first-time lane\|kind cells and first-time targets executed. |
| M3 | Difficult-task coverage: selected / total for the difficult stratum, by count and by cost share. |
| M4 | Negative-evidence yield: selected runs with y = 0, per M tokens. |
| M5 | Regression rate: settled survived = false among selected merged runs; Y_oracle failure share among labelled selected runs. |
| M6 | Latency: median latency of selected y = 1 runs (descriptive). |
| M7 | Selection bias: (a) NA share of selected runs; (b) standardised mean difference (SMD) of p̂, ĉ and novelty between the selected set and the eval pool; (c) proposals created in the eval window that never ran, against those that ran (count, kind mix, priority SMD); (d) share of eval runs inside randomised experiment arms (X1 `effort_arm`, F2 `checker_family_arm`, ACE / memory-holdout `assignment_context`) by policy. |

**CI.**
- 2 000 bootstrap resamples of the eval set, seeded (seed 7).
- Each resample re-runs A, B and C under that resample's budget. The model stays fixed: it was fitted on the fit set.
- The 95 % percentile CI is reported for M1(B) − M1(A) and M1(C) − M1(A).

## 9. Decision rules (fixed now)

Per label at f = 0.5:

| Verdict | Condition |
|---|---|
| **INSUFFICIENT** | Eval labelled runs < 60, or eval successes < 15. |
| **INCONCLUSIVE** | The CI of the difference contains 0. |
| **SUPPORTED_OFFLINE** (B or C) | CI lower bound > 0. C additionally needs M3(C) ≥ M3(A) by count. |
| **NOT_SUPPORTED** | CI upper bound < 0. |

The verdict is the Y_merge verdict. Y_oracle is reported beside it and cannot rescue Y_merge.

The expected outcome, given about 38 merged PRs in 30 d, is **INSUFFICIENT on Y_merge** and probably INCONCLUSIVE on
Y_oracle. Even SUPPORTED_OFFLINE would only justify a pre-registered *shadow* test with logged propensities over task
selection. It would not justify a scheduler change.

## 10. Deviations

Any deviation from this document is listed in the results file with its reason. The analysis is run once per snapshot.
