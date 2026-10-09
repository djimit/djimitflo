# Intelligence scorecard (§16.14) — baseline 2026-10-09

Prod `d815c525`, read-only snapshot 21:38Z, 30-day window unless noted. CIs are Wilson 95 % unless stated. The scorecard is
not collapsed into one score (§16.14), and promotion decisions use the underlying contracts (`METRIC_CONTRACTS.yaml`).
`INSUFFICIENT_EVIDENCE` ≠ 0.

## Primary metrics

| Metric | Current value | CI | n | Target state | Blocker |
| --- | --- | --- | --- | --- | --- |
| **VIG** | INSUFFICIENT_EVIDENCE | — | 8 trials, 0 decisive | first decisive paired VIG on a fresh holdout epoch, CI excluding 0 | no headroom on holdout (parent 17/20); write_test holdout 0 rows; dream off |
| **RIR** | INSUFFICIENT_EVIDENCE | — | 0 cycles | ≥ 3 cycles with decisive VIG, RIR trend reported | needs VIG |
| **GTI** | UNDEFINED | — | 1 repository | ≥ 2 repos, transfer gain reported with its CI | single repo for gym and prod |
| **CLY** | INSUFFICIENT_EVIDENCE (0 validated lessons) | 0/58 → CP upper 0.062 | 58 assessments | ≥ 1 lesson meeting all 5 §16.4 criteria, with its own holdout effect | no lesson has an independent verification + downstream arm |
| **Failure recurrence** | proxy 0.905 (gate-class repeats) | [0.823, 0.951] | 84 failures, 8 signatures | signature-level FRR falling with the observability guard green | coarse signatures; no remediation links |
| **CAR** | INSUFFICIENT_EVIDENCE | — | 0 audited | CAR ≥ 0.85 (lower ≥ 0.75), coverage ≥ 0.9 of settled | audit not run; coverage 0.455 [0.360, 0.552] (45/99) |
| **CIA** | INSUFFICIENT_EVIDENCE | — | X1 15 goals | CIA per cell with CI; keep only cells with positive marginal value | X1 interim: on 0/3 vs off 8/11 (p 0.055); no single-agent arm |
| **MCS** | INSUFFICIENT_EVIDENCE | — | 20 forecasters, 0 positives in window | ≥ 1 decision-grade forecaster (n ≥ 100, ≥ 10 positives, skill CI > 0) | too few resolved positives; earlier backfill: no forecaster beat the base rate |
| **ADQ** | INSUFFICIENT_EVIDENCE | — | 195 autonomous / 324 approvals, 0 outcome-linked | ADQ ≥ 0 per class (non-inferior to human) | approval → outcome link not stored; auto-merge shadow only |
| **EII** | INSUFFICIENT_EVIDENCE | — | no labelled set | versioned labelled set; ClaimSupportPrecision, RetrievalPrecision, CircularEvidenceRate reported | claims 99.9 % undetermined; 0 proposals cite knowledge |
| **ESE** | INSUFFICIENT_EVIDENCE (yield 0) | 0/16 → CP upper 0.206 | 16 dream genomes | ≥ 1 promotion with decisive fresh-holdout gain; overfitting rate reported | headroom, holdout reuse, dream off |
| **SCIG** | INSUFFICIENT_EVIDENCE | hack flags 0/140 → upper 0.021 (rule of 3) | 140 checked gym outcomes (genome none) | every constraint has a live monitor; upper bounds within the policy limit | `policy_violations` never written; `protected_paths` not enforced; risk limits not defined by policy |
| **Economics** | 0.656 verified per M cloud tokens (maker:opencode, 7 d) | [0.480, 0.856] | 82 attempts | cost per *validated improvement* (VIG-backed), not per verified run | needs VIG; reviewer tokens (31.3 M / 7 d) not yet credited to value |

## Supporting indicators (measured, not promotion metrics)

| Indicator | Value | CI | n | Source |
| --- | --- | --- | --- | --- |
| Settled proposal verified rate | 0.475 | [0.379, 0.572] | 99 | self_improvements |
| Checker accept good / defective (F1) | 0.90 / 0.15, AUC 0.875 | [0.699, 0.972] / [0.052, 0.360] | 40 items (20 pairs) | F1 |
| Checker accepts kind B (`toBeDefined`) | 0.429 | [0.158, 0.750] | 7 | F1 |
| Gym proxy vs prod-gated (mutant tasks) | 0.957 vs 0.478 | — / [0.341, 0.619] | 46 | evidence gym_prod_gates |
| Gym atomic maker success (all) | 0.812 | [0.781, 0.839] | 692 | skill_outcomes |
| Memory rules vs withheld | 0.690 vs 0.667, Fisher p 1 | [0.540, 0.809] / [0.300, 0.903] | 42 / 6 | evidence memory_holdout |
| Routing OPE (fitness-view vs bandit) | Δ −0.010 | [−0.044, 0.021] | 148 (ESS 127) | evidence ope |
| jev / checker agreement (kappa) | 0.507 | [0.210, 0.768] | 69 | evidence oracle |
| North star (verified per M cloud tokens, week of 10-02) | 0.411 | — | 32 verified | efficiencyView |
| Workstation GPU energy | 1.401 kWh over 24.3 h covered | — | 2,899 samples | efficiencyView |
| Merge survival labels | 2 survived / 0 not | — | 2 | evidence merge (gate B needs ≥ 30) |
| Open / recent loop PRs | 41 | — | — | evidence drafts (gate C needs ≤ 5) |

## Realm gates (from the evidence builder)

A red (no headroom) · B red (2 / 30 survival labels) · C red (41 open/recent loop PRs) · D red (0/20 decision-grade forecasters).

## Reading this honestly

The measurable part of DjimitFlo is a maker/checker pipeline whose checker discriminates planted defects, plus well-instrumented
but unproven learning loops. No §16 primary metric shows improvement. Most are not yet estimable, and the main reasons are
structural (one repository, no fresh holdout headroom, survival labels pending), not missing code. No claim of recursive
self-improvement, collective intelligence advantage or AGI-like capability is supported by this evidence.
