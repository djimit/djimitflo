# DI-001 baseline: decision scoring on resolved loop proposals

**Overall verdict: INSUFFICIENT on the pre-registered primary metric.** Every sensitivity analysis is INCONCLUSIVE or
INSUFFICIENT. No predictor, the committee included, is shown to beat a deterministic baseline. No authority change
follows from this report.

## 1. Provenance

| item | value |
|---|---|
| Protocol | `PREREG.md`, sha256 `4696b134a6fb30b3750e973c78c936a2b8a268fe346026454ee81bae84e57846` |
| Commit order | `ed7a226e` PREREG alone → `4d5faa2c` its sha256 → `67cd0580` frozen manifest + builder → scorer, results and these docs |
| Manifest | `manifest.json`, file sha256 `c132ba78…3c01`, **rows_sha256 `48d1f0aa0c0306b0941108a07fc2510dddf1b4e22e11426b65af5dc7425cff60`**, snapshot `2026-10-13T22:28:27.395Z` |
| Results | `results.json`, produced by `scripts/di-001/score.mjs`; two consecutive runs gave byte-identical output (seeded bootstrap, B = 2000, seed 20261014) |
| Data | Read-only read of `djimitflo-live:/data/djimitflo.sqlite` (`readonly: true`). No writes, flags or restarts. |
| Prior audit reused | `decision-intelligence-audit-20261014`: 128 resolved, 72 V / 56 R; committee yes 15/21, no 20/48. Both reproduce exactly. |

Reproduce:

```bash
# copy scripts/di-001/*.mjs and docs/research/di-001/manifest.json to the container's /tmp/di001, then
docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/di001/score.mjs --manifest /tmp/di001/manifest.json --db /data/djimitflo.sqlite > results.json
docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/di001/build-manifest.mjs --db /data/djimitflo.sqlite --snapshot 2026-10-13T22:28:27.395Z  # same rows_sha256
docker exec -u root djimitflo-live rm -rf /tmp/di001
```

The manifest *file* hash also covers the live counts of excluded statuses. A later rebuild saw one `proposed` row
turn `executing`, which changed the file hash, but `rows_sha256` reproduced. score.mjs checks `rows_sha256` and reports
label drift; drift was 0.

## 2. Population

| split | proposals | clusters | design effect | verified / regressed | label classes |
|---|---|---|---|---|---|
| development (< 10-04) | 44 | 40 | 1.10 | 25 / 19 | 25 PASS, 10 ENV, 6 NO_VERDICT, 3 CHECKER_REJECT |
| calibration (10-04 → 10-08) | 30 | 30 | 1.00 | 9 / 21 | 9 PASS, 14 NO_VERDICT, 7 ENV |
| **holdout (≥ 10-08)** | 54 | 52 | 1.04 | 38 / 16 | 38 PASS, 9 ENV, 7 NO_VERDICT |
| all | 128 | 110 | 1.16 | 72 / 56 | 72 PASS, 27 NO_VERDICT, 26 ENV, 3 CHECKER_REJECT |

**Excluded statuses** at the snapshot: 1,129 archived, 37 needs_more_evidence, 21 infra_failed, 15 no_change,
5 needs_grounding, 1 proposed.

**Risk classes** (fixed text rule): 118 low, 6 security, 4 production.

**LOST window** (10-11 04:16 → 10-12 16:43): 0 proposals overlap. Rows lost in that window are absent, never zero.

## 3. Primary result (pre-registered)

The independent label (LABELS.md) has **72 positives and 0 negatives**. Every one of the 56 `regressed` proposals is a
runtime failure (26), a missing reviewer verdict (27) or a checker rejection (3). None is a final-attempt
executed-oracle failure.

Consequences on the holdout:
- **FA = 0** for every predictor, by construction.
- The loss reduces to the false-reject rate.
- Accept-all (A0) and test-only (A3) score 0 trivially.

| predictor (holdout, primary label) | covered / 38 | FR | loss (cluster CI) |
|---|---|---|---|
| A0 accept-all | 38 | 0 | 0 [0, 0] |
| A3 test-only | 38 | 0 | 0 [0, 0] |
| A4 template regressions | 38 | 14 | 0.368 [0.21, 0.53] |
| A2 source rate | 38 | 17 | 0.447 [0.32, 0.61] |
| committee | 2 | 1 | 0.50 [0, 1] |
| prescreen (reference only, NE-001) | 26 | 0 | 0 [0, 0] |

Acceptance rule (PREREG §9):
- Committee vs best baseline: 2 rows, 0 negative clusters → **INSUFFICIENT**.
- The committee CI on its contrast is undefined (no label variation) → **INSUFFICIENT**.

