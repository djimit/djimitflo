# Operator Cockpit 3.0 — cockpit metric contracts

Intelligence metrics (VIG, RIR, GTI, CLY, FRR, CAR, CIA, MCS, ADQ, EII, ESE, SCIG, economics) are contracted in
[../intelligence-metrics/METRIC_CONTRACTS.yaml](../intelligence-metrics/METRIC_CONTRACTS.yaml) (v0.2.0) and scored in
[INTELLIGENCE_SCORECARD.md](../intelligence-metrics/INTELLIGENCE_SCORECARD.md); not repeated here. This file covers the
**operational cockpit** (`GET /api/health/cockpit`, services/operator-cockpit.ts + decisions-inbox.ts).

**Global rules (#742).** A section whose query fails yields `null` and an `errors[]` entry, never 0. Guardrail `state` ∈
`HEALTHY | DEGRADED | BREACHED | UNKNOWN | STALE | NOT_APPLICABLE`; `ok` (legacy) = `state === 'HEALTHY'`; snapshot `health`
= worst state. One synchronous pass per snapshot (`snapshot_id`, `at`) — all sections share `at` as observation time.
Event time = each row's own column (below). Reconciliation = the independent no-LIMIT query in scratchpad/b3.js (B3 method).

| Metric | Numerator | Denominator / limit | Window, event time | Source | Missing data | Status |
|---|---|---|---|---|---|---|
| verified_7d / regressed_7d / infra_failed_7d | proposals with that status | — | 7 d, `self_improvements.updated_at` (settlement time) | self_improvements | null + error | V (B3: 28/38/10 matched) |
| guardrail regressions | `maker_failure` regressed (attribution on) or all regressed (off) | ≤ verified_7d / 5 | 7 d settlement | self_improvements + latest `outcome_attribution` judgment on proposal or its runs | unattributed → `unknown`; unknown > 0 ⇒ DEGRADED | P (prod 4/26/0/8, DEGRADED) |
| guardrail panel unparseable | specialist_reviews with 'could not be parsed' | 0 | 7 d `created_at` | specialist_reviews | null → UNKNOWN | P (2, BREACHED; both 06-10) |
| guardrail reflection inflow | reflection proposals | ≤ 25 / 24 h | 24 h `created_at` | self_improvements | cap 0 ⇒ NOT_APPLICABLE | P |
| guardrail approvals expired | expired | ≤ decided / 5 (7 d) | 7 d `updated_at` | approvals | null → UNKNOWN | P |
| spend_per_verified_change_7d | Σ tokens of maker/checker/security leases **created** in 7 d | verified_7d | mixed: lease created / proposal settled — total cost of output | worker_leases.metadata.runtime_usage | verified 0 ⇒ null | P (2.37 M) |
| direct_tokens_per_verified_change_7d | Σ tokens of leases of the verified proposals' own runs | verified_7d | proposal settled in 7 d | lease → loop_run → goal → self_improvement | null | P (0.91 M) |
| tokens_per_verified_change_7d | legacy = spend metric | — | — | — | kept for compatibility | deprecated |
| needs_you.requeue | regressed/infra_failed in 30 d, not requeued, not dismissed, class `operator` | — | 30 d `updated_at` | decisions-inbox totals (COUNT, no LIMIT) | null + error | P (18) |
| needs_you.system_requeue | `budgeted_requeue` (annotated reviewer_failure), `attribution_unknown`, `not_actionable` (disabled lane / superseded) | — | 30 d | same | listed, never counted as needs-you | P (21 / 11 / 6) |
| needs_you.labels / memory_review | unlabelled latest 'no' pre-screen; memory candidates review_required+candidate | — | all time | judgments, memory_candidates | null | P (5 / 2) |
| needs_you.open_prs / draft_prs | open loop PRs (state open or NULL); merged PRs still settling | — | — | loop_draft_prs | each PR once; null on error (#749) | P (25 / 20) |
| needs_you.total | distinct subjects across blocking sections (expiring ⊂ approvals and unsettled excluded) | — | — | server-side dedupe | any null ⇒ total null | P (52) |
| stalls | detector hits | — | per detector (6–36 h) | stall-watch.ts | detector error ⇒ health UNKNOWN (#739); cap reached ⇒ `capped` (#750) | D (#739), pending (#750) |
| schedulers | per scheduler executing / failing / armed_pending / armed_not_ticking / unknown / off | grace = 2 × interval | since boot | scheduler-registry (in-process) | no interval ⇒ unknown (8 fixed in #749) | D (#739) |
| efficiency per_kwh | verified changes whose maker ran on a metered host | kWh measured | 7 d; only when energy coverage ≥ 80 % | resource-ledger, host_power_samples | else `null` + `INSUFFICIENT_EVIDENCE:` reason | D (#741) |
| energy per consumer | Σ sample Wh × (job share of overlapping jobs on that host) | — | sample time | host_power_samples × job windows | coverage_pct per consumer/host | D (#741) |

## Reconciliation rules
1. Every needs-you count equals its no-LIMIT COUNT (test: 150 candidates → 150; prod: 43 → 59 before, 18 operator + 38 system after).
2. Σ attributed Wh ≤ host-measured Wh (test in resource-ledger.test.ts).
3. Regression split sums to regressed_7d (maker + reviewer + environment + unknown).
4. needs_you.total ≤ Σ blocking counts (dedupe never adds).
