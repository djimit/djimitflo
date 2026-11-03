# EVOLUTION-001 · 6 · Prioritised falsifiable experiments

Conventions and source keys: file 1. These are designs only. Each needs its own protocol, with its sha committed before the
first scored item (SEC-F1 / MFR-001 practice). Spending and acting modes are operator decisions.

**Prioritisation.** Expected information gain on "can Djimitflo show heritable, controlled improvement?" ÷ cost, with
collision risk as a tie-breaker. GPU-h are workstation R9700 hours. € is UNKNOWN for kWh (no tariff in
`docs/usage-plan-limits.json`) and ≈ 0 marginal for flat subscriptions until a limit is hit.

## MFR-001 already ran (the directive asked to prioritise it)

**FACT (MFR, NE-013).** MFR-001 ran 21–22-10 offline and was **FALSIFIED**.
- Showing surviving mutants made held-out kill *worse*: 0.325 vs 0.467, Δ −0.142, 95 % CI [−0.250, −0.033], n 40 pairs.
- 0 cloud tokens, ≤ 12.1 GPU-h, 0 prod writes.

**What it implies.**
1. **FACT.** Feedback built from the oracle's own items overfits: shown-mutant kill was 0.81 vs 0.53.
2. **FACT (MFR-RA, post hoc, not registered).** The *control* arm, a generic "strengthen the assertions" retry, raised
   held-out kill over the original test.
   - 0.150 → 0.467, +0.317 [0.217, 0.425].
   - 23 items better, 0 worse, 17 equal.
3. **INFERENCE.** The no-retry counterfactual is the original test itself, and it is deterministic. So that +0.317 is not
   regression to the mean. It is still unregistered, it is scored with the same mutant generator family, and the tests
   grew a lot (median +194 lines, p90 +350).

**The open lever is "generic strengthen retry vs no retry"** (E1), not any form of oracle feedback.

---

## E0 · P0 · Epoch-1 genome trial: validity repair, then readout

| Field | Design |
|---|---|
| Status | **running** since 22-10 11:26Z. Trial genomes `g-a187f81f` (strategy lines citing expert units) and `g-d14c1156` (lane playbook) |
| Facts found (S1, S2, S6, EE) | (1) The parent has 35 of 40 epoch-1 **mined** tasks scored under prod gates: **12 pass / 23 fail**, pass rate 0.34. That is the first parent with headroom in any trial. (2) `DREAM_TRIAL_MUTANTS=true`, so the deciding set is the **mutant** holdout. Epoch 1 froze 40 mutants at **tiers 3, 4, 5, 6 (10 each)**. `DREAM_TRIAL_MUTANT_TIERS` is unset, and the default is `2,3` (`genome-registry.ts:112-114`). **So only the 10 tier-3 tasks decide.** 0 mutant-holdout evaluations so far. (3) `DREAM_PROMOTION_RULE=both` needs ≥ 5 net discordant wins. (4) 21 of 35 parent attempts ran on 17–18-10, before the D9 hardened runner (22-10). Gym attempts record **no served model and no worker hash** (S5) |
| Unit / control | task; parent `baseline` vs each mutant, paired on the same frozen task |
| Endpoint | the registered rule: paired McNemar ∧ e-process on deciding tasks; mined no-regression; out-of-scope. Secondary (shadow columns): graded `tests_green` paired permutation |
| Power (exact, my computation with the McNemar rule; loss rate 0.05) | **10 deciding tasks, f = 6 parent failures: power 0.000 / 0.001 / 0.009 / 0.089** for mutant fix rates q = 0.1 / 0.2 / 0.3 / 0.5. With f ≤ 4 the trial is blind. **40 deciding tasks, f = 20–24: 0.02–0.04 / 0.17–0.31 / 0.45–0.66 / 0.89–0.98** |
| Repair (operator decisions, before the first mutant-holdout attempt) | (a) Set `DREAM_TRIAL_MUTANT_TIERS=3,4,5,6`. The code comment says "change only between trials". No deciding attempt has run, so the operator may also settle both trials INCONCLUSIVE and restart them with the flag set. (b) Pre-register the readout: rule, deciding set, and a statement that the parent's mined attempts span two runner versions. (c) Record served model + worker hash per attempt (file 2 §4; touches `gym-worker.mjs` / `remote-gym-service.ts`, so it needs explicit operator OK) |
| Budget | parent 40 mutant tasks + 2 genomes × (40 mutant + 40 mined) ≈ 200 attempts × ≈ 9.6 min ≈ **32 GPU-h**, 0 cloud tokens, inside the 40/day gym cap → readout ≈ 28–29-10 (INFERENCE from 15 attempts per 6 h on 22-10) |
| Stopping | registered rule; ≤ 1 promotion a day; **INVALID** if the served model changes mid-trial. Not detectable today → state it as UNKNOWN in the readout |
| Collision | HF-001 Stage B (model swap on the same router) must wait; STR-001 / SP-001 offline runs share the GPU (yield as MFR did); TG-001 extension (gym) |
| Falsifier | if both trials settle `retired`/`inconclusive` on a **powered** (40-task) deciding set, the dream S-gene does not move prod-gated repair on epoch 1 → evidence against Stage 2 of file 7 |

