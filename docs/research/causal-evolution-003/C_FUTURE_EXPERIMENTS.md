# CAUSAL-EVOLUTION-003 · C · Future experiments: design specifications

Conventions and source keys: `A_MECHANISM.md`. These are designs only. Each needs its own protocol, and that protocol's
sha256 must be committed before the first scored item, as SEC-F1 and MFR-001 did. GPU time, cloud spend and acting modes
are operator decisions. Nothing here touches the registered epoch-1 genome trial (PRE), the memory holdout, D5-NO or
JEV-114.

STR-001 **Stage A** is authorised and is being run by a sibling agent. It is not specified again here. Stage B below is
written so that it starts only after Stage A's registered readout and inherits Stage A's frozen definitions (prompt
sha, mutant families, scoring harness).

## 0. Rules that apply to every design below

| Topic | Rule |
|---|---|
| Confirmatory vs exploratory | Only the **primary** (and declared co-primary) estimands of a registered protocol are confirmatory. Every secondary, subgroup, post hoc or descriptive number is labelled **exploratory** in the readout and cannot change an operator decision on its own |
| Multiplicity | Within one protocol, Holm over the confirmatory family. Across protocols, no correction, because each protocol makes its own decision. A result is never pooled post hoc across protocols to rescue significance |
| Stopping | Fixed n with one look, or an anytime-valid e-process declared in advance (Ville, as `ePaired`). No "peek and extend" except a single pre-declared extension (×2) when INCONCLUSIVE |
| Non-promotion ≠ no effect | A null result from a design with power < 0.8 for the stated MCID is reported as **INSUFFICIENT_EVIDENCE**, never as "the mechanism does not work" (directive C) |
| Measurement | Any graded kill endpoint uses k ≥ 9 never-shown mutants per family (B §2.5: k = 3 gives reliability ≈ 0.5). Each family (seeded generator, Stryker) is a separate endpoint and is never averaged with the other. Mutant timeouts are reported as `skipped`, not as kills (B R11) |
| Evaluation contract | Same served model, worker hash, gate policy hash, base commit and target per pair. A mismatch invalidates the pair. Served model and worker hash are recorded per attempt; that needs the operator's OK, because it touches `gym-worker.mjs` / `remote-gym-service.ts` |
| Leakage | Held-out items never in the prompt (`assertNoLeak`), never on disk in the maker's tree (`assertPristine`), and never in any holdout epoch, TG-001 set or trial (`holdoutExclusions`). Items used here are added to the exclusion list afterwards |
| Size | Added lines, and kills per 100 added lines, are reported next to every quality endpoint |
| Planning SDs | Paired held-out kill difference: SD 0.346 at k = 3 (MFR-RA, EVO). Assumed 0.30 at k ≥ 9 (**HYPOTHESIS**; GR-REL-001 replaces it with a measured value) |
| Attempt cost | 9.6 min ≈ 0.16 GPU-h per atomic maker attempt on the workstation (MFR: 12.08 h for 80 runs, an upper bound) |

**Sample-size formula** (paired, two-sided): n = ((z₁₋α/2 + z₁₋β) · σ / Δ)².

## 1. GR-REL-001 · Reliability and family agreement of graded kill · exploratory → calibration

| Field | Specification |
|---|---|
| Why | Every later endpoint depends on it. B shows k = 3 reliability ≈ 0.50 [0.21, 0.74], and prod-set vs fresh agreement r 0.12 |
| Unit | one existing test file (MFR item R0 or R1) on its frozen base |
| Treatment / control | none. Measurement study: kill share on independent mutant sets |
| Outcome | kill share on (a) 12 fresh seeded-generator mutants split 6/6, (b) Stryker on the target |
| Estimands | parallel-forms ICC within the generator family (6 vs 6); cross-family correlation (generator vs Stryker); Spearman-Brown k for ICC 0.8 |
| Randomisation | mutant split by a seeded shuffle (MFR scheme, new salt) |
| Blocking | by target file |
| Power | n = 40 tests gives a 95 % CI of about [0.22, 0.70] around r = 0.5 (Fisher z). Enough to separate 0.5 from 0.8 |
| Stopping | fixed n |
| Multiplicity | none (estimation) |
| Generalisation | report exports vs test-gap separately once test-gap items exist |
| Budget | **0 GPU, 0 tokens.** CPU only. **Overlap:** STR-001 Stage A already re-scores R0/R1 on two families. GR-REL-001 must be a separately pre-registered **secondary analysis of Stage A's outputs**, registered before they are read. If Stage A's outputs do not store per-mutant results, the remaining CPU cost is ≈ 4–6 CPU-h |
| Decision use | sets k for every design below. If the cross-family r < 0.3, a single-family graded endpoint is not a valid fitness and the graded genome rule must not be enabled |

