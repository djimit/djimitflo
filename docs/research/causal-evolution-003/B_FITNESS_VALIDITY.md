# CAUSAL-EVOLUTION-003 · B · Fitness validity

Conventions and source keys: `A_MECHANISM.md`. The machine-readable matrix is `fitness-validity-matrix.json`. Every
number marked AN is reproduced by `python3 probes/analysis.py <mfr-001/results.json>`.

No new composite score is proposed. Where a metric is weak, this file says what it fails to measure and how to measure
that directly.

## 1. Answer first

| # | Conclusion | Tag |
|---|---|---|
| B-1 | In the exports lane, the **verified** label does not measure fault detection, and by construction it cannot. No gate on the verified path executes the new test against faulty code. `test:mutation:grounded` is a **no-op pass** outside the mutation lane (`scripts/mutation-gain.mjs:10-11`), and it shows `pass` on 57/57 graded exports/test-gap runs (AN B1). | **VERIFIED** |
| B-2 | The headline "verified 0.300 vs not verified 0.286" compares 50 tests with **7**. All 7 passed every deterministic gate. They were blocked by a reviewer's `insufficient_evidence` (6) or a failed security-checker lease (1). Δ = +0.014, 95 % CI [−0.215, +0.231], permutation p = 0.999. The minimum detectable difference is 0.35 on a 0–1 scale. The contrast is uninformative, not "barely positive". | **VERIFIED** (numbers) / **SUPPORTED** (interpretation: noise around a structural null) |
| B-3 | A selection effect hides the real "unverified" population. Graded scores exist only for makers that **passed their checks** (`graded-fitness.ts:113`). Tests that failed the gates are never graded: 21 exports `regressed` and 8 `infra_failed` maker leases since 08-10 (P1). | **VERIFIED** |
| B-4 | A k = 3 kill share is a noisy measurement. On two random, never-shown 3-mutant sets of the same test, parallel-forms reliability is r = 0.50 [0.21, 0.74] (original tests, n 40) and r = 0.57 [0.29, 0.79] (control retries, n 37). About half of the observed variance is noise. Reliability 0.8 needs ≈ 9–12 mutants (Spearman-Brown). | **SUPPORTED** (n 40; MFR items are exports-only) |
| B-5 | The prod graded set (the first 3 generated mutants) agrees even less with fresh mutants: r = 0.12 [−0.16, 0.41]. Part of that is range restriction (MFR selected prod graded < 1). Part may be generator order, i.e. which operators come first. | **SUPPORTED** / cause **UNKNOWN** |
| B-6 | The deterministic assertion-strength check (shadow) passes 54 of 54 graded tests with a verdict, including 21 of the 23 tests that kill **0 of 3** mutants (the other 2 have no verdict). At its pre-registered threshold it does not discriminate on this population. F1 showed the LLM checker accepts 3/7 `toBeDefined` weakenings. | **VERIFIED** |
| B-7 | Merge survival cannot fail (22 survived / 0 regressed). Settlement execution has 16 pass / 0 fail and **0** maker-time pairs. Neither measures regression resistance or downstream utility yet. | **VERIFIED** (P4) |
| B-8 | The gym proxy oracle does not predict the production gate: mined 0.867 vs 0.311, mutant 0.919 vs 0.395 (P4 `gym_prod_gates`). Proxy fitness is invalid for production capability. | **VERIFIED** |
| B-9 | The only proxies with an independent validation against planted items are the **verifiers**, not fitness: LLM checker AUC 0.875 → 0.95 (F1), security checker AUC 0.975 (SEC). | **VERIFIED** |

## 2. Why verified tests barely beat unverified ones (0.300 vs 0.286)

Seven checks. Each removes one possible reading.

### 2.1 What the verified path actually checks (code at `5dfc6cdb`)

| Step | What it executes | Does it test fault detection? | Evidence |
|---|---|---|---|
| `test:changed` | the changed tests on the **unmutated** target | no. A test that asserts nothing still passes | `package.json:19` |
| `lint`, `type-check` | static | no | — |
| `test:mutation:grounded` | Stryker gain only when `MUTATE_FILE`/`MUTATE_TEST` are set (mutation-gap lane). Otherwise it prints "skipped" and **exits 0** | no, outside the mutation lane. It is recorded as `pass` | `scripts/mutation-gain.mjs:10-11`; 57/57 `pass` on graded exports/test-gap runs (AN B1) |
| `test:assertion-strength` (shadow) | syntax: imports the target, ≥ 1 `expect`, weak-matcher share ≤ 0.5 | weakly, as a syntactic proxy. 54/54 pass | `test-assertion-strength.ts:14-30`; AN B1 |
| Gates (worktree, assignment, diff threshold, scope, auto-approved scope, objective scope, maker/checker separation) | process | no | `loop-verification-service.ts:39-43` |
| LLM checker | reads the diff | partly: it rejects gross defects (removed assertions, dropped import) and accepts 3/7 weak-matcher swaps | F1 |
| Security checker | reads the diff | no (another construct; AUC 0.975 for security) | SEC |

