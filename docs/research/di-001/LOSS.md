# DI-001 loss model

## 1. What the weights are

These weights are the operator's **exploratory relative weights** (DI-001):

| error | risk class | weight |
|---|---|---|
| false accept (FA) | security / compliance | 20 |
| false accept | production regression | 10 |
| false accept | low-risk (docs, test-only) | 3 |
| false reject (FR) | any | 1 |

They are **not probabilities and not money.** They say "a false accept on a security change is about 20× as bad as
rejecting a good change", nothing more. No result in DI-001 may be read as a cost in euros or as an expected number of
incidents.

Loss per decision, with the label from PREREG §2:

`ℓ = w_FA(risk) · [accept ∧ negative] + w_FR · [reject ∧ positive]`

The primary statistic is the **mean over clusters of the cluster's mean ℓ** (PREREG §7). Each independently resolved
decision counts once, so requeue copies and same-target refinements don't inflate n. The weights live in
`scripts/di-001/score.mjs` (`DEFAULT_W`, `GRID`) and can be changed there. Every changed run is recorded in
`results.json`.

Risk class is a fixed text rule (PREREG §7). On this population:
- 118 rows are `low`;
- 6 are `security` (the title or target matches secret/auth/telegram/token/…);
- 4 are `production` (`bug_fix`, or a title starting with Fix/Investigate).

All goals carry `risk_class = low` in the DB, so the security/production split is ours, not the system's. **No
accuracy is ever pooled across risk classes.** Each score in `results.json` carries `by_risk_class` FA/FR counts.

## 2. Components, reported separately (never folded into one number)

| component | how it is measured | value |
|---|---|---|
| P(FA) | FA / covered, per label | primary label: 0 for every predictor (no negatives exist); status label, holdout: A0 0.30 (16/54), A2 0.07, A4 0.15, prescreen 0.33 |
| P(FR) | FR / covered | primary, holdout: A0 0, A2 0.45, A4 0.37; status, holdout: A2 0.31, A4 0.26 |
| inference tokens | `input_tokens + output_tokens` of the predictor's judgments on the population | prescreen 77,305 tokens over 111 rows = **1,074 tokens per verified**. Committee: 623 rows, **tokens not recorded (UNKNOWN, not 0)**. Baselines: 0 (deterministic). |
| latency | judgment `latency_ms`; committee `created_at − as_of` | prescreen p50 248 ms, p95 1,757 ms. Committee: written a median 0.24 h after the outcome (LABELS §3), so latency is the binding defect, not speed. |
| review minutes | not recorded anywhere | **UNKNOWN.** Derived bound below. |
| human capacity | operator budget 30 min/day | holdout covers 5.44 days. Always-accept yields 9.9 accepted changes/day, which leaves **3.0 review minutes per change** at 30 min/day. A2 (source rate): 4.6/day → 6.5 min. Committee (unfiltered): 3.5/day → 8.6 min. |

The capacity row is arithmetic on recorded accept counts, not an estimate of review effort. It shows that any predictor
that accepts at the current proposal rate leaves only a few minutes of review per change. Whether that is enough is an
operator judgment.

Abstention (no usable prediction) is not costed in ℓ. It is reported as coverage. An abstained decision falls back to
the system default, which is to run (every predictor here is shadow), plus whatever human review follows.

## 3. Sensitivity grid

The grid has 108 cells:

| parameter | values |
|---|---|
| `w_FA(low)` | 1, 3, 10 |
| `w_FA(production)` | 5, 10, 20 |
| `w_FA(security)` | 10, 20, 50 |
| `w_FR` | 0.5, 1, 2, 5 |

PREREG §9 accepts a predictor as BETTER only if it beats the best baseline in **every** cell *and* the cluster CI under
the default weights excludes 0.

Results (matched population = rows with a usable committee forecast):

| comparison | rows (clusters) | default-weight loss: committee vs best baseline | CI of (best − committee) | grid: committee better / worse of 108 | verdict |
|---|---|---|---|---|---|
| **primary label, holdout** (pre-registered) | 2 (2) | 0.50 vs 0 (A0) | [−1, 0] | 0 / 108 | **INSUFFICIENT** (0 negative clusters) |
| primary label, all splits | 3 (3) | 0.67 vs 0 (A0) | [−1, 0] | 0 / 108 | INSUFFICIENT |
| *sensitivity*: status label, committee without leakage filter, all | 69 (69) | 0.551 vs 0.507 (A1 reject-all) | [−0.29, 0.17] | 36 / 72 | INCONCLUSIVE |
| *sensitivity*: status label, unfiltered, holdout | 39 (39) | 0.590 vs 0.590 (A2) | [0, 0] | 0 / 72 | INCONCLUSIVE |
| *sensitivity*: status label, `as_of`-only filter, all | 18 (18) | 0.500 vs 0.611 (A2) | [−0.17, 0.50] | 45 / 54 | INSUFFICIENT (5 negative clusters, but < 20 clusters) |

In no comparison is the committee better than the best baseline in all 108 cells. Where it is better in some cells (36
and 45), it is worse or tied in the rest, so the ranking flips inside the grid. Under PREREG §9 that alone rules out
BETTER.

The cells not counted as better or worse are ties. These comparisons use the status label, whose "negatives" are mostly
runtime and reviewer failures (LABELS §2), so even a win there would not show better change-quality decisions.

## 4. Operator decisions this model still needs

1. Confirm or replace the four weights. They are exploratory; DI-001 did not fit them.
2. Whether an infra or reviewer failure should carry any loss at all. DI-001 says no: no observation, no label.
3. A recorded review-minutes field per PR, so that review cost stops being UNKNOWN.
4. Whether committee tokens should be recorded. They are not today (623 rows, 0 tokens).
