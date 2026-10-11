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

## 2. Inventory (prod, read-only, 2026-10-11)

| Judgment | Questions | Gate / band | Mode | Consumer | Independent label | n (non-error) | Note |
|---|---|---|---|---|---|---|---|
| proposal_prescreen | 4 Noul (names_file, verifiable, concrete, sensitive) | band 0.3/0.6–0.7 per question | enforce since 09-10 13:08Z (`no` → park); shadow before | panel skip (D5) | outcome verified (shadow rows); operator D5 labels (only on `no`, 41) | 245 | enforce rows circular for outcome |
| checker_second_opinion | 1 Choice + 3 atomic Nouls | conf floor 0.6 | shadow | none (evidence) | checker verdict (not ground truth); outcome circular (verified requires checker) | 129 | code domain |
| risk_atomic | 4 Noul | band 0.3/0.7 | shadow | none (next to keyword class) | keyword class (not ground truth) | 114 | approval gate |
| discovery_relevance | Choice + Noul | conf floor 0.6 | shadow (FE2 admission gate) | unit admission | operator lifecycle actions (< 30) | 3 430 | 83 % uncertain |
| kb_passage_relevance | dynamic | — | enforce | KB context in panel prompt | none | 102 | |
| failure_cause | Choice + Noul | conf floor 0.6 | off since 08-10 (X3) | dream rules (off) | outcome_attribution does not join (different subjects) | 199 | 76 % uncertain |
| reflection_triage | 1 Choice | conf floor 0.6 | shadow; reflection cap 0 | none | reflection 1/724 verified ever | 169 | lane off |
| commons_idea / commons_contribution | Choice + Noul | conf floor 0.6 | off (Y7) | none | none | 2 690 | residents forecast-only |
| auto_approve_shadow | rule over judgments | — | shadow | none | outcome | 166 | approval gate |
| content_safety (NVIDIA, not jev) | — | — | shadow | KB page removal | none | 5 984 | 67 % errors |

## 3. Results (holdout evaluated once, against PREREG_SHA256 fbc9c5d1…)

### 3.1 Population

178 shadow-mode prescreen verdicts with resolved outcome: train 130 (96 clusters, 19 verified), holdout 48
(42 clusters, 16 verified). The holdout's verified share (33 %) is higher than train's (15 %): the cluster split put more
gap-analysis proposals there; reported, not corrected.

### 3.2 Discrimination and calibration (train)

| Metric | Value | 95 % CI (cluster bootstrap, 2 000) |
|---|---|---|
| AUROC, skip-worthiness (1 − s) vs not-verified | 0.761 | 0.650 – 0.843 |
| AUPRC, same (base rate not-verified 0.854) | 0.944 | 0.888 – 0.974 |
| ECE, s vs verified (5 bins; s is not a verification probability) | 0.547 | — |

Question-level calibration — names_file Noul vs the prescreen's own PATH_RE on the description (all 196 rows, 164
positive): ECE 0.079 (5 bins), AUROC 0.959, AUPRC 0.992. Bins: 0.0–0.2 n 31 mean p 0.088 observed 0.355; 0.2–0.4 n 10
0.315 / 0.10; 0.4–0.6 n 3 0.443 / 0.00; 0.8–1.0 n 152 0.976 / 1.00. jev answers the literal question well; its low band
under-states paths in 11 of 31 cases (module paths the regex matches but the model did not count, or the reverse — the
label is a proxy).

### 3.3 Risk–coverage (train) and cost

| t | skipped | false accepts (verified-opportunity loss) | risk | Wilson 95 % | coverage | skipped that later regressed |
|---|---|---|---|---|---|---|
| 0.10 | 18 | 0 | 0.000 | 0–0.176 | 0.138 | 1 |
| 0.30 | 38 | 0 | 0.000 | 0–0.092 | 0.292 | 2 |
| 0.50 | 44 | 0 | 0.000 | 0–0.080 | 0.338 | 2 |
| 0.90 | 46 | 0 | 0.000 | 0–0.077 | 0.354 | 2 |
| 0.95 | 63 | 3 | 0.048 | 0.016–0.131 | 0.485 | 7 |

