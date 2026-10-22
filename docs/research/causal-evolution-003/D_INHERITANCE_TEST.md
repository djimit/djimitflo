# CAUSAL-EVOLUTION-003 · D · Inheritance causality test (DESIGN ONLY)

Conventions and source keys: `A_MECHANISM.md`; general rules: `C_FUTURE_EXPERIMENTS.md` §0. **Nothing is built.**
**Production inheritance is not recommended now** (§8). This document specifies the isolated, offline test that
would have to pass first.

## 1. Question and why it is open

**Question.** Does a strategy trait that was *selected* and *inherited* across generations change maker behaviour
measurably on independent held-out tasks, by more than the simpler explanations do?

The simpler explanations are:
- (a) a static prompt;
- (b) re-generating a prompt each time;
- (c) selection with no inheritance;
- (d) inheritance of an arbitrary, unselected variant.

**Why it is open (A).**
- Every dream genome so far is a first-generation child of `baseline` (18/18, P2).
- 0 of 339 settled mutant attempts carry evidence that the lines reached the maker (P7).
- The settled trials were scored where the parent had no headroom: pooled Δ −0.009 [−0.036, +0.017] (A §4).
- So there is no evidence for or against inheritance. **Status: HYPOTHESIS, untested.**

## 2. Causal model

```
selection set ──► selection (best-of-N on graded kill) ──┐
                                                         ▼
parent lines ──► mutation (LLM, one gene) ──► child lines ──► maker prompt ──► behaviour ──► held-out oracle
      ▲                                                                                        (independent tasks,
      └──────────────── inheritance (child becomes next parent) ◄──────────────────────────────  independent mutants)
```

The arms below cut this graph at one edge each. That is what makes the contrasts causal rather than descriptive.

| Arm | Mutation | Selection | Inheritance | Cuts |
|---|---|---|---|---|
| **A0** static baseline | no | no | no | everything (reference) |
| **A1** independently regenerated prompt | yes: a fresh child of `baseline` each generation | no (a random child is used) | no | selection + inheritance |
| **A2** selected genome without inheritance | yes: N fresh children of `baseline` each generation | yes (best on the selection set) | no (next generation restarts from `baseline`) | inheritance |
| **A3** selected genome with inheritance | yes: N children of the current parent | yes (best becomes the parent) | yes | none (the full mechanism) |
| **A4** randomly inherited genome | yes: N children of the current parent | no: a **uniformly random** child becomes the parent | yes | selection |

**Causal contrasts at the final generation G.**
- A3 − A4: the value of **selection** given inheritance.
- A3 − A2: the value of **inheritance** given selection.
- A3 − A1: the value of the whole mechanism over **independent regeneration**.
- A3 − A0: the absolute effect.
- A1 − A0: the effect of "any LLM rewrite" (exploratory).

## 3. Gate stage INH-000: can the channel carry a signal at all? (positive control)

INH-001 is not run until INH-000 passes. INH-000 is cheap. It separates explanation C3 (inert channel) from C4 (treatment
not delivered) and C5 (noise) in A.

| Field | Specification |
|---|---|
| Arms | baseline ×2 (A/A), **harmful** line ("Stop after reading the target; do not run the tests."), **helpful** line (the MFR control instruction rephrased as a strategy line: "Before you stop, strengthen every assertion so it would fail on a wrong return value.") |
| Guard | both lines must pass `guardLines` unchanged. If the harmful line is blocked by the guard, use the nearest admissible paraphrase, chosen before data |
| Fire check | `GENOME_FIRE_CHECK=true`. Every attempt must show `genome_lines_found = genome_lines`, otherwise VOID |
| Tasks | 42 write_test tasks, graded k ≥ 9 |
| Decision | **PASS** if harmful − baseline or helpful − baseline has a 95 % CI excluding 0 **and** the A/A difference CI includes 0. **FAIL (channel inert)** if both CIs lie within ±0.10 → INH-001 is not run, and the report states "strategy lines do not move behaviour on this model/harness". **INVALID** if VOID > 10 % |
| Budget | 4 × 42 = 168 attempts ≈ **27 GPU-h** |

## 4. INH-001 design

