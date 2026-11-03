# EVOLUTION-001 · 3 · Fitness F = (Q, R, A, N, E, C)

Conventions and source keys: file 1.

**Reading of the letters (assumption).**

| Letter | Meaning |
|---|---|
| Q | quality of the produced change, measured by execution |
| R | retention / robustness after merge and on held-out items |
| A | autonomy cost (human attention per outcome) |
| N | novelty / niche coverage |
| E | efficiency (tokens, GPU-h, kWh, €, wall time) |
| C | compliance (hard constraints) |

Attribution, meaning which component the outcome is credited to, is not a seventh component. It is a validity condition on all six:
an outcome with the wrong attribution is noise in every component.

## 1. Components mapped to existing signals

| | Existing signal | Source | Can it fail? | Independent of candidate claims? | Current value (prod) | Level | Tag |
|---|---|---|---|---|---|---|---|
| **Q** | graded mutant kill (`mutant_kill`), Stryker `mutation_score`, `tests_green` | `graded-fitness.ts` (shadow), mutant keys served server-side | yes | yes (server-counted kills, #710) | prod exports mean 0.283, 9 % full kill (n 66); mutation 0.888 (n 25) (EE `graded`) | L2 | FACT |
| Q | verified (all gates + checkers) | loop verification | yes | yes for gates; checkers validated (F1 0.95, SEC 0.975) | 120 verified / 30 d (EE `ue`) | L3 | FACT |
| Q | **verified vs graded** | `gradedVsLabels` | — | — | verified mean 0.300 vs not verified 0.286 on mutant_kill (n 50 / 7) | — | FACT |
| **R** | merge survival (≥ 50 % added lines at +14 d) | `merge-survival.ts:21` | **practically no** | yes | 22/22 survived, 0 regressed; Gate B red (EE) | L2 | FACT |
| R | settlement execution (re-run on main + fresh-mutant kill share) | `settlement-execution.ts` (shadow) | yes in principle | yes | 16 pass / 0 fail; kill share now 0.40 (n 15), maker-time pairs 0 (EE) | L1 | FACT |
| R | held-out generalisation (fresh mutants never shown) | MFR harness, gym holdouts | yes | yes | MFR: discriminated F vs C (Δ −0.142) | L3 (offline) | FACT |
| **A** | operator waiting / handling minutes per surviving change | `unit-economics.ts` | — | yes | 285 waiting + ≈ 14 handling (estimate) per surviving (EE `ue`) | L2 | FACT |
| **N** | new task types × repos with an executed verifier | lane registry, `EXTRA_REPOS` | — | — | 1 task type, 1 repo; finding-fix shadow, 0 proposals | L1 | FACT |
| **E** | tokens per verified, GPU-h, kWh, € | resource ledger, `unit-economics.ts` | — | yes for tokens/power samples | opencode 1.29 M tokens / verified (L3v2); € ≥ 2.19 per verified, ≥ 11.96 per surviving (unknown share 0.4); kWh coverage 41.3 % | L2 | FACT |
| **C** | gates, security checker, scope, diff limit, policy violations, hack flags, canaries | verification + gym | yes | yes | canaries 0/9 passed; hack flags 0/163 (EE `hack_rate`); 10 shadow policy violations (S1) | L3 | FACT |

**Conclusions (FACT / INFERENCE).**
- **Q** is the only component that is both discriminating and independent. It is computed on every test-writing run and
  read by nothing.
- **R** in its acting form (line retention) cannot fail. Its executed form (settlement execution) has produced no negative
  yet.
- **INFERENCE:** the "verified" label carries no information about test strength. Selecting on it, as the bandit and
  D6 do, optimises gate passing, not defect detection.

## 2. Hard eligibility constraints (filters, never weights)

A candidate that fails any of these is **ineligible**: it gets no fitness and is not a loss either. A weight would let a
large Q buy back a violation. A filter cannot.

| # | Constraint | Existing enforcement | Tag |
|---|---|---|---|
| H1 | All production gates pass (tests, lint, type-check, mutation gain, diff/scope); gym attempts gated (`GYM_PROD_GATES`) | loop verification; `gatedEvidence` ELIGIBLE_* (`dream-evolution.ts:443-475`) | FACT |
| H2 | Security checker not rejecting; changed-files risk honoured (#947) | `verifyLoopRun` | FACT |
| H3 | Candidate cannot touch its evaluator: no gate/check/scope/secret/test-editing lines in genomes (`guardLines`, `dream-evolution.ts:154`); oracle files absent from the maker's worktree (MFR `assertPristine`) | code | FACT |
| H4 | Held-out items never shown; fresh seeds; epoch not exhausted (`genome-promotion.ts` strict `holdoutValidity`) | code | FACT |
| H5 | Canary integrity: any passed canary voids the batch | `GYM_CANARY_RATE=0.05`; 0/9 passed | FACT |
| H6 | Non-maker failures excluded, not counted as losses (attribution) | `OUTCOME_ATTRIBUTION_ENABLED=true` | FACT |
| H7 | Baseline green: the new test passes on the unmutated target | MFR classes, graded machinery | FACT |
| H8 | No NE-forbidden pattern (e.g. `MFR_001_MODE`) | `NE_GENERATOR_CHECK_MODE=shadow` (not enforcing) | FACT |
| H9 | Same evaluation contract per pair: same epoch, gate policy, task family, **and same served model and worker**. The last two are not recorded today (file 2 §4) | partly | FACT (gap) |

## 3. Pareto, weighted, or lexicographic?

**Recommendation: lexicographic eligibility → Pareto on (Q_heldout, E) inside a niche → R as delayed confirmation → A
and N reported, not optimised.** No weighted scalar yet.

Why (INFERENCE from the facts above):
1. **No component weight can be validated today.** R is constant, A is an estimate, N is 1, and € has 40 % unknown
   share. A weighted sum would hide that most of its terms are uninformative.
2. **The existing weighted view already shows the failure mode.** `fitness-view.ts` weights production 1, gym 0.25 (capped
   at 5 pseudo-observations) and merge 3. Merge outcomes are 21/25 successes for opencode with no regressions (S1), so
   weight 3 multiplies certainty without adding information. The OPE of that view vs the bandit is +0.0018
   [−0.0112, 0.0144] (EE).
3. **A Pareto front on two measured axes is honest at small n.** Q_heldout vs tokens (or GPU-minutes) per attempt is
   measured per item. It stays interpretable when one axis has wide CIs.
4. **R becomes a primary axis only after it produces negatives.** Settlement execution must show ≥ 8 failures before Gate B
   could be green on it (same "≥ 8 per class" logic, `evolution-evidence.ts:386`). The operator's 13-10 condition
   ("Gate B stays red until genuine verified evidence") stands.

## 4. MAP-Elites / quality-diversity: value at the current n

| Niche axis available today | Levels with data | Supply | Tag |
|---|---|---|---|
| lane | exports, mutation, test-gap | ≈ 4.5 oracle goals / day in total (ACE protocol) | FACT |
| species | opencode, remote atomic | bandit share 0.8 to remote cap | FACT |
| repo | 1 (djimitflo) | second repo waits on an operator token | FACT |
| gym task kind × tier | mined, mutant tiers 1–6, write_test | ≤ 40 gym attempts / day (cap) | FACT |

- **Prod archive.** 3 lanes × 2 species = 6 cells. At ≈ 4.5 goals a day, a cell gets ≈ 0.75 outcomes a day. Comparing two
  variants in one cell at 20-pt resolution needs ≈ 94 per variant (ACE power table), which is **≈ 4 months per cell**.
  **INFERENCE:** MAP-Elites over prod niches cannot select anything within the planning horizon (to 15-12).
- **Gym archive.** 40 attempts a day could fill tier × kind cells, but gym fitness does not transfer (mined proxy 0.867 vs
  prod gate 0.311; TG-001 inconclusive). An elite in a gym cell would be an elite of the proxy.
- **Verdict.** No QD archive now. The smallest QD-like step that the evidence would support is **one active genome per lane**,
  and only after a first promotion (file 7, stage 3). HYPOTHESIS.

## 5. Statistical power of each component at today's n

| Component as an endpoint | Variance source | n for a useful effect | Feasible? | Tag |
|---|---|---|---|---|
| Q held-out kill, paired within item | MFR-RA paired SD 0.346 | 42 pairs for +0.15; 94 for +0.10 (α 0.05 two-sided, power 0.8) | **yes**, offline (supply ≈ 1.4 rebuildable exports items/day) | FACT (SD) / INFERENCE (n) |
| verified rate, two arms | p₀ 0.44 | 94 per arm for +20 pt | slow (≈ 6–7 weeks per experiment, shared population) | FACT (ACE) |
| genome trial, McNemar on 10 deciding tasks | discordant pairs | power ≤ 0.09 even if the mutant fixes 50 % of parent failures (file 6 E0) | **no** | INFERENCE (exact computation) |
| genome trial on 40 deciding tasks | | power 0.17–0.31 at q = 0.2; 0.45–0.66 at q = 0.3 | marginal | INFERENCE |
| merge survival | ceiling | not estimable | no | FACT |
| settlement execution kill-share drift | unknown until paired (n_paired 0) | UNKNOWN | UNKNOWN | FACT |

## 6. Anti-gaming: fitness must be independent of the candidate's own claims

**NE-013 lesson (FACT, MFR).** When the maker was shown the oracle's items, shown-mutant kill rose to 0.81. Held-out kill
fell: 0.325 vs 0.467 for a generic instruction. Any fitness signal that the candidate can see becomes a target. A held-out set
is the only thing that exposed it.

Rules derived from that lesson and from existing code:

1. **Never show the scoring items.** Feedback may describe a failure class, never the specific mutants/tests that score it
   (NE-013 `allowed_follow_up`). The held-out split is asserted in the harness, not trusted (`assertNoLeak`).
2. **Score server-side from served keys.** Kills are counted from the mutant keys the server served (#710), and settlement
   re-runs on `origin/main` (`settlement-execution.ts`). Worker-reported success is not fitness (L3v2 §3d gap 8).
3. **Cross-family oracle.** Score Q with a second mutation family as well as `targetMutants`. Stryker is already pinned
   (`scripts/mutation-gain.mjs`, MCP rec 4). A candidate tuned to one operator family shows up as a gap between the two.
4. **Rotate and count looks.** Holdout epochs are consumable (`holdout_exposure.reuse_risk`, limit 10). Epoch 0 is
   exposed (261 mined and 140 mutant evaluations). Epoch 1 is fresh (80 mined, 0 mutant).
5. **No LLM-judged fitness.** jev is never a fitness source (charter). The paper's behavioural metrics are judged by an
   LLM (file 4). Djimitflo should not copy that.
6. **Report the size of the change next to Q.** MFR CONTROL improved kill partly by writing 2.3× more lines (206 vs 90
   median). Kill per added line, or test runtime, keeps "bigger" from posing as "better".
7. **Promotion only through `promoteGenome()`** (single boundary, `genome-promotion.ts`), never by a candidate's own
   report.
