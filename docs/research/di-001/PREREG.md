# DI-001 pre-registration — decision scoring on resolved loop proposals

Status: **frozen**. This file was committed on its own, before any scoring output in this directory existed. Its sha256 is
recorded in the next commit (`docs/research/di-001/PREREG.sha256`). Any later change to this file is a protocol deviation
and must be listed in BASELINE.md §Deviations with a reason; it never silently re-defines a result.

Operator directive: DI-001 (2026-10-14). Read-only on prod. No flags, no restarts, no writes.

## 0. What is already known (not a blind protocol)

This protocol is **not blind**. Before it was written the following were already seen, from
`decision-intelligence-audit-20261014` (prior audit, all 128 resolved proposals, no split):

- 128 resolved proposals = 72 `verified` / 56 `regressed`; 64 created before 2026-10-07, 64 after.
- `forecast:committee` descriptive: decision `yes` → 15/21 `verified`; `no` → 20/48 `verified` (status label, no CI).
- Structural facts (no outcome cross-tabs) read for this protocol: every resolved proposal has exactly one `loop_runs` row via
  `goals.improvement_id`; gate names in `loop_runs.gates_json`; maker `deterministic_checks` (`test:changed`, `lint`,
  `type-check`, `test:mutation:grounded`, `test:assertion-strength`); evidence refs `test-gap:`, `mutation-gap:`,
  `requeue-of:`, `refinement-of:`; all goals `risk_class = low`; `forecast:committee` rows carry `answers_json.p` and `as_of`.

Consequence: the committee signal cannot be "discovered" by this study — the study can only **confirm or fail to confirm**
it under a stricter label and with uncertainty. Every threshold below is fixed without looking at a cross-tab under the new
label.

## 1. Snapshot selection

- Unit: one `self_improvements` row (a proposal).
- Include: `status IN ('verified','regressed')` at snapshot time and `created_at <= snapshot_at`.
- Snapshot timestamp `snapshot_at` = wall-clock UTC at manifest build; recorded in the manifest. After freezing, the DB is
  read only for rows whose own `created_at <= snapshot_at` (judgments, runs, leases), so later rows never change a number.
- Excluded from the population (counted, reported): `infra_failed`, `no_change`, `needs_more_evidence`, `needs_grounding`,
  `archived`, `proposed` — none of these is an outcome of an evaluated change.
- LOST/UNVERIFIED window `2026-10-11T04:16:22Z → 2026-10-12T16:43:39Z` (DB restore): rows that would have been written in
  it are missing. A proposal whose `[created_at, outcome_at]` interval overlaps the window is flagged `lost_window = true`.
  For such a proposal a **missing** judgment is `UNVERIFIED`, never "no forecast" and never a zero. Primary results are
  reported with and without flagged proposals.

## 2. Label definitions

`outcome_at` = `loop_runs.completed_at` of the proposal's run, else `loop_runs.updated_at`.

Label classes (one per proposal, first matching rule wins):

| class | rule | role |
|---|---|---|
| `ENV` | gate `maker_completion` ≠ pass, or `worktree_isolation` / `assignment_file_present` / `run_not_cancelled` fail, or any maker deterministic check exit 127, or maker `changed_files` empty | excluded: no change was evaluated |
| `ORACLE_FAIL` | gate `tests_lint_typecheck` = fail, or any maker deterministic check (`test:changed`, `lint`, `type-check`, `test:mutation:grounded`, `test:assertion-strength`) exit ≠ 0 and ≠ 127 | **negative**, executed oracle |
| `POLICY_FAIL` | gate `diff_threshold_all_makers` or `auto_approved_scope` = fail (and not above) | **negative**, deterministic policy (A-class) |
| `ORACLE_PASS_VERIFIED` | `status = verified` (all gates passed) | **positive** |
| `CHECKER_REJECT` | executed oracles passed, a checker/security_checker lease `completed` with verdict `rejected`/`needs_revision` | excluded from primary (circular) |
| `NO_VERDICT` | executed oracles passed, a review gate failed without a completed rejecting verdict (timeout, budget, `insufficient_evidence`, dispatch failure) | excluded: no label |
| `UNCLASSIFIED` | anything else | excluded, listed by id |

