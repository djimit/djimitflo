# JEV opportunity matrix — DJIMIT-JEV-EVOLUTION-L3-001 (deliverable C)

DRAFT, design only. Evidence: `JEV_CAPABILITY_FORENSICS.md` (§ numbers below refer to it). Every row is either
**VERIFIED** (measured on prod data or a merged pre-registered study) or **HYPOTHESIS** (not measured; needs the
experiment named). Ranking = expected value of the *decision* it unlocks × evidence readiness ÷ (spend + risk to running
experiments). jev may appear only where the operator rule allows it (narrow, objectively verifiable, text-grounded, with
ground truth); every other class is ranked for its deterministic or human mechanism, and jev is listed as REJECT.

Decisions: ADOPT (do it; no model spend) · EXPERIMENT (needs operator authorization before any run) · RETAIN (keep as
is) · RETIRE (turn off / remove) · REJECT (do not build).

## 1. Ranked matrix

| Rank | ID | Opportunity | Evidence status | Decision | Spend | Collides with |
|---|---|---|---|---|---|---|
| 1 | O1 | Verify the **only acting** jev path: `kb_passage_relevance` (enforce, 88/452 passages dropped, no labels) against blind labels; jev vs logged cosine vs keep-all | VERIFIED that it acts unlabelled (§2 J10, §4.2); value HYPOTHESIS | **EXPERIMENT** (E-KB, zero model spend: both scores are already logged) | ~2 h operator labelling | none (not in any registered population; JEV-114 has 5 kb pairs, unaffected by labels) |
| 2 | O2 | Close the shadow side doors: `discovery_relevance` acting under `FRONTIER_UNITS_REQUIRE_RELEVANCE` without being in `GATE_READ_JUDGMENTS`; post-hoc `UPDATE judgments SET subject_*`; `threadGated` reading an `off` judgment's stale rows; `facts` missing from `input_digest` | VERIFIED in code + prod flags (§3, §6) | **ADOPT** (code hygiene; shadow-first, no jev call) | 0 | discovery pause #825 stays: no change to the pause, only to how a future verdict would be recorded |
| 3 | O3 | Stop paying for re-rolls: skip a jev call when an identical `(judgment, subject, state_hash)` already has a non-error row (prescreen per tick, failure_cause `uncertain` retry, decision_context) | VERIFIED: 192 identical-state re-judgments, 187 same decision (§4.3) | **ADOPT** for failure_cause and decision_context; **defer** for proposal_prescreen (D5-NO population) | 0 (saves ≈ 9 % of the calls of the six active judgments: 135 of 1 473 rows were identical-state re-judgments outside the prescreen) | D5-NO: prescreen dedupe changes how often rows are written for its population → after 2027-01-09 or with an operator amendment |
| 4 | O4 | Retire jev in forbidden domains: `checker_second_opinion` (code), `risk_atomic` (risk) | VERIFIED: policy (operator 11-10, JC-001 §4 "REJECT by policy"), allocator `NO_CONSUMER`, risk 213/216 uninformative | **RETIRE** — timing is the operator's (JEV-114 has 17 pairs on these two) | saves ≈ 795 k input tokens / 30 d (≈ 33 % of jev input) | JEV-114 agreement population (no ground-truth pairs come from these two, so its registered target is unaffected; the agreement estimate is) |
| 5 | O5 | `failure_cause` as a text-grounded log classifier, scored against DI-001 `MAKER_FAILURES.md` hand classes and a deterministic stderr-pattern classifier | HYPOTHESIS (72 % of rows below the confidence floor; no labels in DB) | **EXPERIMENT** (E-FC, offline, zero spend for jev arm: rows logged) | ~1–2 h labelling reconciliation | none (learner-only consumer) |
| 6 | O6 | IMG-001 "error shown?" Noul as a CI shadow visual check on dashboard screenshots | VERIFIED offline only: 34/34, Brier 0.001 (plan L1538-1541) | **EXPERIMENT** (E-IMG; needs a CI secret = operator) | ≈ 3 k input tokens per screenshot (102 k / 34); UNKNOWN USD | none |
| 7 | O7 | Discovery relevance reactivation | VERIFIED INSUFFICIENT (DI-001 relevance: 7 labels; 0 blind labels in prod) | **RETAIN pause**; reopen only through `RELEVANCE_EVOLUTION.md` §8 (κ ≥ 0.4, incremental value, acting consumer, cost ceiling) | labels only | #825 pause stays |
| 8 | O8 | `names_file` by jev | VERIFIED good (ECE 0.079, AUROC 0.959) but redundant: code computes the label exactly | **RETIRE the jev question** after D5-NO ends; meanwhile **RETAIN** (frozen prompt_version) | saves 1 of 4 prescreen questions | D5-NO (frozen questions), JEV-114 (names_file is its main GT source) |
| 9 | O9 | `decision_context` memory selection | HYPOTHESIS; 82 % select none; no consumer; memory holdout readout due 2026-10-27 | **RETAIN shadow** until the memory-holdout readout says memory injection matters; then EXPERIMENT (labels) or RETIRE | 0 now | memory holdout (EXP-3) — do not inject anything before its readout |
| 10 | O10 | `forecast:jev_calibrated` | VERIFIED no skill beyond prevalence (Brier 0.250 vs constant 0.2496) | **RETAIN as a zero-cost measurement, never decision-grade**; forecasting `verified` is a fitness quantity → never a gate | 0 (code, no call) | operator rule (fitness) |
| 11 | O11 | `commons_contribution`, `commons_idea`, `reflection_triage`, T1 local shadow | VERIFIED off / no input since 09-30; no ground truth | **RETIRE** (remove the `threadGated` dependency first, O2) | 0 | none |
| 12 | O12 | Price the ledger: record TypeSafe list price per call so `list_price_cost` stops being NULL | VERIFIED gap (2 543/2 543 NULL) | **ADOPT** (operator supplies the contract price; no call) | 0 | none |
| — | X-D | jev for **tool execution safety** (directive domain D) | — | **REJECT** (risk domain; jev "never a security boundary", `typesafe-client.ts:6-7`) | — | operator rule |
| — | X-E | jev for **model routing** (domain E) | — | **REJECT as authority**; at most a text-classification *feature* to a deterministic router, and only if a routed outcome label exists — none does today (`MODEL_SELECTOR_MODE=shadow`) | — | operator rule (routing decides fitness/promotion inputs) |
| — | X-P6 | jev for **evolutionary strategy selection** (P6) | — | **REJECT** (fitness) | — | operator rule |
| — | X-PS | Re-open a prescreen cascade / confidence router | — | **REJECT** (NE-001; `CASCADE_JUDGE_MODE` etc. forbidden by test) | — | NE-001, D5-NO |
| — | X-AA | jev in approval / auto-approve / auto-merge | — | **REJECT** (approval/promotion) | — | operator rule |

