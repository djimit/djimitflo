# D. Data and metrics audit

Snapshot values changed during the audit because the system remained active. Counts below are timestamped by the audit date and should not be treated as permanent.

## Improvement funnel semantic contracts

| Metric | Current implementation / source | Confirmed issue | Required contract |
|---|---|---|---|
| Proposals | Count of all `self_improvements`; 1,421 at query time | Valid lifetime inventory, not a cohort | State lifetime vs window explicitly |
| Panel decisions | Count of every `specialist_panels` row with consensus; 1,581 = 1,401 needs-more-evidence + 68 backlog + 57 blocked + 55 goal | 505 decided panels are not referenced by any proposal; this is not the proposal denominator | Restrict to proposal-linked unique panels or label as all panel decisions |
| Panel goal rate | `goal decisions / all decided panels` = 55/1,581 ≈ 3% | Cross-domain denominator; repeated/shared panel relationships exist (1,105 proposal links, 1,076 unique panel IDs) | Define cohort key, unit (proposal or panel), multiplicity rule and time window |
| Refinements | 307 rows have `refined_from_id`; 307 originals have `refined_at` | Count is coherent | Define whether chained refinements are allowed and deduplicated |
| Refinement conversion | Child proposal status in scheduled/executing/verified/evaluating/applied divided by 307 | **Confirmed defect:** displays 0%, while 18 refined children have goals (14 completed, 4 failed); child proposal statuses stayed 292 archived, 14 no-change, 1 regressed | Compute from `goals.improvement_id` for “reached goal”; show goal outcome separately |
| Cognitive episodes | Raw count of `cognitive_episodes`; 282 during query | Multiple episodes per loop are possible; other services deduplicate by first row per `loop_run_id` | Label raw episodes and add unique loop runs |
| Verified (7d) | Current proposal status is verified/evaluating/applied and `updated_at` in window | It measures rows whose latest update is in-window, not first-time verification and not sustained success | Persist/aggregate a verification transition timestamp; name “entered verification” or “currently verified updated” accurately |
| Regressed (7d) | Current status `regressed` and `updated_at` in window | Mutually exclusive current status; cannot prove it was previously verified | Store state transitions and regression parent/verification reference |
| Regression rate | regressed / (verified + regressed) in same update window | Mixing current states and mutable timestamps; reviewer/environment failures are handled differently elsewhere | Contract by outcome class and attributable cohort |
| Panel reviews (24h) | Actually counts **panels created**, not `specialist_reviews` | Label is wrong. Source returned 2 in supplied snapshot and 7 later; neither is specialist review count | Rename to Panels created or count `specialist_reviews.created_at` |
| Median time to verified | `updated_at - created_at` for current verified/evaluating/applied rows updated in last 30d | `updated_at` may be later non-verification activity | Use immutable `verified_at`; publish n and p25/p50/p90 |
| Open work items | Candidate/triaged/planned/leased/blocked rows, 158 | Semantically sound if statuses are mutually exclusive | Publish included statuses and as-of timestamp in tooltip |
| Zombie goals | Status/time query with active-run exception | Zero can mean no matching rows, not monitor coverage | Show rows evaluated, latest scheduler execution and data freshness |
| Stale runs | Interrupted >48h or planning >24h | Excludes long-running/running dead workers by design | Expose complete state-specific thresholds and scheduler freshness |

## Verified, survival and causal improvement

The cockpit correctly states `verified = throughput, not improvement`. The 60-day lineage showed 121 verified, 75 merged, 19 settled and 19 surviving 14 days. It explicitly reports 30-day survival, capability gain and reproduction as not measured. Therefore:

- “Verified” means a gate outcome at one point, not sustained benefit.
- “Regressed” is not proven to be a subset of previously verified outcomes with the current mutable status model.
- “Survived 14 d” is the strongest live fitness evidence, but 19/19 is a small, selected cohort and cannot establish capability gain.
- No causal-improvement claim is supportable until a change is linked to a preregistered metric, baseline/control, deployment, survival window and independent reproduction.

## Metric freshness and clock semantics

Every metric card should carry `as_of`, window bounds, population size and source status. The silent-stall text says the memory-holdout stall began `2026-10-27` while the audited system clock was `2026-10-23`, yet the UI rendered “since < 1 h ago.” This is a confirmed temporal-display defect or future-scheduled sentinel interpreted as elapsed time. Future timestamps must render “scheduled in …” and must never trigger elapsed-stall language.

## Minimum metric contract schema

For each metric persist/document: `metric_id`, human definition, numerator SQL, denominator SQL, entity unit, cohort/window, exclusions, freshness timestamp, source table/version, owner, alert threshold, drill-down route and known limitations. The API should return this metadata beside the value; the UI should expose it progressively, not as permanent card clutter.