## E1 · P1 · STR-001: strengthen-assertions retry vs no retry (post-MFR)

**Hypothesis.** For an exports-lane test with graded < 1, one generic "strengthen the assertions" retry:
- raises the kill rate on mutants it never saw, **including a different mutation family**;
- has acceptable baseline-red and size cost;
- is better than spending the same budget on a fresh attempt.

**Stage A: pre-registered re-scoring of existing MFR outputs (CPU only)**

| Field | Design |
|---|---|
| Items | the 40 scored MFR items: R0 = original test, R1 = the CONTROL retried test (both stored in `mfr-001/results.json`) |
| New endpoints, never computed before | (i) kill share on **H2**, 6 further `targetMutants`, disjoint from P, S and H; (ii) **Stryker** kill share on the target (pinned StrykerJS, `scripts/mutation-gain.mjs`), a different operator family; (iii) flake check (3 re-runs) |
| Decision | CONFIRMED if R1−R0 on H2 ≥ +0.15 with CI lower > 0 **and** the Stryker difference has CI lower > 0. H2 only → "generator-specific", stop. Otherwise NOT CONFIRMED |
| Budget | 0 maker runs, 0 GPU, 0 tokens; ≈ 3–6 CPU-h on the workstation |
| Limit (stated in the prereg) | the analyst has seen MFR's results; protection comes from the new endpoints and the pre-registration only |

**Stage B: confirmatory, on fresh items**

| Field | Design |
|---|---|
| Unit | an exports-lane maker lease with graded < 1 created **after 21-10 21:39Z** (post-MFR), rebuilt at its base (MFR harness) |
| Arms (within item) | **R0** no retry (the original test, deterministic); **R1** strengthen retry (MFR CONTROL prompt template, frozen sha); **R2** compute-matched fresh attempt (same budget: 40 steps / 900 s; original task prompt, no existing test) |
| Primary | R1 − R0 held-out kill (k = 3 fresh mutants, never shown; `assertNoLeak`) |
| Co-primary | R1 − R0 Stryker kill share |
| Secondary | R1 − R2 (retry context vs extra compute); baseline-red; timeouts; added lines; kills per 100 added lines; test runtime |
| n / power | **42 items** for +0.15 at power 0.8, α 0.05 two-sided, from MFR-RA paired SD 0.346. Supply ≈ 1.4 rebuildable items/day → **≈ 30 days** of accrual |
| Budget | 2 maker runs per item × 9.6 min × 42 ≈ **13.4 GPU-h**; 0 cloud tokens. An optional opencode species would be ≈ 34 M tokens (operator spend; not recommended on the weekly-limited plan) |
| Decision | SUPPORTED: Δ ≥ +0.15, CI lower > 0, Stryker CI lower > 0, baseline-red ≤ 0.05. FALSIFIED: CI upper < +0.15 → NE entry. Else INCONCLUSIVE; extend once to 84 |
| If SUPPORTED | Phase 2 = a shadow flag on the existing retry path, admitted only at WIP ≤ 4 (operator). Never `MFR_001_MODE` (NE-013) |
| Abort | > 20 % infra in the first 10; any held-out leak; yield to prod remote jobs and to the E0 trial; never load a different router model |
| Collision | NE-013: none. Its `allowed_follow_up` leaves the generic form open, and nothing is shown. GPU with E0 (serialise). No prod goal or WIP slot |

## E2 · P2 · HF-001: harness factorial (model × harness × interaction × generalisation)

Full design in file 4 §3.

| Field | Design |
|---|---|
| Unit / control | (task, configuration); L9 orthogonal array over S, O, C, W × M (2 router models); control = prod-remote-like configuration (S1, C0, W1) |
| Endpoint | pass under prod gates; graded kill on `write_test`; held-out family and held-out combinations |
| Power | Stage A main-effect MDE ≈ 12–15 pt (pass), ≈ 0.10 (graded) |
| Budget | Stage A 360 attempts ≈ **58 GPU-h**; Stage B + 58 GPU-h; 0 tokens |
| Stopping | fixed n; abort on > 20 % infra in the first 20 |
| Collision | Stage B only after E0 settles; proposes closing TG-001 INCONCLUSIVE (its next step is W0 vs W1 here) |

## E3 · P3 · SP-001: speciation / specialists across lanes