| Field | Specification |
|---|---|
| Unit of analysis | held-out task (paired across all arms) |
| Selection unit | a genome evaluated on the **selection set** |
| Task sets | **selection set**: 20 write_test tasks. **Held-out set H**: 42 write_test tasks (95 for Δ 0.10). **Transfer set T**: 20 mined repair tasks (binary). All disjoint by task, target file and base commit, outside every holdout epoch, TG-001 set and trial, and added to the exclusion list afterwards |
| Outcome (primary) | held-out graded kill share on H, k ≥ 9 never-shown mutants (seeded generator, new salt) |
| Co-primary | none (kept to one family for power). Stryker on H is a **secondary**, cross-family generalisation test |
| Generations | G = 3 |
| Mutants per generation | N = 3 per lineage (the prod `MAX_MUTANTS`) |
| Mutation operator | the prod `dreamFromFailures` prompt, unchanged, on the **selection-set failures only** (never H or T). Model pinned (the prod dream model or a local one, frozen before data) |
| Selection rule | highest mean graded kill on the selection set. Ties go to fewer lines (parsimony) |
| Random inheritance (A4) | uniformly random child, seeded by sha256(`inh-001/<lineage>/<gen>`) |
| Randomisation | attempt order across arms randomised per task with a seeded shuffle. Served model pinned; worker hash recorded; a mismatch voids the pair |
| Blocking | task (paired); target file (≤ 2 tasks per file) |
| Estimands | E_H[score(A3,G) − score(Ak,G)] for k ∈ {4, 2, 1} (primary family, Holm); E_H[score(A3,G) − score(A0)] (secondary); slope of score(A3,g) over g = 1..G (persistence) |
| Analysis | paired differences per task, bootstrap over tasks (10 000 resamples, fixed seed). Mixed model with task random intercept as a sensitivity analysis |
| Multiplicity | Holm over the 3 primary contrasts. Persistence, negative transfer, transfer set and Stryker are secondary (exploratory unless pre-declared as gates in §6) |
| Stopping | fixed n. Abort on > 20 % infra or VOID in the first 30 attempts, or on any held-out leak (any H task id or mutant in a mutation prompt) |

## 5. Power and budget

**Power** (paired, Holm α 0.0167 for the first of 3 tests, power 0.8, so z sum 3.236).

| Planning σ (paired, k ≥ 9) | Δ = 0.15 | Δ = 0.10 |
|---|---|---|
| 0.30 (assumed; GR-REL-001 replaces it) | **42 tasks** | **95 tasks** |
| 0.346 (k = 3 value, pessimistic) | 56 tasks | 126 tasks |

Δ = 0.10 on graded kill is the minimal effect worth inheriting (MCID). It is smaller than MFR's −0.142 and well below
MFR-RA's +0.317. At realistic supply (≈ 1.4 rebuildable exports items/day plus failure-derived write_test tasks), 42 tasks
is feasible and 95 is not before 15-12. **So INH-001 is sized for Δ 0.15.** A null at n = 42 rules out large effects only
and is reported as such.

**Budget (one lineage per inheritance arm; attempts × 0.16 GPU-h).**

| Component | Attempts |
|---|---|
| selection-set evaluation: A2 (3 gens × 3 × 20), A3 (3 × 3 × 20) | 360 |
| baseline on the selection set | 20 |
| held-out evaluation per generation: A2, A3 (3 × 42 each) | 252 |
| held-out per generation: A1, A4 (3 × 42 each) | 252 |
| A0 on H, twice (A/A) | 84 |
| **Total** | **968 ≈ 155 GPU-h** |
| + replicate lineage for A3 and A4 (selection 180, held-out 252) | +432 → **1 400 ≈ 224 GPU-h** |
| + transfer set T at G for A0, A3 (2 × 20) | +40 ≈ 6 GPU-h |
| INH-000 gate (§3) | 168 ≈ 27 GPU-h |

- **Cloud tokens:** about 3 mutation calls per lineage per generation ≈ 12–18 calls × ≈ 2 k tokens, or 0 with a local
  mutation model.
