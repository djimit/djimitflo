# CAUSAL-EVOLUTION-003 · E · jev decision utility

Conventions and source keys: `A_MECHANISM.md`. The data are existing logs only. No new jev or LLM call was made. Most
numbers are JEV's (#961, snapshot 2026-10-22 ~19:50Z, the same build). I re-derived the decision logic from them, and I
add one new reading: the KB-relevance outcome linkage (P5). The class taxonomy is JEV's `DECISION_TAXONOMY.json`
(C01–C21). The D5-NO and JEV-114 populations are not analysed.

## 1. Answer first

| # | Conclusion | Tag |
|---|---|---|
| E-1 | **No jev decision has demonstrated positive expected utility.** 0 of 10 integrations shows an improved outcome (JEV L6 = 0). The one acting path (`kb_passage_relevance`) has no labels and no usable outcome link. | **VERIFIED** |
| E-2 | Seven judgments change no decision. Five are shadow or off with no consumer: `checker_second_opinion`, `risk_atomic`, `decision_context`, `reflection_triage`, and the two commons judgments (counted as one path). The other two are the prescreen (shadow, frozen, never parked) and `forecast:jev_calibrated` (code, zero marginal cost). For each one the expected decision utility is **−(inference cost)**, *whatever its accuracy*, because no decision changes. | **VERIFIED** (logic + JEV allocator `NO_CONSUMER` / 0 parks) |
| E-3 | The best-calibrated jev capability (`names_file`, ECE 0.079, AUROC 0.959) is **dominated** by the deterministic `namedPathsExist`, which computes the same label exactly at zero cost. `risk_atomic` agrees with the keyword classifier on 213/216 rows, so it carries **zero information** over the rule. | **VERIFIED** |
| E-4 | Three jev paths bear authority indirectly. **(i)** `kb_passage_relevance` (enforce) removes 19.5 % of KB pages from **approval-panel** prompts. **(ii)** `discovery_relevance` decided expert-unit creation, which the code calls "a promotion", until it was paused. Its `yes` rows still choose the knowledge titles that go into the **genome mutation prompt** (`dream-evolution.ts:177`). **(iii)** `failure_cause` feeds memory-candidate consolidation, which leads to memory promotion. | **VERIFIED** (code) |
| E-5 | Outcome linkage for the acting path cannot support a utility estimate. 31 of 38 `kb_passage_relevance` rows with decision `no` join to a proposal, against **5 of 132** rows with decision `yes`. A drop-vs-keep outcome comparison is not estimable. | **VERIFIED** (P5) |
| E-6 | Money per jev call is **UNKNOWN**: `list_price_cost` is NULL on 2 543/2 543 ledger rows. Latency is not a constraint (p50 234 ms, p95 1 855 ms). Neither low latency nor low token use is evidence of value (directive E). | **VERIFIED** |

## 2. The utility model (explicit, so each verdict can be checked)

For a decision path *j*:

EU(j) = Σ over decisions that *changed* because of jev [ V(right) · P(right) − C_FP · P(FP) − C_FN · P(FN) ] − C_inference
− C_latency − C_human − C_opportunity

**Consequences that need no price.**
1. If no consumer reads the verdict, the sum is empty and EU(j) = −(C_inference + C_opportunity) < 0. This holds at any
   accuracy.
2. If a deterministic rule produces the same decision, jev's marginal EU over the rule is −C_inference.
3. If the verdict acts and P(FP) / P(FN) are unmeasured, the sign of EU is **UNKNOWN**. It is not positive by default,
   and a gate reading it does not make it positive (JEV: the allocator's `VALUE_PROVEN` for KB relevance is
   `decision_consumed`, not outcome).

**Cost inputs (30 d, JEV §4.1).**
- Input tokens per judgment: `decision_context` 778 624, `checker_second_opinion` 650 354, `failure_cause` 335 097,
  `proposal_prescreen` 257 864, `kb_passage_relevance` 232 657, `risk_atomic` 145 021. Total ≈ 2.40 M.
- Tokens are estimated as `ceil(len/4)`, and `tokens_out` is always 0. € is UNKNOWN.

**Opportunity cost observed.** All jev calls share one limiter (6 in flight, queue 1 000). On 10-08 a single discovery
burst produced 288 `queue_full` failures for every judgment (JEV §4.1). So jev volume on one path did displace
decisions on others at least once. **VERIFIED.**

## 3. Per decision class and path

Accuracy and calibration are against the best available ground truth, named in each cell. "Rule" = a deterministic
alternative that exists today. "Local" = a local model. "LLM judge" = an existing LLM checker or panel.

