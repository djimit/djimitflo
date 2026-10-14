# DI-001 committee evaluation: what the 15/21 vs 20/48 signal is

**Bottom line.** The prior audit's raw count reproduces exactly: committee `yes` → 15/21 `verified`, `no` → 20/48. But it
is **not evidence that the committee predicts change quality**, for three reasons:

1. 49 of 69 forecasts were written *after* the outcome.
2. The label it predicts is mostly runtime and reviewer failures, not oracle failures.
3. Under the pre-registered independent label, both groups are 100 % positive.

The pre-registered verdict is **INSUFFICIENT**: 3 usable forecasts and 0 negative clusters. Everything here is
**descriptive (associational)**. The committee never acted, nothing was randomised, and no causal claim is made.

All numbers come from `results.json → committee.*`, `sensitivity_contrast.*` and `sensitivity_acceptance.*`.

## 1. What "verified" means here

`self_improvements.status = 'verified'` is set by `recordOutcome` (`self-improvement-service.ts:478`) when **every** gate
of the run passed:
- maker completion;
- `tests_lint_typecheck`;
- diff threshold;
- auto-approved scope;
- worktree isolation;
- maker/checker separation;
- checker verdict `accepted`;
- security_checker verdict `accepted`.

A later passing verification overrides an earlier `regressed`; a `regressed` never overrides a `verified`.

`regressed` is everything else that ran. On this population it splits into:
- 27 missing reviewer verdicts (`NO_VERDICT`);
- 26 runtime/environment failures (`ENV`);
- 3 checker rejections;
- **0** oracle failures (LABELS.md §2).

So "verified vs regressed" mostly measures **whether the pipeline finished with an accepting reviewer**, not whether the
change was good.

## 2. The signal under each label

| label | population | yes: pos/n (Wilson 95 %) | no: pos/n (Wilson 95 %) | diff | cluster-bootstrap 95 % CI | MDE (80 % power) | reading |
|---|---|---|---|---|---|---|---|
| status, **no leakage filter** (replication) | all | 15/21 (0.50–0.86) | 20/48 (0.29–0.56) | +0.298 | [+0.056, +0.535] | 0.37 | CI excludes 0, but the forecasts are post-outcome and the label is circular (§3) |
| status, no filter | holdout | 15/19 (0.57–0.91) | 11/20 (0.34–0.74) | +0.240 | [−0.033, +0.519] | 0.42 | not supported at this n |
| ENV removed (exploratory), no filter | all | 15/18 (0.61–0.94) | 20/37 (0.38–0.69) | +0.293 | [+0.042, +0.539] | 0.39 | what remains is mostly reviewer no-verdicts |
| oracle_only, no filter | all | 18/18 | 37/37 | 0 | — | — | **no negatives; nothing to predict** |
| status, `as_of`-only filter (system rule) | all | 7/8 (0.53–0.98) | 6/10 (0.31–0.83) | +0.275 | [−0.130, +0.667] | 0.60 | not supported at this n |
| **primary (pre-registered)**, full leakage filter | holdout | 1/1 | 1/1 | 0 | — | — | **INSUFFICIENT** (n = 2, no negatives) |

Label-class mix of the two groups (no filter):
- `yes`: 15 verified, 3 ENV, 3 NO_VERDICT.
- `no`: 20 verified, 11 ENV, 17 NO_VERDICT.

The `no` group's extra "regressions" are runtime failures and missing reviewer verdicts. If the committee "knows"
anything, it knows which runs the infrastructure or reviewer will fail to finish. That can be legitimate (lane history
is in the frozen question), or it can be the claim-time context reading later state (§3). This data cannot tell the
two apart.

## 3. Checks requested by DI-001