- **Energy:** 155–224 GPU-h × 0.06–0.30 kW ≈ 9–67 kWh. The 57.9 W mean is a host-wide average with idle time included
  (EVO). Under-load power is UNKNOWN. € is UNKNOWN (no kWh tariff recorded).
- **Calendar:** at the 40/day gym cap, ≈ 24 days for one lineage and ≈ 35 with the replicate. It runs only after E0,
  AA-001 and STR-001 Stage B have released the GPU.

## 6. Secondary questions

| Question | Measure | Gate for §8? |
|---|---|---|
| **Persistence across generations** | slope of A3 on H over g = 1..3; score(A3, 3) − score(A3, 1) | yes: slope CI lower > −0.02 per generation and score(A3, 3) ≥ score(A3, 1) |
| **Accumulated regression** | per-task loss rate of A3 vs A0 on H (tasks where A3 kills fewer mutants) | yes: ≤ 0.10, with the A/A loss rate as reference |
| **Negative transfer** | A3 − A0 on the transfer set T (mined repair, binary, paired McNemar) | yes: non-inferiority, net loss ≤ 1 task of 20 |
| Cross-family generalisation | A3 − A0 on H scored by Stryker | yes: same sign, CI lower > −0.05 |
| Size inflation | added lines and kills per 100 added lines, A3 vs A0 | reported. A3's gain must not be explained by size alone (gain in kills per line ≥ 0) |
| Line growth | lines per genome over generations (inheritance concatenates lines) | reported. More than 15 lines needs a deletion operator, which does not exist |
| Reproducibility | the replicate lineage: sign and CI of A3 − A4 | yes: same sign; pooled CI lower > 0 |

## 7. Threats to validity, and the design response

| Threat | Response |
|---|---|
| Selection-set overfitting (NE-013 pattern) | H and T are never seen by mutation or selection. Mutants are generated with a new salt |
| Treatment non-delivery | fire check on every attempt. VOID attempts are re-served and never paired |
| Served-model drift | pinned model; worker hash; a mismatch voids the pair. The router must not load another model during the run |
| Regression to the mean in selection (a winner is partly lucky) | A4 and A2 absorb it: both face the same luck; only A3 combines selection with inheritance |
| Inheritance by line concatenation confounds "more lines" with "better lines" | A4 also concatenates (random child), so line count is matched between A3 and A4 |
| Mutation-model stochasticity | replicate lineage; seeds recorded |
| Task leakage via failures fed to the mutation model | mutation sees selection-set failures only (D3 rule, as in prod) |

## 8. Decision rule for ever recommending production inheritance

Production inheritance means building the injection that `loop-daemon.ts:617-626` leaves unbuilt. It may be recommended
only if **all** of the following hold. Otherwise the recommendation is **against**, with an NE entry.

1. **INH-000 PASS.** The channel moves behaviour, and the A/A noise floor is known.
2. **Primary.** A3 − A4 > 0, A3 − A2 > 0 and A3 − A1 > 0, each with a Holm-adjusted 95 % CI lower bound > 0, and A3 − A0 ≥
   0.10 on H.
3. **Persistence.** The §6 slope gate holds.
4. **No accumulated regression or negative transfer.** The §6 gates hold.
5. **Cross-family.** The Stryker gate holds.
6. **Reproducible.** The replicate lineage agrees (§6).
7. **Contract.** 100 % fire-check coverage; served model and worker hash recorded on every attempt.
8. **Simpler mechanism does not win.** If STR-001 Stage B is SUPPORTED, A3's held-out gain must exceed the
   strengthen-retry gain at matched GPU cost, or A3 must add to it in a 2×2 (retry × inherited genome). Otherwise the
   simpler, non-evolutionary mechanism is recommended instead (directive principle).

**Rollout if every gate passes.** `GENOME_APPLY_MODE=shadow` (it exists: it logs what would be injected) → injection
behind a new default-off flag → ≤ 10 % randomised traffic with auto-retire on a pre-registered harm rule → readout. Each
step is an operator decision.

**Status today: gates 1–8 are all unmet (not attempted). Recommendation: do not build production inheritance.**
**VERIFIED** (gates unmet) / **HYPOTHESIS** (that inheritance could pass them).