Cost: panel_review calls are recorded since 2026-10-06 (109 calls in the ledger window, kimi-k3 77/77 ok); tokens are
not recorded (tokens_in/out null) → **token savings UNKNOWN**; marginal € ≈ 0 (flat Ollama Max). At coverage c the rule
would avoid ≈ c of panel reviews (calls and kimi-k3 quota), against the false-accept column.

### 3.4 Threshold and holdout

Selection rule (§1.6) chose **t\* = 0.95** (largest coverage meeting ≤ 5 % point risk, Wilson upper ≤ 15 %, ≥ 10 skipped).

| Holdout at t\* = 0.95 | Value |
|---|---|
| skipped | 15 |
| false accepts (skipped, later verified) | 3 |
| selective risk | 0.200 (Wilson 0.070 – 0.452) |
| coverage | 0.312 (0.199 – 0.453) |
| skipped that later regressed | 1 |

**Verdict proposal_prescreen cascade: REJECT** (§1.8: holdout risk 0.20 > 0.10). Per the pre-registration this is final
for this study; no threshold is re-fitted on the holdout.

Descriptive (not a re-fit): all three holdout false accepts are proposals jev itself judged `yes` (names_file 0.98–0.99,
concrete 0.94, all gap_analysis). The max-coverage selection rule moved t\* to the grid edge, into jev's own accept band;
no holdout proposal with s < 0.94 verified. This is a hypothesis for a **new** pre-registered study on proposals created
after 2026-10-11 (rule R(0.3) = jev's own `no` band, fixed in advance), not evidence for a GO.

### 3.5 Operator labels (D5)

41 labelled `no` verdicts, 1 judged wrong: 2.4 % (Wilson 0.4 – 12.6 %). Labels exist only for `no` verdicts (selection
by design of the D5 queue), so they measure the precision of rejections, not the cascade's coverage trade-off.

## 4. Decisions

| Judgment | Decision | Key numbers | What it would take |
|---|---|---|---|
| proposal_prescreen (cascade skip-panel) | **REJECT** (this study) | holdout risk 0.20 (0.07–0.45) at t\* 0.95; train AUROC 0.76 (0.65–0.84) | new pre-registered study, fixed R(0.3), ≥ 15 skipped in a fresh holdout of post-11-10 proposals (~4–6 weeks at today's inflow) |
| checker_second_opinion | **REJECT** (policy: code gate; labels circular) | jev vs checker: yes/accepted 85, yes/insufficient_evidence 21, no/needs_revision 6, no/rejected 3, no/accepted 5, uncertain 5 | — (checker gate stays an oracle + LLM checker; F1 measured the checker directly) |
| risk_atomic | **REJECT** (policy: approval gate) | jev low / keyword low 111, uncertain/low 3 — no disagreement to learn from | — |
| auto_approve_shadow | **REJECT** (policy: approval) | — | — |
| discovery_relevance | **HOLD** | < 30 independent labels (operator lifecycle actions); 83 % uncertain | ≥ 30 operator relevance labels — a 'relevant / not' tap on /knowledge or Telegram triage |
| kb_passage_relevance | **HOLD** | no labels (enforce) | ≥ 30 labelled (proposal, page) pairs from panel reviewers or the operator |
| failure_cause | **HOLD** | off since 08-10; no join to outcome_attribution | label join (same subject id) + flag back on in shadow |
| reflection_triage, commons_idea, commons_contribution | **REJECT** | paths switched off; reflection 1/724 verified (no positive class) | — |

The paper's own limits apply directly: Djimitflo's critical decisions are code/logic (checker, gates, mutation score),
where the paper reports weak selective prediction; the one text-readable judgment with labels (prescreen) did not pass
its holdout.

## 5. Plan — shadow cascade router (only for GO judgments)

No judgment is GO, so no router is built. If a future pre-registered study reaches GO, the router is:
`CASCADE_JUDGE_MODE=off|shadow`; at the validated threshold it logs `would_accept` / `would_escalate` per subject, keeps
running the escalation judge (panel) anyway, records agreement between jev's accepted verdict and the panel, and
validates by a randomised A/B (subject-hash arm, ≥ the pre-registered n) before any act mode — an operator decision.
