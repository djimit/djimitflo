# DI-001 execution value: offline results (run once)

- Pre-registration: `EXECUTION_VALUE_PREREG.md`, sha256 `731b67bbe00e4035855f1fbf608eb819a5bcdbc44d360d6742e2ecc9fc8bbf1e`
  (commit 33f38883). The script checks this sha before it runs.
- Snapshot: prod `djimitflo-live`, read-only, taken 2026-10-13T22:47:48Z. Extractor:
  `packages/server/src/scripts/execution-value-extract.cjs`. The probe was removed from the container and from the VPS
  afterwards.
- Analysis: `npx tsx packages/server/src/scripts/execution-value-offline.ts snapshot.json`. Pure module:
  `packages/server/src/services/execution-value.ts`.
- Nothing in the server imports the module. No scheduler, routing, flag or experiment changed.

## Verdict

| Label | B vs A | C vs A |
|---|---|---|
| Y_merge (primary) | **INSUFFICIENT** | **INSUFFICIENT** |
| Y_oracle (secondary) | **INSUFFICIENT** | **INSUFFICIENT** |

- Y_merge: 23 labelled eval runs and 16 successes, against the pre-registered minimum of 60 labelled runs and 15
  successes.
- Y_oracle: 50 labelled eval runs and 42 successes, also short of 60.
- C would also fail its M3 condition (see below).
- The counterfactual over task selection is **BLOCKED_CAUSAL_IDENTIFICATION**.
- The CIs below are reported, but they decide nothing.

## Population (prereg §2)

- 171 runs, 2026-09-20 → 2026-10-13. All are `doc-drift-and-small-fix-loop`. The repo-maintenance and research runs
  have no goal-linked proposal, and 15 runs were excluded for having no maker lease.
- Attribution: 98 verified, 33 reviewer_failure, 25 environment_failure, 15 maker_failure.
- Tokens: 125.4 M, known on 151 / 171 runs. All eval costs are known, so nothing was imputed.
- t* = 2026-10-07T10:44Z.
  - Fit set: 102 runs. Labelled before t*: Y_merge 29, Y_oracle 40.
  - Eval set: 69 runs, 64.3 M tokens.

## Baseline A (eval, everything that ran)

| Label | Successes / labelled | Successes per M tokens | Negative evidence | NA share |
|---|---|---|---|---|
| Y_merge | 16 / 23 | 0.249 / M | 0.109 / M | 67 % |
| Y_oracle | 42 / 50 | 0.653 / M | 0.124 / M | 28 % |

- Settled regressions: 0, because no eval PR has reached 14 d.
- Median latency of a success: 0.10 h (Y_merge) and 0.16 h (Y_oracle).

## B and C at f = 0.5 (budget 32.2 M of 64.3 M)

| | A (chronological) | B (EV) | C (B + 20 % protected) | 95 % CI B − A | 95 % CI C − A |
|---|---|---|---|---|---|
| Y_merge M1 | 0.000 (0 / 29 runs) | 0.377 (12 / 43) | 0.343 (11 / 40) | [0.153, 0.557] | [0.070, 0.519] |
| Y_oracle M1 | 0.437 (14 / 29) | 0.874 (28 / 43) | 0.747 (24 / 40) | [0.140, 0.641] | [0.064, 0.544] |
| M3 difficult coverage, count (Y_merge) | 0.57 | **0.00** | 0.13 | | |
| M3 difficult coverage, cost (Y_merge) | 0.57 | **0.00** | 0.12 | | |
| M2 first-time (lane, target) successes (Y_oracle) | 12 | 24 | 21 | | |
| M4 negatives per M (Y_oracle) | 0.125 | 0.125 | 0.156 | | |

At f = 0.25 and f = 0.75 the direction is the same. At f = 0.75, B and C select the same set.

## Why the CIs look strong but are not evidence