## 4. Secondary: the system's own status label (circular, not independent)

| predictor (holdout, status label, n = 54) | TP | FP (FA) | TN | FN (FR) | precision | recall | FAR | FRR | loss (cluster CI) | Brier / ECE |
|---|---|---|---|---|---|---|---|---|---|---|
| A0 accept-all | 38 | 16 | 0 | 0 | 0.70 | 1.00 | 1.00 | 0.00 | 0.837 [0.49, 1.18] | — |
| A1 reject-all | 0 | 0 | 16 | 38 | — | 0.00 | 0.00 | 1.00 | 0.721 [0.61, 0.84] | — |
| A2 source rate | 21 | 4 | 12 | 17 | 0.84 | 0.55 | 0.25 | 0.45 | 0.548 [0.34, 0.78] | 0.242 / 0.204 |
| A3 test-only | 38 | 16 | 0 | 0 | 0.70 | 1.00 | 1.00 | 0.00 | 0.837 [0.49, 1.18] | — |
| A4 template regressions | 24 | 8 | 8 | 14 | 0.75 | 0.63 | 0.50 | 0.37 | 0.692 [0.42, 0.96] | 0.235 / 0.177 |
| committee, no leakage filter (sensitivity, 39 covered) | 15 | 4 | 9 | 11 | 0.79 | 0.58 | 0.31 | 0.42 | 0.590 [0.33, 0.90] | 0.226 / 0.228 |
| prescreen (reference, 39 covered) | 26 | 13 | 0 | 0 | 0.67 | 1.00 | 1.00 | 0.00 | 1.000 [0.62, 1.46] | — |

The intervals overlap for every pair. These rows rank predictors by how well they foresee runtime and reviewer
failures, not change quality.

## 5. Committee, cost and capacity: summaries

- **Committee** (COMMITTEE.md). The raw yes 15/21 vs no 20/48 association has cluster CI [+0.056, +0.535]. But 49/69
  forecasts were written after the outcome. The label's negatives are 0 % oracle failures, and under the independent
  label both groups are 100 % positive. **Not supported as forecast skill.** The confidence field is not recorded;
  `p` is recorded and scored.
- **Cost** (LOSS.md). Prescreen costs 1,074 tokens per verified. Committee tokens are not recorded (UNKNOWN). Baselines
  cost 0.
- **Capacity** (LOSS.md). At 30 min/day, accept-all leaves 3.0 review minutes per change.
- **Effective n and power.** The holdout has 52 clusters (design effect 1.04). For the committee contrast the minimum
  detectable difference at 80 % power is 0.42 (holdout, no filter) and 0.60 (`as_of` filter). Only very large effects
  could be seen even with a valid label.

## 6. Verdicts

| question | verdict |
|---|---|
| Does any predictor lower risk-weighted loss vs deterministic baselines? (primary) | **INSUFFICIENT**: no independent negatives |
| Does the committee forecast change quality? | **INSUFFICIENT**; the raw association is not supported as skill |
| Status-label sensitivity analyses | INCONCLUSIVE (no leakage filter) / INSUFFICIENT (`as_of` filter) |
| Causal claims (gating would help) | **REJECT**: BLOCKED_CAUSAL_IDENTIFICATION |
| Authority / enforce changes | None proposed |

## 7. Deviations from PREREG (all made after seeing data; none changes the primary result)

1. **Added sensitivity predictors**, after the leakage counts were seen (49/69 post-outcome):
   - `committee_asof_only`, the system's own `forecast-scoring.ts` rule;
   - `committee_unfiltered`, which reproduces the prior audit.
   Both are labelled as sensitivity everywhere.
2. **Added an exploratory label** `x_status_evaluated` (status label with ENV removed), labelled exploratory.
3. **Fixed the contrast verdict text** for degenerate label variation (pooled rate 0 or 1 → INSUFFICIENT rather than
   "CI includes 0"), before the final `results.json`.
4. **Added outputs**: matched Brier, token totals and the human-capacity row. These are reporting additions; no rule
   changed.
5. **Manifest file hash.** It includes live excluded-status counts. `rows_sha256` is the frozen identity (§1).

## 8. What would change the verdict (no build here)

1. **An attempt-level oracle label**: one row per maker attempt, with check exits. 13 proposals have a failed attempt.
   This needs a new pre-registration.
2. **Merge survival** for about 35 merged PRs, settling through ~10-27. Expect few negatives.
3. **CAR operator audits** (0 today). The independent negatives would come from C-class labels.
4. **Committee `context_at` + optional confidence recording** (COMMITTEE.md §4), so future forecasts are checkable for
   leakage.