## 2. Hypotheses vs verified (explicit)

**Verified (can be cited as fact):**
- V1 jev answers literal, text-grounded questions well where a label exists (`names_file` AUROC 0.959; IMG-001 error-noul
  34/34). Both labels are cheap and deterministic or visual.
- V2 jev does **not** support routing on semantic quality (NE-001 holdout risk 0.20; DI-001 prescreen = accept-all,
  loss 1.000).
- V3 jev decisions are stable on identical input (97.4 %) but its probabilities are not bit-reproducible (max |Δp| 0.14).
- V4 Latency is not a constraint (p95 < 2 s since the limiter fix); money per call is UNKNOWN.
- V5 Of 10 jev judgments, 1 acts (unverified), 1 acted until paused, 0 show improved outcomes.

**Hypotheses (not established; each needs the named experiment):**
- H-KB (E-KB): jev's passage drops are mostly correct (false-drop rate ≤ 10 %) and better than a cosine cutoff at the
  same drop rate.
- H-FC (E-FC): jev's confident `failure_cause` agrees with hand labels at least as well as a deterministic stderr-pattern
  classifier.
- H-IMG (E-IMG): the visual error-noul catches broken pages in CI with ≤ 1 false alarm per 50 clean screenshots.
- H-DC (later): selected memories are relevant to the decision (only worth testing if EXP-3 shows memory helps).

