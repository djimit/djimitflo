# H-D5NO — jev confident-NO as an asymmetric rejection classifier (pre-registration)

Status: **pre-registered, frozen before any post-cutoff outcome is analysed** (2026-10-11). Code: `packages/server/src/services/d5-no.ts`,
evidence section `d5_no` in `/api/health/evolution-evidence`. Operator decision 2026-10-11.

## Why this exists, and what it is not

- The JC study (PR #779, negative-evidence entry **NE-001**) rejected jev confidence routing for the proposal pre-screen:
  holdout risk 0.20 [0.07, 0.45] at t* = 0.95. That verdict stands. This protocol does **not** retune, re-fit or reuse JC
  data, its split or its 30 % holdout.
- The operator's 40/41 agreement with D5 rejections (labels only on 'no', all before the cutoff) is **context, not data**.
- The prescreen is now in **shadow** (`TYPESAFE_PROPOSAL_PRESCREEN_MODE=shadow`): every proposal reaches the kimi-k3 panel, and
  its real outcome is observed. Nothing in this protocol routes, parks or approves.
- Open hypothesis, not negative evidence. It is not listed in `NEGATIVE_EVIDENCE.yaml`; NE-001's guard (forbidding a
  `CASCADE_JUDGE_MODE` / prescreen cascade path) does not cover this read-only evaluation.

**Hypothesis H-D5NO:** among independent proposal clusters that jev pre-screens as confident-NO, the probability that the
proposal would have verified is below 5 %.

## Population

- Proposals created at or after the cutoff **2026-10-11T21:00:00Z** (the shadow switch of the prescreen; frozen as
  `D5NO_CUTOFF`, no env override), with a `proposal_prescreen` judgment in mode `shadow` at or after the cutoff (latest per
  proposal).
- Excluded: oracle-lane proposals (`gap_analysis` with `test-gap:` / `mutation-gap:` refs) — they skip the panel and D5 never
  parked them.
- Excluded whole: any cluster linked to a pre-cutoff proposal (a requeue copy, refinement or near-duplicate of a JC-era
  proposal belongs to that era).

## Unit of analysis: the independent cluster

- Union of: `requeue-of:` links, `refinement-of:` links, `proposal_near_duplicate` judgments (cosine ≥ 0.92, `similar_to=`),
  and same-target variants (same first named file path in the description, the `namedPathsExist` path shape).
- One observation per cluster. **Decision** = the prescreen decision of the cluster's earliest member (the first screening —
  the one enforce would have acted on). **Outcome** = conservative: any verified member ⇒ false rejection.

## Definitions (frozen)

- **Confident-NO** = exactly the rule D5 enforce parked on: `proposal_prescreen` decided `no`
  (`self-improvement-auto-review-scheduler.ts`: `prescreen.decision === 'no'`). That decision comes from `decide()` in
  `judgments/proposal-prescreen.ts`: `concrete` < 0.3 or `names_file` < 0.3 (band), or the named file does not exist.
- **False rejection** = the cluster reaches `verified`.
- **Correct rejection** = the cluster settles without verifying: `rejected`, `no_change`, `regressed`, `needs_more_evidence`,
  `needs_grounding`, `archived`.
- **Censored** = every member `infra_failed` (neither; reported).
- **Pending** = any member still `proposed`, `scheduled`, `executing`, `evaluating` or `applied`.
- **Confident-YES** and **uncertain**: descriptive only (verified rate + Wilson CI). Never a routing candidate.

## Primary metric and decision rules

- Metric: false-rejection risk P(verified | confident-NO) over independent resolved clusters, with the **exact one-sided 95 %
  Clopper-Pearson upper bound**, computed from the observed clusters.
- Maximum acceptable risk: upper bound **< 5 %**.
- Minimum n: the bound can fall below 5 % only from **59 independent resolved clusters** (0 errors: upper 0.0495; at 58 it is
  above 5 %). Derived by `minClustersForBound()`.
- Preregistered maximum / single efficacy analysis: **n = 100** independent resolved confident-NO clusters, taken in order of
  first screening. At n = 100 at most **1** false rejection keeps the bound below 5 % (1/100 → 0.0466; 2/100 → 0.0616).

| n | max false rejections with bound < 5 % | bound at that count | bound at one more |
|---|---|---|---|
| 59 | 0 | 0.0495 | 0.0779 |
| 75 | 0 | 0.0392 | 0.0617 |
| 93 | 1 | 0.0500 | 0.0662 |
| 100 | 1 | 0.0466 | 0.0616 |
| 124 | 2 | 0.0499 | 0.0613 |
| 150 | 2 | 0.0414 | 0.0509 |

- **READY** (GO candidate): at n = 100, false rejections ≤ 1 (upper bound < 5 %). READY means only that enforce **may be
  proposed to the operator again** — never automatic.
- **Early REJECT**: as soon as the accumulated false rejections exceed what n = 100 allows (≥ 2), the bound can no longer be
  reached → REJECT, and an NE entry is added to the negative-evidence registry.
- **Never early GO**: no look before n = 100 can produce READY.
- **INSUFFICIENT_EVIDENCE**: n = 100 not reached by cutoff + 90 days.
- Power (for context): P(≤ 1 false rejection at n = 100) is 0.74 if the true rate is 1 %, 0.56 at 1.5 %, 0.40 at 2 %.

## Separate capability, not part of this test

The deterministic text-grounded check (does the proposal name a file, against a file-path label — JC measured ECE 0.079,
AUROC 0.959) is a separate capability. Mentioned here, not built or tested.

---
PREREG_SHA256: 2730c749acd68599e779ecbeac9016bca9d3800f5f8b81f2cc196eaa3c314b0e (sha256 of everything above this line; computed 2026-10-11 before any post-cutoff outcome was read)
