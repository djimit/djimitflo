# Realm program (Phase F)

Operator-adopted 2026-10-04: make the evolution loop's selection pressure visible, valid and hard to game before it
evolves more openly. Every item ships shadow-first behind a flag that defaults to off; acting flags stay the operator's.

## Status

| Item | What | State |
|---|---|---|
| RX-0b | Triage of the open loop draft PRs (20 open, all single new test files, CI green, mergeable) | handed to the operator |
| RX-1 | `GET /api/health/evolution-evidence?days=30` (manage:config): flags, outcomes per source, loop PRs, genomes/holdouts, gym per tier, Realm Gates | this PR |
| RX-2 … RX-16 | runbook truth, draft throttle, reward tags, blind-trial diagnostics, tier probe, nightly estimates, honest Commons/oracle/forecast numbers, merge-survival v2, OPE replay, hack detector, epoch holdout, e-process shadow, governance bundle | open |

## Realm Gates (computed by the evidence endpoint)

- **A — evaluator can see:** parent pass rate on the deciding set in [0.30, 0.55]. Unknown until RX-4 records per-trial parent failures.
- **B — gold labels exist:** ≥ 30 settled loop PRs with ≥ 8 per outcome class.
- **C — human queue drains:** ≤ 5 open loop drafts on 14 consecutive days, ≥ 80 % disposed within 7 days.
- **D — forecasters are decision-grade:** ≥ 10 positives, n ≥ 100, skill CI excludes 0 (CI from RX-7).

## Operator decision ledger

| Id | Decision | Evidence threshold | Rollback | Status |
|---|---|---|---|---|
| OD-1 | Mutant holdout tiers (`DREAM_TRIAL_MUTANT_TIERS`) | RX-5 tier probe: a tier set with pass rate in [0.30, 0.55], n ≥ 20 per tier | previous value; a new tier set freezes its own 20 tasks beside the old | held for RX-5 |

## Corrections to earlier claims

- Prod remote gym cap is 72/day (the prompt assumed the code default 24).
- Production flag values are read from the evidence endpoint, not from this file.