## 3. Recommendation records

Each record: evidence · falsifiable hypothesis · success criterion · method · risk · rollback · decision.

**O1 — KB passage relevance.** Evidence: enforce in prod, 170 rows, 452 page verdicts, 88 dropped, no labels, allocator
VALUE_PROVEN only by `decision_consumed`. Hypothesis H-KB. Success: on ≥ 150 blind-labelled (question, page) pairs, jev's
false-drop rate upper 95 % bound ≤ 0.15 **and** jev's drop precision ≥ cosine-cutoff precision at the same drop rate
(paired McNemar, non-inferiority margin 0.05). Method: E-KB in the experiment plan. Risk: labelling burden; a negative
result removes a context filter from panel prompts (panel already received all pages before R2). Rollback: set
`TYPESAFE_KB_PASSAGE_RELEVANCE_MODE=shadow` (one env line; `gatePassages` then keeps every page, `kb-corpus.ts:110`).
Decision: **EXPERIMENT**; if H-KB fails → RETIRE enforce (shadow).

**O2 — side doors.** Evidence: §3, §6 of the forensics. Hypothesis: after the fix, every jev row a code path acts on is
classed `decision_consumed` by the allocator, and no judgment row changes identity after insert. Success: a test that
fails on today's code for each door (acting `discovery_relevance` not in `GATE_READ_JUDGMENTS`; `UPDATE judgments SET
subject_id`; `threadGated` with the judgment `off`; `input_digest` ignoring `facts`). Method: code + tests, shadow-first.
Risk: allocator reclassification changes its 30-d table (it is shadow, never applied). Rollback: revert the PR.
Decision: **ADOPT**.

**O3 — re-roll dedupe.** Evidence: §4.3. Hypothesis: skipping identical-state re-judgments loses no decision information
(identical input, same model) — falsified if > 5 % of skipped re-judgments would have changed a *consumed* decision.
Success: calls −5 % or more with 0 change in any consumed decision over 14 days (shadow comparison: log "would skip").
Method: shadow counter first, then act. Risk: losing the retry that rescues a transient `uncertain`. Rollback: flag off.
Decision: **ADOPT** (failure_cause, decision_context); prescreen after D5-NO.

**O4 — retire forbidden-domain shadows.** Evidence: operator rule; JC-001 §4; allocator `NO_CONSUMER`; κ(jev,outcome) 0.381
not enforce-eligible; risk_atomic uninformative. Hypothesis: nothing reads these rows for a decision (falsified by any
consumer found in code). Success: 0 consumers (verified: `JUDGMENT_CONSUMERS`, `effort-controller.ts:147, :153`, only
`honest-numbers` evidence). Method: set both modes `off` — **operator decision on timing** because JEV-114 pairs exist on
both. Risk: loses the checker-vs-jev κ evidence card. Rollback: env back to `shadow`. Decision: **RETIRE**.

**O5 — failure_cause.** Evidence: 194/269 rows below floor; cause mix; MAKER_FAILURES.md (213 failed leases, hand
classified). Hypothesis H-FC. Success: on ≥ 60 runs with a hand class, jev confident-cause accuracy ≥ deterministic
classifier accuracy − 0.05 and coverage ≥ 0.4. Method: E-FC. Risk: label mapping between MAKER_FAILURES classes and the
7-cause enum is lossy. Rollback: n/a (offline). Decision: **EXPERIMENT**; if it fails, replace with the deterministic
classifier and RETIRE the jev judgment.

**O6 — IMG-001.** Evidence: offline 34/34. Hypothesis H-IMG. Success: ≥ 50 clean + ≥ 10 seeded-broken screenshots, recall
≥ 0.9, false alarms ≤ 1/50 (Clopper-Pearson reported). Method: E-IMG, CI shadow only (never blocks a merge). Risk: CI
secret handling; vendor egress of screenshots (egress class `unknown` for api.typesafe.ai, `egress-classification.ts:20`).
Rollback: remove the CI step. Decision: **EXPERIMENT** (operator authorizes the secret and egress).

**O7–O12** follow the table; their evidence is in the forensics §2–§4 and they need no experiment.