1. **A's chronological order carries a time trend.**
   - The first half of the eval window has 0 Y_merge successes (34 runs: 0 / 4 / 30 NA). The second half has 16
     (35 runs: 16 / 3 / 16 NA).
   - A at f = 0.5 is exactly that first half, so B − A largely measures time, not ranking.
   - Exploratory, not pre-registered: against A under 2 000 random orders, Y_merge M1 has mean 0.256 and a 95 % band
     of [0.125, 0.375]. B's 0.377 beats 98.5 % of random orders and C beats 92.8 %. For Y_oracle the mean is 0.675 and
     the band [0.498, 0.844]; B beats 98.9 % and C 75.7 %.
   - This is suggestive, but the labelled n is under the pre-registered floor.
2. **The model barely discriminates.**
   - There are 3 distinct p̂ values on Y_merge and 5 on Y_oracle.
   - B reduces to one rule: run test-gap (p̂ 0.89, ĉ 0.68 M) before mutation-gap (p̂ 0.52, ĉ 1.05 M).
3. **The model is miscalibrated under drift.**
   - Y_oracle p̂ for mutation-gap is 0.33, from the fit period. Its realised eval rate is 12 / 16 = 0.75.
   - B would have starved the lane that improved. That is the failure C exists to prevent.
4. **C's protection degenerated.**
   - Almost every task targets a file never seen in the fit period, so *novel* flags 69 / 69 eval runs.
   - The protected pool is therefore the whole eval set, and phase 1 (ranked by sd) spends the whole budget.
   - C still covered only 13 % of the difficult stratum, against A's 57 %. **It fails the pre-registered M3
     non-inferiority**: "never suppress difficult tasks" did not hold.
   - A usable C needs a novelty definition coarser than (lane, target), and a reserve ranked within the difficult
     stratum. That would be a new pre-registration, not a tweak to this one.

## Identifiability (prereg §7)

- **Task selection: BLOCKED_CAUSAL_IDENTIFICATION.**
  - Prod chose deterministically (priority DESC, approvals, lane caps), and no propensity was logged.
  - B and C are a *restricted replay* over the runs that executed. They assume no interference and order invariance.
  - Order invariance is visibly violated: see the time trend above.
- **Maker species (bandit).** All 69 eval `bandit_selected` events could be reconstructed.
  - Propensity: median 1.0, minimum 0.0022.
  - ESS for a uniform target: 1.3.
  - Positivity fails in practice, so even the species dimension is not usable for off-policy evaluation.
- **effort_decision**: shadow, so it acted on nothing and carries no counterfactual.

## Selection bias (M7)

- **Never-run proposals.** Only 3 proposals created in the eval window never ran: all `build` kind, all
  `needs_more_evidence`, priority SMD +0.29 against those that ran. In this lane the gate between proposal and run
  executes nearly everything. The budget is the lever, not task choice.
- **Censoring of Y_merge.** Labels are 67 % NA (open PRs, reviewer and environment failures) and the missingness is
  time-dependent. Later runs have open PRs, while the earlier eval runs are mostly reviewer or environment
  failures.
- **Experiment arms.** The policies change arm composition.
  - A (first half) contains no F2 `checker_family_arm` runs and no ACE-001 or STE-001 runs.
  - B's selection contains F2 cross 23 %, F2 same 23 %, ACE 39 % and STE 12 %.
  - Any ranking policy therefore re-weights the running randomised experiments. Each would need stratification by
    arm before it acts. The experiments were analysed only, never altered.
- **Who B picks.** B selects runs with higher p̂ than the eval pool (SMD +1.03) and drops the low-p̂ stratum
  completely.

## Deviations

- **D1.** A deterministic check with `exit_status: null` is a *skipped* check, per `loop-service.ts` ("script not
  present"). It is ignored for Y_oracle. Prereg §3 did not say how null counts.
- **Exploratory additions** (labelled as such, not used for the verdict):
  - the random-order A comparator;
  - per-cell and per-half counts.

## Next measurement (not built)

The next step is to log a propensity at the task-selection point: which ready proposal ran, out of which ready set,
with what probability. A small randomised order would do, inside the existing lane caps. Without it, no offline EV
scheduler result can become causal. The labelled-n floor needs roughly 3× the current eval window of settled
merges.