## 2. AA-001 · Gym noise floor (baseline vs baseline) · calibration

| Field | Specification |
|---|---|
| Why | It separates A's explanations C3/C5: is mutant-vs-parent discordance (19/320 = 5.9 %) larger than re-running the parent? |
| Unit | task (fresh mined + seeded-mutant tier 3–6 + failure-derived write_test). **Not** from any holdout epoch. Excluded afterwards |
| Treatment / control | genome `baseline` attempt 1 vs attempt 2 (identical contract) |
| Outcome | pass under prod gates (binary); graded kill on write_test tasks (k ≥ 9) |
| Estimands | A/A discordance rate; per-task ICC of pass; SD of A/A graded difference (the measurement-error floor for D) |
| Randomisation | attempt order randomised per task; both attempts on the same served model (recorded) |
| Blocking | task kind × tier |
| Power | 40 tasks × 2 attempts. The discordance rate has a 95 % CI half-width ≈ ±0.09 at p ≈ 0.1 (n 40). Enough to say whether 5.9 % is noise-level |
| Stopping | fixed n. Abort if > 20 % infra in the first 10 |
| Multiplicity | none |
| Generalisation | repeat 10 tasks across an environment change (runner or model) if one happens during the run, to estimate C8 |
| Budget | 80 attempts ≈ **13 GPU-h**, 0 tokens, ≈ 2 days inside the 40/day gym cap. **Runs only after the E0 readout** (GPU and gym-queue collision) |

## 3. STR-001 Stage B · Strengthen-assertions retry vs no retry vs compute-matched fresh attempt · confirmatory

Based on EVO EXPERIMENTS E1, with three changes: k ≥ 9 per family, Holm over two co-primaries, and blocking by species.