| question | answer |
|---|---|
| Comparable populations? | Partly. Both groups come from 2026-10-04 onward, when the committee was active, and almost entirely the same lane (124/128 of the population is `gap_analysis`). They differ sharply in label-class mix (above). Clusters ≈ rows (design effect 1.0), so clustering is not what drives the result. |
| Selection bias | Only 69/128 resolved proposals have a forecast. Jobs exist only for proposals enqueued while the committee was enabled, capped per day (`committee-swarm.ts:54–59`). The development split (before 10-04) has none. Forecast presence is not random over time. |
| Checker-derived vs independent labels | The 15/21 vs 20/48 uses the status label, whose negatives are 0 % oracle failures. Under the independent label, every forecasted proposal with a label is positive (18/18 vs 37/37 under oracle_only). |
| Forecasts recorded before the outcome? | **No, for 49/69.** Median written 0.24 h after the run completed, p95 2.19 h. `as_of` (question frozen) is always before the outcome. But member context is assembled at claim time (`committee-swarm.ts:110`, `memberContext`), so `as_of` does not bound the members' information. |
| Censoring | Population = resolved only (`verified`/`regressed`). 21 `infra_failed`, 15 `no_change` and 37 `needs_more_evidence` are excluded, along with still-running proposals. Merge survival is right-censored: 2/35 merged PRs settled. |
| Wilson / cluster CIs | In the table. Wilson ignores clustering; the cluster bootstrap uses B = 2000, seed 20261014. |
| Deterministic baselines (matched on the committee-covered rows) | Status label, no filter, all 69 rows. Default-weight loss: committee 0.551 vs reject-all 0.507 vs source rate 1.203 (A2) vs template regressions 1.377 (A4) vs accept-all 1.478. Brier: committee 0.234 vs A2 0.268 vs A4 0.273 vs an in-sample constant 0.250 (optimistic reference). Holdout (39 rows): committee loss 0.590 = A2 0.590; Brier 0.226 vs A2 0.246 vs in-sample constant 0.222. **Verdict INCONCLUSIVE**: the CI includes 0 and the ranking flips in the loss grid (LOSS.md §3). |
| Test-only flag (A3) | 126/128 proposals are test-only, so A3 ≈ accept-all and cannot discriminate. |
| Descriptive vs causal | **Descriptive only.** The committee is shadow: no proposal was gated on it, there is no randomisation, and there are no propensities. "The committee would improve loss if it gated" is BLOCKED_CAUSAL_IDENTIFICATION. A prospective randomised shadow → enforce arm would be needed, and only with operator authorisation. |

## 4. Confidence: what is and is not recorded

- **No confidence field is recorded:** 0/69 forecasts have one in `answers_json`. None was invented.
- A **forecast probability `p` is recorded** for every committee forecast (69/69): the weighted mean of member `p`,
  `committee-swarm.ts:139–140`. Brier and ECE above are computed on that `p`. This corrects the prior audit's "no
  confidence → calibration impossible": calibration of `p` *is* computable. `p` is the forecast itself, though, not a
  confidence in it.
- **Prospective confidence recording** (a separate small change, *not built here*):
  1. `packages/server/src/services/committee-swarm.ts:126–130` (`recordCommittee`, member rows). Accept an optional
     numeric `a.confidence ∈ [0,1]` from the remote answer, and persist it next to `p` in `answers_json`
     (`JSON.stringify({ p, as_of, confidence })`). Never default it. A missing value stays absent.
  2. `committee-swarm.ts:139–140` (aggregate row). Persist the member dispersion (`p_sd`, `n_members`) as the
     committee's own uncertainty, derived only from recorded member `p`.
  3. `committee-swarm.ts:107–110` (`claimCommittee`). Stamp `context_at` (claim time) into the job, and copy it into
     each forecast's `answers_json`. Leakage can then be checked against when the members actually read the DB, not
     only against `as_of`.
  4. A test next to the existing committee tests: a member answer without `confidence` stores no `confidence` key.

  Item 3 matters more than confidence for future scoring. Without `context_at` a post-outcome forecast cannot be
  told apart from a clean one.

## 5. Verdict

| claim | verdict |
|---|---|
| The committee discriminates change quality (independent label) | **INSUFFICIENT**. There is no negative class. |
| The committee beats deterministic baselines on risk-weighted loss | **INSUFFICIENT** (pre-registered); INCONCLUSIVE (no filter) or INSUFFICIENT (`as_of` filter) in the sensitivity analyses |
| The 15/21 vs 20/48 association exists in the raw data | Yes, descriptively (cluster CI [+0.056, +0.535]). But it rests on post-outcome forecasts and a circular label, so it is **not supported as forecast skill**. |
| Any causal or authority claim | **REJECT**. Not identifiable from this data. |
