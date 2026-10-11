# jev cascade calibration study — selective risk on Djimitflo's own labels

Operator directive 11-10 ("Adaptive Evaluation & Evolution Intelligence"), based on arXiv 2609.26550
*JEV-as-a-Judge: Accept When Confident, Escalate When Unsure* (Li, Miao, Krishnan, Padman; v. 2026-10-06). The paper: a
decision-only judge (JEV) outputs label probabilities; a confidence threshold accepts its verdict or escalates to a
reasoning judge. Reported: within 3 pt of GPT-6 where the verdict "can be read off the text", 0.36 % of the cost, 0.15 s
median; cascade 0.9 pt more accurate than GPT-6 at 41 % of the fee on 1 610 held-out pairs. Stated limits: weaker on
style-adversarial pairs and reference-free prose, and where a derivation is needed (math, code, logic).

Question this study answers: **is jev's selective prediction statistically defensible on Djimitflo's own distribution?**
Not: which threshold appears to work. Routing is unchanged by this document. Code/logic, promotion, merge, deploy and
checker-gate decisions are outside jev routing by policy (oracles only).

## 1. Pre-registration (frozen before the holdout is opened)

Written and committed before any score, curve, threshold or holdout metric was computed. Its sha256 is recorded in §1.9
and the analysis in §3 is run once against it. A failed holdout yields HOLD/REJECT, never a new threshold.

### 1.1 Disclosure of prior data contact

Before this section was written, one exploratory count was printed over *all* proposal_prescreen rows (train and future
holdout together): decision × outcome status and decision × operator label. Among those counts no proposal with a jev
`no` verdict had status `verified`; 40 of 41 operator labels on `no` verdicts were "rejection correct". No continuous
score, threshold, curve or split-level metric was computed. This contact can bias the choice of hypothesis (it makes a
"skip on no" rule look attractive); it cannot bias the threshold, which is fitted on the train split only.

### 1.2 Population and label

- Judgment: `proposal_prescreen` (four Noul questions: names_file, verifiable, concrete, sensitive).
- Unit: one proposal (latest prescreen verdict per proposal).
- Included: verdicts made in **shadow** mode (before 2026-10-09T13:08Z, when D5 enforce began parking `no` verdicts —
  after that a `no` causes its own outcome, so enforce-mode rows are excluded as circular), with a resolved outcome
  status ∈ {verified, regressed, infra_failed, needs_more_evidence, archived, no_change}.
- Label y = 1 if the proposal ended `verified`, else 0. It is downstream of panel + maker + gates + checker, not of the
  prescreen (shadow), so it is independent of jev but noisy: a proposal can fail for reasons unrelated to its quality.
  y = 1 is the cost case for skipping ("verified-opportunity loss").

### 1.3 Score and routing rule under test

- Score s = min(names_file, concrete) — the two questions whose `no` band ends the current decide() rule.
- Rule R(t): accept jev's rejection (skip the panel) when s < t; otherwise escalate to the panel (today's behaviour).
- Error (false accept) = a skipped proposal with y = 1. **Primary metric: selective risk P(y = 1 | s < t).**
  Coverage = share of proposals skipped.

### 1.4 Independence and split

- Case clusters: union of (a) `requeue-of:` / `refinement-of:` / parent links in evidence_refs, (b) proposal_near_duplicate
  pairs with cosine ≥ 0.92, (c) proposals naming the same target file. 197 proposals → **152 clusters** (largest 11).
- Split by cluster: sha256('jevcal-cluster:' + smallest id in cluster) mod 10 < 7 → train, else holdout.
  144 / 53 proposals (before the shadow + resolved filter). Split assignment sha256:
  `1c4b6e55bcaea12621e059b93d984bae5625c945d85b4ee1ff83222bb323737a` (canonical lines `<id> <side> <cluster>` sorted).

### 1.5 Metrics

- AUROC and AUPRC of (1 − s) for y = 0 vs y = 1 (higher = "skip-worthy"); 95 % CI by bootstrap over clusters
  (2 000 resamples, seed 11).
- Calibration: the score is not a probability of verification, so ECE against y is reported for completeness only.
  Question-level calibration: names_file Noul vs a deterministic label (the prescreen's own PATH_RE matches the
  description). ECE with 5 equal-width bins on [0, 1].
- Risk–coverage curve over t ∈ {0.05, 0.10, …, 0.95}: per point skipped n, false accepts k, risk k/n with Wilson 95 % CI,
  coverage with Wilson 95 % CI.
- Cost table per t: panels avoided (calls), false accepts (verified-opportunity loss), and skipped proposals that later
  regressed (cost avoided). Panel tokens per call are not recorded in the ledger (tokens_in/out null) → tokens = UNKNOWN;
  € marginal cost is ≈ 0 under the flat Ollama Max subscription; savings are stated in panel calls and quota share.

### 1.6 Threshold selection (train split only)

Choose t* = the largest-coverage t on train with ≥ 10 skipped, risk point estimate ≤ 5 % and Wilson upper bound ≤ 15 %.
If none qualifies: no threshold, verdict HOLD.

### 1.7 Holdout evaluation (once)

At t*: holdout skipped n_h, false accepts k_h, risk with Wilson 95 % CI, coverage.

### 1.8 Decision criteria

- **GO** (shadow cascade router next, not act): n_h ≥ 15 skipped AND holdout risk point ≤ 5 % AND Wilson upper ≤ 15 %
  AND coverage ≥ 10 % AND train AUROC bootstrap 95 % CI lower bound > 0.60.
- **REJECT**: holdout risk point > 10 %, OR train AUROC 95 % CI includes 0.5.
- **HOLD**: anything else (incl. n_h < 15): state the label count needed and how to obtain it.
- Other judgments (inventory §2) are decided by label availability and policy, not by a holdout:
  REJECT by policy = checker_second_opinion (code gate), risk_atomic (approval gate), auto_approve_shadow (approval);
  HOLD = no independent labels ≥ 30; REJECT = label path switched off / circular.

### 1.9 Fingerprint

sha256 of this §1 text from "### 1.1" up to and excluding "### 1.9": recorded in the commit that freezes it
(see §1.9 value below, filled in the freeze commit).

PREREG_SHA256: fbc9c5d180929c43844ec8beca26bd5fbd7a62ca43b472c3efc369c0b08bbab1