**VERIFIED.** On the exports lane no step runs the test against a fault. A null difference in fault detection between
verified and not-verified tests is therefore the expected result. It is not an anomaly.

### 2.2 Who the "not verified" tests are

| | n | mean graded | label | run status | reviewer verdicts |
|---|---|---|---|---|---|
| verified | 50 (48 exports, 2 test-gap) | 0.300 | verified | completed | accepted |
| not verified | 7 (all exports) | 0.286 | `regressed` | `blocked` | 6 × `insufficient_evidence` (checker or security checker), 1 × security checker lease failed |

Source: P1 → `data/graded-labels.json`; AN B1. **VERIFIED.** The 7 differ from the 50 only in a reviewer evidence
verdict, which does not judge assertion strength.

### 2.3 Selection into the graded population

`recordMakerGraded` grades only a maker lease with status `completed`, which means it passed its checks
(`graded-fitness.ts:113`). Since 08-10 (P1):

| Lane | graded | not graded |
|---|---|---|
| exports | 57 verified + 9 regressed (66) | 20 verified, 21 regressed, 8 infra, 1 needs-evidence; 2 baseline-red skips |
| mutation | 25 verified | 11 verified, 27 regressed, 15 infra, 5 no-change |
| test-gap | 3 verified | 8 verified, 2 regressed |

These counts are maker **leases**. `gradedVsLabels` keeps one deciding lease per run, which is why §2.2 has 7 not-verified
runs against 9 graded `regressed` leases here. The tests that fail gates, which are the ones a reader would call "unverified", are **never scored**. So the
comparison cannot show whether verification filters out weak tests. **VERIFIED.**

### 2.4 Power

Pooled SD 0.310, SE of the difference 0.125, so the MDE at α 0.05 two-sided and power 0.8 is **0.35** (AN B1). Any true
difference below about a third of the scale is invisible. **VERIFIED.**

### 2.5 Measurement error of the score itself

A test's kill share on 3 mutants is a binomial sample of its true kill probability. MFR-001 scored the same tests on
disjoint random mutant sets that were never shown to the maker:

| Pair of mutant sets | n | r | 95 % CI | Mutants for reliability 0.8 |
|---|---|---|---|---|
| original test, S vs H (two random fresh 3-sets) | 40 | 0.504 | [0.210, 0.740] | ≈ 12 |
| control-retried test, S vs H (S was never shown in the control arm) | 37 | 0.569 | [0.287, 0.794] | ≈ 9 |
| original test, P (prod's own graded set) vs H | 40 | 0.118 | [−0.155, 0.405] | n/a: range-restricted |

AN B2. **SUPPORTED.** The consequences:
1. Measurement error shrinks any correlation between a label and graded kill by a factor of about √0.5 ≈ 0.71.
2. A single prod graded score is a weak ranking signal for one test. That includes the graded contest, the graded
   genome rule, and the settlement kill share.
3. The low P-vs-H agreement suggests that the prod set's first 3 mutants are not exchangeable with later ones. Range
   restriction explains part of it, and the rest is **UNKNOWN** in cause: the mutant generator's ordering is a plausible source (`targetMutants`). It is the generator-
   family question STR-001 is designed to answer.

### 2.6 Lane mix and species

- **Lane mix does not explain it.** 48 of 50 verified and 7 of 7 not-verified rows are exports. The mutation lane has no
  not-verified graded row at all (21/21 verified), so `mutation_score` has no contrast. **VERIFIED.**
- **Species.** opencode: verified 0.296 (36) vs not verified 0.556 (3). Remote atomic: 0.309 (14) vs 0.083 (4). The
  sign flips by species and every cell has n ≤ 4: noise. **SUPPORTED.**

### 2.7 Size

corr(diff lines, graded) = 0.17 (n 57). MFR's control arm improved kill partly by writing more (median +206 vs +90
lines). Size is not normalised anywhere in prod fitness. **SUPPORTED.**

**Conclusion of §2.** The 0.300 vs 0.286 numbers carry no information about whether verification selects strong tests.
The structural reading is that verification is orthogonal to fault detection in the exports lane. That reading is
**VERIFIED from code** and **consistent with the data** (Δ +0.014 [−0.215, +0.231]). The cheap repair is to *measure*
fault detection where the decision is made (§6), not to re-weight the label.