| Class (taxonomy) | jev path | Mode / acts? | Accuracy vs ground truth | Calibration | FP / FN cost | Latency p50/p95 | Inference cost (30 d) | Downstream / human / opportunity | vs rule / local / LLM judge | Authority-bearing? | EU | Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C01 proposal approval (pre-panel) + C15 text properties | J1 `proposal_prescreen` | shadow, frozen by D5-NO; enforce window 10-09→10-12 wrote 21 × `yes`, **0 parks ever** | `names_file` vs PATH_RE AUROC 0.959; product of 3 Nouls vs `verified` AUC 0.683, Brier 0.322 (n 255, not calibrated); NE-001 holdout skip risk 0.20 [0.07, 0.45] | ECE 0.079 on names_file only | FN = a parked proposal that would have verified (a lost verified change); FP = panel + maker spend on a doomed proposal (≈ 0.63 M maker tokens per experiment from lineage 167.7 M / 266, P4) | 278 / 2 062 ms | 257 864 tokens | 56 operator labels; D5-NO frozen population | names_file: **dominated** by `namedPathsExist` (exact, free). Semantic part: no rule. Local: Clef ≈ jev (NE-005) | **yes** (a park is approval-adjacent) | realised: −cost. Potential: UNKNOWN (D5-NO decides; not analysed) | **MODIFY**: keep frozen until D5-NO ends (2027-01-09). Then retire the names_file question, and **REMOVE** the path unless D5-NO returns READY and a new pre-registered enforce study passes |
| C04 code review | J2 `checker_second_opinion` | shadow, no consumer | κ(jev, run outcome) 0.381 [0.17, 0.58]; agrees with the LLM checker 155/202; never `needs_revision` when the checker said `insufficient_evidence` (30 of 36 = accepted) | none | none realised | 1 493 / 4 646 ms | **650 354** tokens | none | LLM checker is validated (AUC 0.95, F1) and κ(checker, outcome) 0.318. jev adds no validated information | forbidden domain (code) | **−cost** | **REMOVE** (timing: operator, because of JEV-114 pairs) |
| C03 risk | J8 `risk_atomic` | shadow, no consumer | 213/216 identical to the keyword class on a test-only population | none | none realised | 288 / 995 ms | 145 021 tokens | none | **rule gives the same answer** | forbidden domain (risk) | **−cost** | **REMOVE** |
| C13 memory selection for decisions | J9 `decision_context` | shadow, no consumer | no labels; 82 % select none | none | none realised | 262 / 706 ms | **778 624** tokens (largest) | none | no rule; memory holdout pending (27-10) | would inject memories (approval-adjacent) if enforced | **−cost** | **REMOVE** (or pause) now. Reconsider only if the memory holdout shows that memory injection helps |
| C14 failure-cause diagnosis | J4 `failure_cause` | shadow; read by the learner (`consolidate` → `memory_candidates`) | no ground truth in DB; 72 % below the confidence floor; 72 identical-state re-rolls (3 changed the answer) | none | FP/FN = wrong cause → wrong memory candidate → panel-promoted rule in 70 % of maker prompts | 242 / 563 ms | 335 097 tokens | memory candidate review | deterministic stderr classifier exists (failure capture), but `stderr_source: none` is common (PLAN 22-10). Comparison UNKNOWN | **yes, indirectly** (feeds promotion) | **UNKNOWN**, likely ≤ 0 | **MODIFY**: dedupe identical-state re-rolls (JEV O3); run E-FC (JEV) against the stderr classifier; **REMOVE** if not better |
| C11 KB passage relevance (panel prompts) | J10 `kb_passage_relevance` | **enforce**: 88 of 452 pages dropped (19.5 %) | **no labels** | none | FP (keep irrelevant page) = longer panel prompt; FN (drop relevant page) = panel misses evidence → wrong approval. Both unmeasured | 227 / 343 ms | 232 657 tokens | E-KB ≈ 2 h operator | logged cosine cutoff is the untested rule baseline; keep-all = EU 0 by definition | **yes** (filters evidence for an approval decision) | **UNKNOWN** (E-5: outcome link not estimable) | **MODIFY**: move from enforce to shadow (keep-all) until E-KB passes (false-drop upper bound ≤ 0.15 and non-inferior to cosine). An operator flag change, not done here |
| C12 discovery relevance / expert-unit creation | J7 `discovery_relevance` | shadow-labelled **but acted** (unit creation under `FRONTIER_UNITS_REQUIRE_RELEVANCE=true`); paused since 10-14 (`DISCOVERY_RELEVANCE_PAUSED=true`, P7) | 83.6 % `uncertain`; 7 offline labels (INSUFFICIENT); 0 blind labels in prod | none | FP = an irrelevant unit admitted ("a promotion"); FN = a relevant paper lost | 3 851 / 228 296 ms (burst) | 0 since pause | 1 638 backlog rows | keyword gate exists (jev overrode it) | **yes** (admission/promotion), **and** an input to genome mutation (`dream-evolution.ts:177`) | **UNKNOWN**; side-door risk | **REMOVE authority**: keep paused. Any reopening is rank-only, with a deterministic rule deciding (JEV O7, DI-001 §8). Declare or remove its use as a mutation input (F) |
| C16 intake / Commons triage | J5 `commons_contribution`, J6 `commons_idea`, J3 `reflection_triage` | off / no input since 09-30; `threadGated` still reads J5's stale rows | none | none | stale rows gate threads (side door) | — | 0 now | none | — | J5: yes (a gate reads it) | **−maintenance**, side-door risk | **REMOVE** (fix the `threadGated` dependency first; F) |
| C17 proposal outcome forecasting | J13 `forecast:jev_calibrated` (code over J1 answers) | shadow | Brier 0.250 vs constant prevalence 0.2496 → **no skill** | histogram recalibration | none realised | — | 0 extra (code) | none | base-rate forecaster 0.317 | fitness quantity → never a gate | ≈ 0 | **RETAIN** as a zero-cost measurement; never decision-grade |
| (measurement) | J11 JEV-114 challenger | registered experiment (stop_by 2027-01-14) | in progress | — | — | 221 / 395 ms | 42 582 tokens | — | — | no | measurement | **RETAIN** to its stop date; not analysed here |
| (measurement) | J12 T1 local shadow | off since 09-30 | — | — | — | — | 0 | — | the only local-model comparison path; no comparison computed | no | 0 | **RETAIN off**. Remove the code if no comparison is planned |
| C21 visual UI error check | IMG-001 (offline only) | not in prod | 34/34, Brier 0.001 (offline) | good offline | FP = false CI alarm | — | ≈ 3 k tokens per screenshot | CI secret (operator) | no rule | no | UNKNOWN in prod | **EXPERIMENT** (E-IMG, JEV), shadow in CI |
| C02, C05–C10, C18–C20 | — | jev not used, or forbidden by rule | — | — | — | — | — | — | rules / humans / validated checkers | — | — | **RETAIN non-jev** (JEV) |