| Field | Specification |
|---|---|
| Unit | an exports-lane maker lease with graded < 1, created after the Stage A registration, rebuilt at its base (MFR harness) |
| Treatment | **R1**: one generic "strengthen the assertions" retry (Stage A's frozen prompt sha), 40 steps / 900 s |
| Controls | **R0**: no retry (the original test, deterministic). **R2**: a compute-matched fresh attempt (original task prompt, no existing test, same budget) |
| Outcome | kill share on k ≥ 9 never-shown mutants of (i) the seeded generator with a new seed salt and (ii) Stryker. Baseline-red rate. Added lines |
| Primary estimand | E[kill(R1) − kill(R0)] on family (i) and on family (ii) (two co-primaries) |
| Secondary | E[R1 − R2] (does retry context beat more compute?); kills per 100 added lines; baseline-red rate; timeouts |
| Randomisation | within item. R1 and R2 run order randomised by a seeded coin per item. R0 is deterministic |
| Blocking | maker species of the original lease (opencode / remote atomic); target file (≤ 2 items per file) |
| Power | Holm, α 0.025 for the first test, power 0.8. **Δ = 0.15: n = 51 at σ 0.346, or n = 38 at σ 0.30. Δ = 0.10: n = 86 at σ 0.30.** Supply ≈ 1.4 rebuildable items/day (EVO), so **≈ 30–40 days of accrual for Δ 0.15**. Δ 0.10 is not feasible before 15-12 |
| Stopping | fixed n = 51 (or the GR-REL σ-based n, whichever is larger, frozen at registration). One extension ×2 if INCONCLUSIVE. Abort on any held-out leak or > 20 % infra in the first 10 |
| Decision | **SUPPORTED** if both co-primaries have Holm-adjusted CI lower > 0, Δ ≥ 0.15 on at least one, and baseline-red ≤ 0.05. **FALSIFIED** if both CI upper bounds < 0.15 → NE entry. **Generator-specific** if (i) passes and (ii) fails, which stops any prod adoption. Else INCONCLUSIVE |
| Generalisation tests | (1) the Stryker family is never used in any prompt; (2) the test-gap lane as an out-of-lane check (exploratory); (3) species interaction (exploratory) |
| Budget | 2 maker runs × 51 items × 0.16 h ≈ **16 GPU-h**, 0 cloud tokens, ≈ 4–7 kWh (EVO energy basis). Scoring is CPU |
| Collision | GPU with E0 (serialise; E0 first). No prod population, no WIP slot. NE-013: allowed (nothing is shown) |

## 4. HF-001 · Harness factorial (model × harness × interaction × generalisation)

The design is EVO COEVOLUTION §3 unchanged (L9 over S, O, C, W × 2 router models; task-random-effects model; held-out
family and held-out combinations), with these amendments:

| Amendment | Why |
|---|---|
| graded co-primary at k ≥ 9 mutants per family instead of 3 | B §2.5 |
| **main effects confirmatory** (Holm over 4 harness factors + M), interactions and held-out-combination prediction **exploratory** | the 2-df interactions need about 4× the n for the same resolution |
| AA-001 replicate cells (the control configuration run twice on 20 tasks) | gives the within-cell noise floor, so a harness "effect" is compared with re-sampling |
| record served model and worker hash per attempt; a mismatch voids the pair | C8 |

| Field | Specification |
|---|---|
| Unit / estimand | (task, configuration). Main effect of each factor level on pass and graded kill, averaged over the other factors. Variance share of M vs H vs S |
| Power | Stage A main-effect MDE ≈ 12–15 pt (pass), ≈ 0.10 (graded) (EVO) |
| Budget | Stage A 360 attempts ≈ 58 GPU-h; Stage B (second model) +58 GPU-h; +20 attempts ≈ 3 GPU-h for the A/A cells; 0 tokens |
| Stopping | fixed n; abort on > 20 % infra in the first 20 |
| Order | after E0 settles and after AA-001 (HF Stage B swaps router models, which would invalidate E0 pairs) |
| What it decides | explanation C10 in A (capacity ceiling of M + H vs S-lines). If S's variance share is near 0 next to M/H, genome evolution on S is the wrong lever |

## 5. INH-001 · Inheritance causality test · confirmatory primary contrasts

Full design: `D_INHERITANCE_TEST.md`. Summary: 5 arms (static baseline; independently regenerated prompt; selected genome
without inheritance; selected genome with inheritance; randomly inherited genome), 3 generations, 42–95 independent
held-out tasks, a positive-control gate (INH-000), Holm over 3 primary contrasts, ≈ 155 GPU-h for one lineage and
≈ 224 GPU-h with a replicate lineage.

## 6. E0 · Registered epoch-1 genome trial (preserved, not changed)

Listed so its limits are on record next to the others. Nothing here alters it.

| Field | As registered (PRE) |
|---|---|
| Unit | frozen epoch-1 task; parent `baseline` vs `g-a187f81f` and `g-d14c1156`, paired |
| Decision | `DREAM_PROMOTION_RULE=both` on 40 mutant tasks (tiers 3–6) + mined net loss ≤ 1 |
| Power | ≈ 0.17–0.31 for a genome that fixes 20 % of parent failures (EVO) |
| Known threats | runner change across parent attempts; no served model / worker hash |
| How to read it | a non-promotion is **INSUFFICIENT_EVIDENCE**, not evidence of no effect (PRE). One validity check that is not an outcome look, and may be done after the readout: the share of VOID attempts now that `GENOME_FIRE_CHECK=true` (P7) |

## 7. SETTLE-PAIR · Discriminating retention endpoint · measurement

EVO E5, unchanged. Pair the settlement-execution kill share at +14 d with the maker-time graded score per settled PR
(today 0 pairs). Estimand: mean drift (kill_now − kill_maker) and the share of PRs with a negative drift. **Exploratory**
until ≥ 30 pairs exist. 0 GPU. It gives the merged-test niche-construction path its first possible negatives.

## 8. E-KB · Verify the only acting jev path · confirmatory (from JEV, unchanged)

≈ 188 blind-labelled (question, page) pairs: jev vs logged cosine cutoff vs keep-all. Non-inferiority margin 0.05, false
drop upper bound ≤ 0.15. 0 model tokens, ≈ 2 h of operator labelling. Its role in the utility analysis is in E.

## 9. Ranking by expected value of information per unit cost

EVI is judged qualitatively: how much the result would change a decision, divided by the cost. It is not a computed
number.

| Rank | Experiment | Decision it unlocks | Cost | EVI / cost |
|---|---|---|---|---|
| 1 | STR-001 Stage A (sibling, authorised) | whether the only positive operator signal (MFR-RA +0.317) survives a second family | 0 GPU, CPU-h | highest |
| 2 | GR-REL-001 (as a secondary analysis of Stage A) | the k for every graded endpoint; whether graded fitness is valid at all | ≈ 0 extra | very high |
| 3 | SETTLE-PAIR | whether merged tests keep their strength (the only L3 path) | 0 GPU, small builder | high |
| 4 | E-KB | keep or remove the only acting jev decision | ≈ 2 h operator | high |
| 5 | AA-001 + INH-000 positive control | whether the genome channel can carry any signal; gates INH-001 and the interpretation of E0 | ≈ 13 + 27 GPU-h | high |
| 6 | STR-001 Stage B | confirmatory adoption of the strengthening operator (shadow) | ≈ 16 GPU-h, 30–40 days | medium-high |
| 7 | E0 readout (registered) | the first promotion, if any | already running | low (power 0.17–0.31) |
| 8 | HF-001 | lever choice: M/H vs S | 58–116 GPU-h | medium |
| 9 | INH-001 | whether production inheritance is ever justified | 155–224 GPU-h | low until 5 passes |