## 3. Proxy → intended outcome (summary of `fitness-validity-matrix.json`)

Columns are the seven constructs from the directive. **Y** = measures it, **P** = partly or indirectly, **N** = no,
**?** = unknown.

| Proxy | Test execution success | Assertion strength | Mutation detection | Functional correctness | Generalisation | Regression resistance | Retained downstream utility | Acting? | Validity verdict |
|---|---|---|---|---|---|---|---|---|---|
| verified label | Y | N | N (exports) / P (mutation lane) | P (checker) | N | N | N | yes (bandit, merge) | **invalid** for test strength |
| `tests_lint_typecheck` gate | Y | N | N | N | N | N | N | yes | valid for execution only |
| `test:mutation:grounded` | N/A | N | **Y in mutation lane; vacuous pass elsewhere** | N | P (same family) | N | N | yes | **mislabelled** outside its lane |
| assertion-strength (shadow) | N | P (syntax) | N (54/54 pass incl. 21 zero-kill) | N | N | N | N | gates auto-merge eligibility | **non-discriminating** at 0.5 |
| graded kill k = 3 | P (baseline green) | P | **Y (one generator family)** | N | N (one family, k = 3) | N | N | shadow | valid construct, **unreliable** (r ≈ 0.5) |
| Stryker score (mutation lane) | P | P | Y (Stryker family) | N | P | N | N | gate in lane | valid; transfer to other families UNKNOWN |
| held-out fresh mutants (MFR harness) | P | P | Y | N | **Y (unseen items)** | N | N | offline | the best existing endpoint |
| gym prod-gated pass | Y | N | P (mutant repair) | P | N (proxy ≠ prod: 0.867 vs 0.311) | N | N | promotion gate | valid only for the gym task set |
| graded kill on gym write_test | P | P | Y | N | P | N | N | shadow | as graded kill |
| merge survival (14 d line retention) | N | N | N | N | N | **N (cannot fail: 22/0)** | P | Gate B, bandit (fitness view) | **invalid** as a learning label |
| settlement execution (re-run at +14 d) | Y | N | P (kill share, unpaired) | N | P | P | P | shadow | promising; 0 negatives, 0 pairs |
| outcome attribution | — | — | — | — | — | — | — | yes (filters losses) | a validity condition, not fitness; audited CAR 0 |
| panel / committee verdicts | N | N | N | P | N | N | N | yes (approval, memory) | Brier 0.33, 0/20 decision-grade (JEV, EVO) |
| LLM checker verdict | N | P (gross only) | N | P | N | N | N | yes | validated for gross defects (AUC 0.95) |
| security checker verdict | N | N | N | N (security) | N | N | N | yes | validated for its construct (AUC 0.975) |
| jev `forecast:jev_calibrated` | N | N | N | N | N | N | N | shadow | no skill (Brier 0.250 = prevalence) |
| hack flags / canaries | N | N | N | N | N | N | N | shadow | 0/163 flagged; 0/9 canaries passed. Sensitivity UNKNOWN (no planted hack) |

## 4. Measurement error per proxy (quantified where existing data allow)

| Proxy | Error source | Size | Tag |
|---|---|---|---|
| graded kill (k = 3) | binomial sampling of mutants | SEM ≈ 0.15–0.25 per score; reliability 0.50–0.57 | SUPPORTED (AN B2) |
| graded kill, prod set vs fresh | generator order or family | r 0.12 [−0.16, 0.41] | SUPPORTED |
| binary gym pass | task heterogeneity, run stochasticity | A/A discordance UNKNOWN (no replicate); genome-vs-parent discordance 19/320 = 5.9 % | UNKNOWN / VERIFIED |
| genome trial outcome | treatment delivery | fire check off for all 339 epoch-0 mutant attempts | VERIFIED (P7) |
| verified label | reviewer variance (`insufficient_evidence`) | 6/7 not-verified graded tests were reviewer evidence blocks | VERIFIED |
| attribution | classification of failure cause | operator audit CAR 0 (n small) | SUPPORTED (EVO) |
| € cost | missing prices | unknown share 0.4 | VERIFIED (P4 `ue`) |
| kWh | sampling coverage | 41.4 % | VERIFIED (P4 `ue`) |
| fidelity of offline rebuild | environment | 41/42 prod kills reproduced | VERIFIED (MFR) |

## 5. Reward-hacking openings

**Observed** = seen in data. **Open** = reachable in code, not observed. None is reported as exploited unless stated.