Sources: JEV §2, §4.1–4.3, §6 and the opportunity matrix; P5 for the linkage counts; P7 for flags.

## 4. jev against the alternatives, summarised

| Alternative | Where it was compared | Result | Tag |
|---|---|---|---|
| Deterministic rule | names_file (`namedPathsExist`), risk (keyword classifier) | rule is exact or identical → jev's marginal utility = −cost | VERIFIED |
| Deterministic rule | KB relevance (cosine cutoff), failure cause (stderr classifier) | **not compared** (needs E-KB, E-FC) | UNKNOWN |
| Local model | T1 local shadow (324 rows, 09-28→09-30, then off) | no comparison computed | UNKNOWN |
| Other small judge | Clef Flash (NE-005) | equivalent, not better | VERIFIED (REJECT) |
| Existing LLM judge | LLM checker vs jev second opinion | the checker is validated (AUC 0.95); jev's κ(outcome) 0.38 adds no validated information | VERIFIED |
| Confidence routing | prescreen cascade (NE-001) | holdout risk 0.20 → REJECT | FALSIFIED |

## 5. Net recommendation

- **RETAIN:** J11 (registered measurement), J13 (zero-cost measurement), J12 (off).
- **MODIFY:** J10 (enforce → shadow pending E-KB), J4 (dedupe + E-FC, else remove), J1 (frozen until D5-NO ends, then
  remove names_file and very likely the path), J7 (authority removed; rank-only if reopened; declare its mutation-input
  role).
- **REMOVE:** J2, J8, J9, J3, J5, J6. Together they account for ≈ 1.57 M of ≈ 2.40 M input tokens per 30 d (≈ 66 %),
  for zero decisions changed.
- **EXPERIMENT:** E-KB first (the only acting path; 0 tokens, ≈ 2 h labelling), then E-FC, then E-IMG.

Every change above is a flag change or a code change with failing-first tests. None is made here. Flag changes are the
operator's. The side doors (J5 `threadGated`, J7 bookkeeping) belong to Workstream F.