Rationale: a checker rejection is not evidence that the checker was right; using it as a negative label would score the
checker against itself. A missing reviewer verdict is no observation at all. Detailed eligibility in LABELS.md.

Secondary labels (reported, never primary):
- `status` label: `verified` = 1, `regressed` = 0 (the system's own label — what the 15/21 vs 20/48 figure used).
- `oracle_only` label: positive = `ORACLE_PASS_VERIFIED ∪ CHECKER_REJECT ∪ NO_VERDICT` (executed checks passed regardless
  of the reviewer), negative = `ORACLE_FAIL ∪ POLICY_FAIL`.
- merge survival: `loop_runs.metadata.pr_outcome` settled (`survived` true/false after ≥ 14 d). Reported as n only if < 10.
- operator labels: `operator_label` judgments (D5, prescreen rejections) and `attribution_audit` / `operator_label` (CAR).
  Reported as counts on this population.

Positive label caveat (stated in every table): `ORACLE_PASS_VERIFIED` also requires checker acceptance, so the positive
class is conditioned on a checker accept. There is no positive class without that condition in the data.

## 3. Exclusion rules

1. Label class ∉ {`ORACLE_FAIL`, `POLICY_FAIL`, `ORACLE_PASS_VERIFIED`} → excluded from primary (count + reason).
2. A prediction is used only if `judgment.created_at < outcome_at` **and** (when `answers_json.as_of` exists)
   `as_of < first goal created_at`. Otherwise it is a leakage exclusion (counted per predictor).
3. First prediction per (predictor, proposal) only.
4. `decision = 'error'` or unparsable answers → ABSTAIN (counts against coverage, never as a negative).
5. No exclusion on the basis of an outcome-dependent field other than the label rules above.

## 4. Split by time (on `self_improvements.created_at`, UTC)

| split | interval | use |
|---|---|---|
| development | `< 2026-10-04T00:00:00Z` | baseline sanity only |
| calibration | `[2026-10-04, 2026-10-08)` | reported; the only data a tuned threshold may use (none is tuned here) |
| holdout | `>= 2026-10-08T00:00:00Z` and `<= snapshot_at` | **primary** |

Fitted baselines use an **expanding window**: for a proposal created at t, only outcomes with `outcome_at < t` are used. No
predictor in this study has a threshold tuned on any split; the committee and all baselines are scored at their recorded or
fixed decision rule (accept iff p ≥ 0.5 / decision `yes`).

## 5. Clustering

Union-find over proposals; two proposals share a cluster when any of:
- one carries `requeue-of:<id>` or `refinement-of:<id>` naming the other, or `refined_from_id` = the other;
- same `fingerprint`;
- same target: identical `test-gap:<x>` / `mutation-gap:<x>` evidence ref value, after stripping a `#exports` suffix.

Cluster id = lowest proposal id (lexicographic) in the cluster. Clusters are computed over the full population (all labels)
before exclusions, so a cluster is never split by the label rule.

## 6. Predictors

| id | rule | p available |
|---|---|---|
| `committee` | `forecast:committee.decision` (= weighted mean member p ≥ 0.5) | yes (`answers_json.p`) |
| `A0_accept_all` | always accept | no |
| `A1_reject_all` | always reject | no |
| `A2_source_rate` | accept iff expanding-window verified rate of the proposal's `source` (Laplace +1/+2) ≥ 0.5 | yes (the rate) |
| `A3_test_only` | accept iff the proposal is test-only (`test-gap:`/`mutation-gap:` ref or title `^Add (one )?unit test`) | no |
| `A4_template_regress` | template = evidence-ref kind (`test-gap`, `test-gap#exports`, `mutation-gap`, `other`); accept iff expanding-window regression rate of the template (Laplace) < 0.5 | yes (1 − rate) |
| `prescreen` | `proposal_prescreen.decision` (jev) — **reference only**, not a candidate (NE-001) | no (no stored calibrated p) |

Scored on the intersection with a usable prediction; `committee` is also compared to each baseline on the committee's own
covered subset (matched population).

## 7. Metrics

Primary: **expected risk-weighted loss per independently resolved decision** on holdout:
`L = mean over clusters of (mean over the cluster's labelled proposals of w_FA(risk) · FA + w_FR · FR)`, FA = accept ∧
negative label, FR = reject ∧ positive label. Weights from LOSS.md (default: security/compliance FA 20, production
regression FA 10, low-risk/docs/test-only FA 3, FR 1). These are exploratory relative weights, not probabilities or money.

Risk class (fixed rule, on proposal text only): `security` if title or target matches
`/secur|secret|auth|telegram|safety|ransom|polic|approval|permission|token/i`; else `production` if `type = bug_fix` or the
title starts `Fix`/`Investigate`; else `low` (test-only, docs).

Secondary (all on holdout, also reported per split):
- P(FA) and P(FR) separately; precision, recall, false-accept rate FAR = FA / negatives, false-reject rate FRR = FR /
  positives;
- Brier and ECE (10 equal-width bins) **only** where a probability exists (`committee`, `A2`, `A4`);
- selective risk / coverage / abstention: abstention = rows with no usable prediction or an error; risk-coverage curve for
  `committee` ordered by |p − 0.5|; coverage at fixed selective risk 0.20 (max over the curve — optimistic, labelled so);
- latency: committee `created_at − as_of` (p50/p95);
- tokens per verified: sum of `input_tokens + output_tokens` of the predictor's judgments on the scored set / positives;
- label provenance completeness: share of the population whose label rule resolved from recorded gates + leases (not
  `UNCLASSIFIED`), and share with an `outcome_attribution` row.

## 8. Uncertainty, effective n and power

- 95 % CIs by cluster bootstrap (resample clusters with replacement, B = 2000, PRNG mulberry32, seed `20261014`), percentile
  interval. Wilson intervals for single proportions are reported alongside (they ignore clustering, labelled so).
- Effective n = number of clusters; design effect = n / n_clusters.
- Power: minimum detectable difference in a proportion at α = 0.05 two-sided, 80 % power, two groups of effective sizes
  n1, n2 at the pooled rate (normal approximation). Reported before the comparison it qualifies.

## 9. Acceptance rule

A predictor X is reported as **BETTER than baseline A** only if all hold on holdout:
1. ≥ 20 labelled clusters in the matched population, with ≥ 5 clusters in each label class;
2. the cluster-bootstrap 95 % CI of `L_A − L_X` lies entirely above 0 under the default weights;
3. `L_X < L_A` in every cell of the LOSS.md sensitivity grid.

`WORSE` mirrors 2–3 with the sign reversed. If (1) fails → `INSUFFICIENT`. Otherwise → `INCONCLUSIVE`. Baseline A for the
primary comparison is the best of `A0`–`A4` by holdout point loss (reported; picking the best baseline makes the test
conservative for X).

For the committee signal (COMMITTEE.md): the descriptive difference `P(pos | yes) − P(pos | no)` is called **supported**
only if its cluster-bootstrap 95 % CI excludes 0 under the primary label; otherwise **not supported at this n**.

Verdicts are descriptive (associational). No result here licenses a causal claim or any change of authority; any change
needs a separate operator decision.

## 10. Reproducibility

`scripts/di-001/build-manifest.mjs` (read-only) writes the frozen manifest; `scripts/di-001/score.mjs` reproduces every
number in BASELINE.md / COMMITTEE.md / LOSS.md from the manifest plus a read-only DB read, deterministically. score.mjs
verifies the manifest sha256 and reports label drift (DB now vs manifest) without using it.