| # | Opening | Where | Status | Mitigation that exists / is missing | Tag |
|---|---|---|---|---|---|
| R1 | Teaching to the oracle: a maker shown the scoring mutants writes narrow assertions for them | MFR | **observed** (shown 0.81, held-out 0.325 vs 0.467) | NE-013 forbids `MFR_001_MODE`. Held-out split asserted (`assertNoLeak`) | FALSIFIED as safe → closed |
| R2 | Vacuous `pass` of `test:mutation:grounded` outside the mutation lane reads as "mutation gate passed" | `scripts/mutation-gain.mjs:10-11` | observed as a label (57/57) | missing: record `skipped`, not `pass` | VERIFIED |
| R3 | Weak-matcher tests pass the assertion-strength check by mixing strong matchers on trivial values (threshold: weak share ≤ 0.5) | `test-assertion-strength.ts:30` | open. 21 zero-kill tests pass it | missing: an executed check (kill share) in the gate | VERIFIED (open) |
| R4 | Bigger tests buy kill share. Size is not normalised | graded fitness, contest | open (corr 0.17; MFR +194 lines) | report kills per added line next to Q (EVO FITNESS §6.6) | SUPPORTED |
| R5 | Fixed mutant generator family: a maker or genome tuned to one operator family | `targetMutants` | open. P-vs-H r 0.12 hints the families are not exchangeable | a second family (Stryker) as co-primary (STR-001) | HYPOTHESIS |
| R6 | Retention that cannot fail rewards anything merged | `merge-survival.ts` | observed (22/0) | settlement execution, once paired | VERIFIED |
| R7 | The bandit rewards species whose diffs satisfy reviewers (`verified`), not species that write strong tests | `runtime-bandit.ts:41-43` | open | graded Q as a bandit input (shadow first) | VERIFIED (open) |
| R8 | Gym proxy oracle easier than prod gates | `gym_prod_gates` | observed (0.867 vs 0.311) | `GYM_PROD_GATES=true` + `ELIGIBLE_GATED` (P7) | VERIFIED (mitigated for promotion) |
| R9 | The genome guard is a regex. A semantic paraphrase ("keep the change minimal, finish fast") is allowed and could trade correctness for pass rate on repair tasks | `dream-evolution.ts:151` | open | mined no-regression check, out-of-scope count | HYPOTHESIS |
| R10 | Memory rules promoted by LLM panel consensus, not by outcome | `memory-candidate-review-scheduler.ts:21-22` | open | registered holdout 27-10; freeze rule G3.3 (EVO) | VERIFIED (open) |
| R11 | Timeouts are handled differently. The prod kill-share step returns `skipped` on any timeout (`graded-fitness.ts:57-60, 83-90`), so there is no score. The MFR-001 harness and the STR-001 Stage A protocol (#966, protocol line 61: "red or hung counts as killed, as in graded-fitness") count a hung mutant run as a kill | code vs protocols | open in the offline harnesses: a slow test near the 180 s cap can gain kills. The parity claim in the STR-001 protocol does not match prod code | future harnesses: report the count of hung-mutant kills next to the kill share. I do not ask for STR-001 to be amended after registration | VERIFIED (asymmetry) |
| R12 | Treatment non-delivery reads as "no effect" | genome trials | observed: fire check off for every settled trial | `GENOME_FIRE_CHECK=true` now (P7) | VERIFIED |

## 6. What to measure instead (no composite; fix the measurements)

These are smallest-change proposals. None is built here, and acting modes are the operator's.

1. **Report `skipped` for `test:mutation:grounded`** when it is a no-op, so no check list shows a vacuous pass (R2).
   Code: one line in `scripts/mutation-gain.mjs` plus how the check status is recorded. Shadow-safe, because the gate
   outcome is unchanged.
2. **Raise k for any decision that reads graded kill** to ≥ 9 mutants (≥ 12 preferred), drawn from two families
   (generator + Stryker). Report each family separately and never average them into one number. Spearman-Brown says
   reliability ≈ 0.8 at 9–12 mutants. CPU cost is linear: about 4× today's 120 s budget per maker.
   **HYPOTHESIS** until measured on prod tests (GR-REL-001, C §1).
3. **Pair settlement kill share with maker-time scores** (EVO E5) so R produces negatives on an executed basis.
4. **Grade the failed makers' tests too** (where a test file exists and the baseline is green). That makes "verified vs
   unverified" a real comparison of what the gates filter (B-3).
5. **Report size next to Q** (kills per 100 added lines).
6. Keep the lexicographic design from EVO FITNESS §3: eligibility filters, then a Pareto set on (held-out Q, cost). No
   weighted sum.