**Hypothesis.** The two maker species specialise: the species × lane interaction on graded quality is ≠ 0.

**Observational hint (confounded by bandit assignment and siblings).**

| Lane | Verified, opencode | Verified, remote atomic | Graded, opencode | Graded, remote |
|---|---|---|---|---|
| exports | 56/114 | 16/54 | 0.313 | 0.187 |
| mutation | 25/78 | 7/26 | 0.903 | 0.862 |

Sources: S1, S3.

| Field | Design |
|---|---|
| Why offline | a prod randomisation gets ≈ 0.75 goals/day per lane × species cell, so a 20-pt interaction takes ≈ 4 months. Not feasible before 15-12 (INFERENCE) |
| Unit | frozen task per lane (exports `write_test` from leases; mutation-lane replays; test-gap), each attempted by both species under identical gates (deps prepared, as MAKER-DEPS arm B, to remove environment noise) |
| Endpoint | graded score (`mutant_kill` / `mutation_score`); interaction contrast (Δspecies in exports − Δspecies in mutation), paired by task |
| n / power | 60 tasks per lane, 2 lanes → interaction SE ≈ 0.063 → MDE ≈ 0.18. 30 per lane → MDE ≈ 0.25 |
| Budget | atomic 120 attempts ≈ **19 GPU-h**; opencode 120 attempts × ≈ 0.4 M ≈ **48 M tokens** in a throwaway container on the prod image (SEC-F1 pattern). That is more than a week of prod maker volume under the weekly limit → **operator spend decision; run only on a credit plan or spread over ≥ 4 weeks** |
| Decision | speciation SUPPORTED if the interaction CI excludes 0 and the best species differs by lane → candidate: lane-specific species routing (shadow) |
| Collision | Ollama budget with prod makers; BEAM Stage 0/1 (DEFER) and OCR (DEFER) compete for the same account; none with WIP |

## E4 · P4 · Memory holdout readout (scheduled, no new design)

- **Registered.** Attribution-adjusted CMH by lane, once, at `stop_by` 27-10.
- **Current descriptive numbers.** Rules 0.802 (96) vs withheld 0.903 (31), Fisher p 0.28 (EE).
- **INFERENCE.** A positive effect is unlikely. The G3.3 freeze rule applies.
- **Collision.** Any change to memory injection (MCP rec 9: human-approved rules only) waits until after the readout.

## E5 · P5 · Discriminating retention endpoint (measurement, not an experiment)

Pair settlement-execution kill share with the maker-time graded score for every settled PR (today `n_paired = 0`). This
gives R negatives on an executed basis. Shadow only; Gate B unchanged (the operator's 13-10 condition). Small builder, no
WIP slot.

---

## Collision matrix

**X** = conflicts, **s** = shares a resource (serialise), **·** = none.

| | ACE-001 | STE-001 | MAKER-DEPS-001 | F2 v2 | X1 | memory holdout | TG-001 | genome trials (E0) | llama-router GPU | Ollama weekly | WIP slot |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E0 | · | · | · | · | · | · | s (gym) | — | s | · | · |
| E1 | · | · | · | · | · | · | · | s | s | · (A, B local) | · |
| E2 | · | · | · | · | · | · | **X** (subsumes next step) | **X** for Stage B | s | · | · |
| E3 | · | · | s (deps fixed) | · | · | · | · | s | s | **X** | · |
| E4 | · | · | · | · | · | — | · | · | · | · | already counted |
| E5 | · | · | · | · | · | · | · | · | · | · | · |

**Running population (EE `experiments`).**

| Experiment | Accrual | `stop_by` |
|---|---|---|
| ACE-001 | min arm 21/50 | 15-11 |
| STE-001 | 46/100 | 14-11 |
| MAKER-DEPS-001 | 29/141 | 16-12 |
| X1 | 41/94 | 06-11, projected to miss |
| F2 v2 | 7/93 | 15-01 |
| memory holdout | 31/30 | 27-10 |
| TG-001 r2 | complete, INCONCLUSIVE | 18-11 |

That is 6 experiments on the oracle population against a WIP limit of 4. **No new prod-population experiment is proposed
here.** Every proposal above is offline or gym-side.

## Not recommended now

| Item | Reason | Tag |
|---|---|---|
| Any prod feedback retry showing mutants | NE-013 | FACT |
| Prod genome injection | no promotion; YAGNI | FACT |
| MAP-Elites archive | power (file 3 §4) | INFERENCE |
| Fine-tuning (G6) | gated 20-11; out of scope | FACT |
| Falsifier allowlist | S0 isolation missing (MCP) | FACT |
| Beam / OCR trials | DEFER decisions #944 / #942 stand | FACT |
| Raising experiment count on the oracle population | WIP 6/4 | FACT |
