# STR-001-PROD — the "strengthen the assertions" retry as a production procedure (pre-registration)

Status: **pre-registered, not started** (2026-10-29). No flag is turned on, no registry entry is activated, and no code that can
deliver the treatment or produce an outcome exists. Starting the experiment is an operator decision, and it may only happen
once every precondition in §9 holds.

**Revisions before freeze.** All superseded on 2026-10-29, before any start, after the reviews on PR #1092:
- **Draft r1** (fingerprint `279fb5fe…c405`, commit 6a99c02c) had three problems:
  - its primary endpoint depended on the merge;
  - its decision rules overlapped;
  - it had an extension without alpha spending.
- **Draft r2** (fingerprint `98714130…f187`, commit 28437943) had two problems:
  - its period weights used scored counts and dropped small periods;
  - its holdout had no lifetime false-revert accounting and no epoch-relative dates.

Only this revision r3's fingerprint is binding.

Sources:
- STR-001 Stage A (`docs/research/eco/STR-001_STAGE_A_PROTOCOL.md`, sha256 `87c8927f…3a47`;
  result `docs/research/eco/STR-001_STAGE_A_RESULT.md`, SUPPORTED).
- Learning roadmap of 2026-10-29, stage 1.
- Teardown of 2026-10-29: `B-intelligence.md` (volumes, labels) and `E-assumptions.md` (A18: experiments share one goal
  population; A16: survival cannot fail).

## 1. Why this exists, and what it is not

- **Stage A result.** Offline, on the 40 MFR-001 items, the strengthen-retried test killed more independent Stryker mutants
  than the original test.
  - Kill share went from 0.158 to 0.474: Δ **+0.316** [+0.233, +0.402], Holm p 1.8 × 10⁻⁸.
  - The fresh gym-mutant family agrees: Δ +0.343.
- **What Stage A did not show.**
  - It did not compare against a same-budget fresh attempt (Stage B).
  - It used one maker family: atomic-agent 0.6.5 with qwen38-27b. Production makers are almost all `opencode@glm-5.2:cloud`.
  - The gain was close to proportional to the added test code: slope +0.167 per 100 added lines, intercept ≈ 0.
- **The question.** On real oracle-lane goals, does one strengthen retry after the maker's first passing attempt raise the fresh-mutant kill
  share of the delivered test, at an acceptable cost and without lowering the verified rate?
- **It is not a mutant-feedback retry.** Showing mutants is falsified (MFR-001, NEGATIVE_EVIDENCE "Mutant-kill feedback retry for
  exports-lane test makers"). The retry never sees a mutant, a graded score or a settlement result.

**Hypothesis H-STR-P:** for exports-lane and test-gap-lane roots, delivering the strengthen retry raises the mean fresh-mutant
kill share of the delivered test, measured at verification time.
**H0:** the difference (retry − none) is ≤ 0.

## 2. Population, unit and entry

### Which lanes have a graded value label

The decision comes from the teardown data (`B-intelligence.md` §1–2, 30 d to 2026-10-29).

| lane | 30 d makers / verified | graded label at maker time | settlement label | in? |
|---|---|---|---|---|
| exports (`test-gap#exports`) | 136 / 87 | `metadata.graded` kind `mutant_kill`: ≤ 3 seeded gym mutants (`graded-fitness.ts`); 66 of 87 verified carry one; verified-vs-kill AUC 0.45 | `settlement_execution.kill_share_now` | **yes** |
| test-gap | 33 / 14 | the same `mutant_kill` machinery; sparse (3 graded leases in the 21-10 MFR export) | the same | **yes** (stratum) |
| mutation-gap | 111 / 42 | `mutation_score`: the lane's own Stryker target; mean 0.90, which is a ceiling | `kill_share_maker` null | **no** |

Mutation-gap is excluded for four reasons:
- its label is the score its maker was told to raise;
- its first attempt is already the falsified "kill these surviving mutants" task;
- Stage A covers only exports;
- its diff cap differs (400 against 200).

### Unit: the root

The unit is the **root**, the lineage root of a proposal.
- **Lineage edges.** Follow the explicit edges the provenance DAG reads (`provenance-dag.ts`):
  - `requeue-of:<id>` evidence refs (edge `requeue_of`);
  - `refinement-of:<id>` refs and `refined_from_id` (edge `refinement_of`).
- **The root.** Walk from the goal's proposal to the ancestors that have no parent. The **root key** is the id of the earliest-created such ancestor, with ties broken by the smaller id.
- **Why not the goal id.** Every requeue or refinement creates a new proposal and a new goal, so a goal-id key would re-randomise a lineage. The root key never changes along it.
- Every run, retry, evolve sibling, requeue successor and refinement of a root shares the root's arm.

### Eligibility

A root is eligible when all of these hold:
- the proposal of its triggering goal comes from `gap_analysis`;
- `laneOf(evidence)` is `exports` or `test-gap`;
- the goal is on the primary repo;
- the goal was created at or after the start timestamp;
- the root has not triggered before. One root is one unit, analysed on its **first** triggering run.

### Trigger: entry into the analysis

The trigger is the maker lease that goes to the reviewers after evolve selection, when all of these hold:
- the lease is `completed`;
- its deterministic checks pass;
- it changed a test file, chosen by the `recordMakerGraded` rule: the proposal's `artifactPath` if changed, else the first changed test file.

Entry does not depend on the arm. Up to the trigger both arms are identical, and the arm is applied only after it. The trigger counts per
arm are reported as a check.

### Pre-treatment exclusion

A triggered root is excluded from both arms in two cases:
- its target file is missing at the trigger;
- the generator yields no fresh mutant of the target (§5).

Both depend only on the target content, which the retry may not change, so neither depends on the arm. The exclusions are counted and reported.

## 3. Treatment and control (frozen)

### Assignment

- **Bucket.** `bucket(key) = uint32_be(first 4 bytes of sha256('str-prod-001:' + key)) mod 100`.
- **Arms.** During the experiment, arm `retry` when bucket < 50, else `none`.
- **Holdout after promotion.** `hbucket(key) = uint32_be(first 4 bytes of sha256('str-prod-001/holdout:' + key)) mod 100`, holdout when hbucket < 10.
- **Golden values** (the implementation must reproduce them; the fingerprint test pins them):

  | key | bucket | hbucket |
  |---|---|---|
  | `root-0` | 49 | 18 |
  | `root-1` | 55 | 4 |
  | `root-2` | 73 | 88 |
  | `root-3` | 58 | 37 |
  | `root-4` | 25 | 68 |
  | `root-5` | 52 | 12 |

- **Recording.** At the trigger, the arm, root key, bucket, salt and text hash are written to the loop run metadata (`str_prod`).

### Treatment `retry`

One retry maker lease runs in the same loop run, after evolve selection and before checker dispatch.

**What the retry gets.**
- **Species.** The same runtime and model as the delivered maker. It is not a bandit draw.
- **Caps.** The same lane caps: timeout, step budget, and `diff_max_lines` 200, counted as the gate counts it today. No cap is raised.
- **Dependency arm.** The same MAKER-DEPS-001 arm as the triggering goal.
- **Starting state.** The worktree holds the delivered test file.

**The instruction is this frozen template**, rendered and sent as the retry's task instruction.
- The lane's ordinary maker template wraps it. The wrapper is the same in both arms.
- One line, UTF-8, no trailing newline:

  `Retry of a test-writing task: the vitest test file {test} already exists and covers {target}, but it is too weak: a subtly broken {target} can still pass it. Edit {test} so that it still passes against the real {target} and fails when {target} is subtly broken. Keep importing {target} with a relative import, do not mock it, skip nothing, and make it pass with: cd packages/server && npx vitest run {test_rel}. Change only {test}; do not edit {target} or any other file. Strengthen the assertions of this test.`

- Template sha256: **`1a7cc5b85ae01a9f0d92ef434e9917406cd46984e4ed7e5126ed2491e2c8710f`**.
- **Placeholders.** `{test}` is the delivered test path, repo-relative. `{target}` is `gradedTarget(test, proposal target)`. `{test_rel}` is `{test}`
  without `packages/server/`.
- **Rendering.** Replace `{test_rel}` first, then `{test}`, then `{target}`.
- **Source.** This is the MFR-001 CONTROL text, the Stage A strengthen arm: `scripts/mfr-001/lib.mjs buildPrompt`, arm `control`, file sha256 `16334c1b…0fcd`, which equals the MFR-001 pin.
  - For `test = packages/server/src/__tests__/usage-telemetry.exports.test.ts` and `target = packages/server/src/services/usage-telemetry.ts`, the rendering equals `buildPrompt` byte for byte. Its sha256 is `2747d68433ce41602af0b0ab7193f3680c9b227b4aa00bcbaac7c028d5b8a0aa`.

**Runtime guards.**
- The template hash is recomputed before every retry. On a mismatch there is no retry, and the class is `text_mismatch`.
- The retry input carries no mutant key or description, no graded or FBPA score and no settlement result. A hit means no retry, and the class is `leak`.

**Adoption.**
- The retry is adopted only when both hold:
  - its deterministic checks pass under the same `daemonCheckOptions`;
  - its diff against the delivered maker changes only `{test}`.
- Otherwise the first attempt stays the delivered maker. The class is one of:
  - `retry_failed_checks`
  - `retry_no_change`
  - `retry_timeout`
  - `retry_scope_violation`
  - `retry_error`
  - `retry_needs_approval`
  - `text_mismatch`
  - `leak`
- **Approval.** The retry uses the evolve-sibling approval route. If it cannot get an approval, it is never parked: the first attempt is delivered.

**Bandit.** The retry lease writes no bandit-read maker outcome (`loop-maker:<loop>:<runtime>`).

### Control `none`

- No retry. The control is today's behaviour.

### Budget accounting (both arms)

- The cost of a root is the tokens of every maker and checker lease of all its runs, including the retry.
- The token-unknown share is reported per arm.
- The scorer in §5 calls no model, so it costs no tokens. It is the same in both arms, and its CPU time is reported.

## 4. Isolation and estimand

**Choice: salted, independent assignment on the shared population, without exclusion.**
- **No changes elsewhere.** The running experiments keep their registered populations, assignments and analyses.
- **Why not exclusive assignment.** It would amend the frozen analyses of MAKER-DEPS-001 and F2 v2. It would also remove about 70 % of their accrual, because exports plus test-gap are 101 of 143 verified in 30 d. Both would miss their targets.
- **Concurrent experiments.** STR starts only after X1, STE-001 and ACE-001 have verdicts (§9 G0.4). The concurrent oracle-population experiments are then **MAKER-DEPS-001** (A/B, salt `maker-deps-001:`, goal id) and **F2 v2** (same/cross, salt `checker-family:v2:`, goal id).
- **Independence.** The STR arm is a function of the root key with salt `str-prod-001:`. The fingerprint test checks with the real assignment functions (`aceArm`, `steArm`, `makerDepsArm`, `siblingArm`, `checkerFamilyArm(…, 'v2')`) that, on 4 000 sampled ids:
  - the STR arm is independent of each of those arms (χ², p > 0.001);
  - the STR arm is stable along a requeue / refinement lineage built by the real provenance DAG.
- **Requeue successors.** Their goal-keyed arms in other experiments can differ from the root's first goal. STR takes those arms from the root's **triggering** goal.

**Estimand.** The estimand is the average effect, over eligible triggered roots, of delivering the retry (retry − none) on the primary endpoint.
- **Single period.** While there is one period, the effect is averaged over the concurrent treatment mix as it is randomised at the time: MAKER-DEPS-001 A/B 50/50 and F2 v2 same/cross 50/50, under the prevailing defaults of every other flag.
- **Several periods.** With more than one period, the estimand is the average of the per-period effects, each under its own configuration, weighted by eligible triggered roots per period.

**Periods (pre-registered).**
- **What starts a period.**
  - The STR start is a boundary.
  - Every change in an STR `treatment_env` value is another boundary. The list is `STR_PROD_001_MODE`, `MAKER_DEPS_001_MODE`, `LOOP_MAKER_PREPARE_DEPS`, `CHECKER_FAMILY_RANDOMISE`, `CHECKER_FAMILY_VERSION`, `CHECKER_CROSS_MODEL`, `LOOP_EVOLVE_ENABLED`, `EFFORT_SIBLING_RANDOMISE`, `GRADED_CONTEST_MODE`, `LOOP_BANDIT_ENABLED`, `TEST_ONLY_DIFF_MAX`, `LOOP_MEMORY_RULES_ENABLED`, `OPENCODE_MAX_RUN_TOKENS` and `GRADED_FITNESS_MODE`. Such a change includes MAKER-DEPS-001 or F2 v2 stopping or promoting mid-run.
  - Each boundary is recorded as an `experiment_period_boundaries` row (PR #1091, `recordTreatmentEnvBoundaries` at boot).
- **Analysis by period. No period and no eligible triggered root is ever dropped.**
  - **Weights.** w_p = eligible triggered roots in p ÷ all eligible triggered roots. Scored and unscored roots both count, so the weights cannot depend on treatment-dependent missingness.
  - **Per-period difference.** Δ_p is the difference in mean primary value, retry − none, within period p. The primary Δ is Σ_p w_p Δ_p.
  - **Bootstrap.** It resamples roots within period × lane × arm. Lane is a resampling stratum, not an estimator stratum. Periods are never pooled unstratified.
- **Covered periods.** A period is **covered** when, in each arm, it has ≥ 5 eligible triggered roots and ≥ 90 % of them are scored.
- **Uncovered periods.** An uncovered period stays in every estimate at its worst case, in the primary Δ̂ and in L_b alike:
  - each of its `retry` roots counts as 0 and each of its `none` roots as 1, so Δ_p = −1;
  - this also covers a period in which one arm has no root at all.
  - An adverse small period therefore lowers both Δ̂ and L_b and can never vanish from the analysis.
- **Promotion and uncovered periods.** PROMOTE is also blocked when uncovered periods together hold > 10 % of the eligible triggered roots (§7, branch 5).

**Interaction check (pre-registered).**
- **What is reported.** Δ within MAKER-DEPS-001 A and B, and within F2 v2 same and cross. The interaction contrasts are Δ_B − Δ_A and Δ_cross − Δ_same, each with a bootstrap 95 % CI.
- **When it matters.** If an interaction CI excludes 0, PROMOTE also needs Δ̂ > 0 in the stratum of that factor that stays as the configuration after that experiment's verdict. If that verdict is not known at the readout, it needs Δ̂ > 0 in every stratum of the factor.
- **Otherwise** the check is descriptive. It is underpowered.

**Rules for others.** Any later analysis that pools oracle-lane goals created after the STR start stratifies by
`str_prod.arm ∈ {retry, none, not_triggered, not_eligible}`. Any later oracle-population experiment uses an independent salt.

## 5. Endpoints

### Primary: fresh-mutant kill share at verification (merge-independent, all triggered roots)

The value comes from the **STR scorer**. It is pinned by the implementation PR and is the same code in both arms.

- **When.** On the delivered maker lease, in its worktree, before checker dispatch: after the adoption decision in `retry`, and at the trigger in `none`. The scorer never waits for verification, review or merge.
- **Mutants.**
  - The candidates are the first 6 of `targetMutants(target content, 'str-prod-001/score:' + root key, target, 18)` whose content differs from every maker-time graded mutant of the run.
  - The seed depends only on the root key and the target, so both arms of a root would get the same set.
  - No maker in the run ever sees them: they are generated after the maker phase and never written into any maker input.
- **Scoring.**
  - First, one baseline run of the delivered test on the real target, with up to 3 attempts.
  - Then one `npx vitest run <test>` per mutant from `packages/server`, capped at 180 s per mutant.
  - Red or hung counts as killed, the Stage A and MFR-001 convention.
  - The target is restored and its sha is verified after every mutant.
- **The value.** killed ÷ mutants scored, with 1 to 6 mutants.

| outcome at the scorer | primary analysis | worst-case bound analysis |
|---|---|---|
| scored | its kill share | its kill share |
| baseline red / hung after 3 attempts | 0 (ITT, Stage A convention) | missing |
| infra (worktree, npm, crash) after 3 attempts | missing | missing |
| no mutant / target missing | excluded before arms (§2) | excluded |

**Worst-case (Manski) bound.**
- **Construction.** Every missing `retry` value counts as 0 and every missing `none` value as 1. The same period-stratified estimator and bootstrap (§4, §7), run over **every eligible triggered root of every period**, gives L_b, the lower 95 % bound of Δ under that worst case. Uncovered periods are included at Δ_p = −1.
- **Promotion** needs L_b > 0 (§7).
- **Reporting.** The missing share is reported per arm. The scorer is built to keep it ≤ 2 %: the per-mutant cap turns slow runs into kills, not skips, and infra gets 3 attempts.

**Why not the existing graded score.** The current `metadata.graded` is missing for 24 % of verified exports leases (66 of 87), mostly because its total budget expires. It is kept as covariate and secondary, not primary.

### Secondary (reported; only the guards in §7 decide)

| | measure |
|---|---|
| S1 | verified rate per triggered root (ITT), Newcombe 95 % CI |
| S2 | tokens per verified root: total and in + out; ratio retry / none with a bootstrap CI; token coverage per arm |
| S3 | fail-before-pass-after pass share among delivered tests with a decisive verdict |
| S4 | **settlement fresh-mutant kill** (`settlement_execution.kill_share_now`, the U1 label) for roots whose PR merged; plus the U1 binary pass rate. Merge-dependent, so it is descriptive. It is reported in an addendum at enrolment end + 24 d and never changes the verdict |
| S5 | mechanism, within adopted `retry` roots: graded(retry) − graded(first attempt) on the same run-seeded mutants, with the sign test |
| S6 | adoption classes; retry added lines; scorer outcome classes and missing share per arm; merged and auto-merged share; settlement `fail` rate |
| S7 | precision: the primary Δ with ANCOVA on the first attempt's maker-time graded score (pre-treatment) and lane |

## 6. Power, n and accrual

**Effect sizes.**
- The Stage A full-sample effect is +0.316. Production differs in maker family, in the 200-line cap and in the ceiling: 5/66 exports tests already kill every seeded mutant.
- Stage A's +0.200 [+0.117, +0.296] for retries of ≤ 202 lines is a **post-hoc, retry-size-selected subset**. Retry size is post-treatment, so that number is uncertain and is not a design effect.
- **The design therefore uses δ = +0.15**, the smallest effect worth an extra maker lease plus a margin. It also reports +0.20.

**Test and spread.** σ is 0.35 per root, conservative for a 1–6-mutant kill share: maker-time exports scores imply σ ≈ 0.31. The test is two-sided at 95 %, decided on the CI lower bound (one-sided α 0.025), at power 0.80.

| design δ | n scored per arm (σ 0.30 / **0.35** / 0.40) | power of the registered n = 86 at that δ |
|---|---|---|
| +0.316 (Stage A) | 15 / 20 / 26 | 1.00 |
| +0.20 (uncertain subset) | 36 / 49 / 63 | 0.96 |
| **+0.15 (design)** | 63 / **86** / 112 | **0.80** |
| +0.10 | 142 / 193 / 252 | 0.47 |

**Registered target: n = 86 scored roots per arm (172).** The acceptance minimum is 49 per arm.

**Power on the bound.** The power of the PROMOTE rule under the bound (L_b > 0) is lower when values are missing. The table assumes a control mean of 0.30, σ 0.35 and n 86.

| missing share per arm | δ +0.15 | δ +0.20 |
|---|---|---|
| 0 % | 0.80 | 0.96 |
| 2 % | 0.66 | 0.91 |
| 5 % | 0.41 | 0.75 |

**Accrual: the chain from trigger to scored.** All rates use the 30-d window; it crosses the 1.5-day lost window, so 28.5 days.

- **Verified per day.** Exports plus test-gap gave 101 verified, which is V = 3.5 per day.
- **Triggered roots per day, T.**
  - The trigger comes before verification. T = V_roots ÷ p_v, where p_v = P(verified | triggered) is not measured. It lies in [0.60, 1]: makers number 169 in 30 d, so T ≤ 5.9 per day.
  - V_roots ≤ V, because 28 of 143 verified in 30 d (19.6 %, all lanes) came from requeue successors whose root may already have triggered.
  - Design T = V × (1 − 0.196) = **2.8 per day**, the lower bound at p_v = 1.
  - Central T = 3.5 per day.
- **Scored per triggered.** q = (1 − pre-treatment exclusion ≤ 0.10) × (1 − missing ≤ 0.05) ≥ **0.855**. That gives a design rate of 2.4 scored per day and a central rate of 3.0.
- **Settlement label (S4), for comparison.**
  - It is 0.60 **per verified** root: 71/101 merged × 42/49 numeric `kill_share_now`.
  - Per triggered root it is 0.60 × p_v ≤ 0.60.
  - That is ≈ 2.1 per day, and 14 d + merge later, which is why it is secondary. The r1 draft confused "per verified" with "per triggered" here.

**Duration.**
- **Enrolment** stops at 86 scored per arm or at **start + 84 d**, whichever is first.
- **Readout** comes 3 days later (in-flight runs finish), so the maximum is **start + 87 d**.

| | scored per day | days to 172 scored | readout |
|---|---|---|---|
| central (T 3.5) | 3.0 | 57 | start + 60 d |
| design (T 2.8) | 2.4 | 72 | start + 75 d |
| if δ = +0.20 were the design (n 49/arm) | 3.0 | 33 | start + 36 d |

- **Dates.** With the earliest start of 2026-11-16, the expected readout is 2027-01-15 (central) to 2027-01-30 (design). The cap is 2027-02-11.
- **No extension** (§7).
- **Roadmap.** Stage 1's "2–4 weeks" is not reachable at today's volume.

## 7. Stop rules and decision

**Harm-only monitoring.**
- **What is computed.** Weekly, from ≥ 20 triggered roots per arm, the harm metrics only. The primary contrast is never computed before the readout, and there is no efficacy stop.
- **Stop at once** (flag `off`) when any of these holds:
  - **H1.** Verified rate retry − none ≤ −0.15, with the Newcombe 95 % upper bound < 0.
  - **H2.** A retry diff touching a non-test file reaches a PR or main. This is an incident.
  - **H3.** Settlement `fail` in `retry` is ≥ 3 and ≥ 2 × the `none` rate.
  - **H4.** Tokens per verified, retry / none, is > 3.0 at ≥ 20 verified per arm.
  - **H5.** Any retry lease is detected writing outside its worktree or to the control DB. This is an incident.
- Harm stops spend no efficacy α. They can only lead to REJECT.

**A single readout and no extension.** There is one look at one-sided α 0.025. An INCONCLUSIVE result closes the experiment. A successor needs a new
pre-registration.

**Statistics.**
- **Δ.** Δ̂ = Σ_p w_p Δ_p, with the weights and the uncovered-period rule of §4. Within a covered period it uses the scored roots, with baseline red = 0. It is ITT by assigned arm: an unadopted `retry` root keeps its first attempt and stays in `retry`.
- **CI.** [L, U] is the stratified percentile bootstrap 95 % CI, with 10 000 resamples over roots and seed 20261029.
- **Bound.** L_b is the same estimator and bootstrap on **all eligible triggered roots of all periods**:
  - every unscored root is imputed at its worst case: `retry` = 0, `none` = 1 (§5);
  - uncovered periods enter at Δ_p = −1.
- **Reported p.** One-sided permutation p of arm labels within period × lane, with 10 000 permutations and seed 20261030.

**Decision tree.** It is evaluated in this order, and the first matching branch is the verdict, so exactly one verdict applies:

| # | condition (given no earlier branch matched) | verdict | action |
|---|---|---|---|
| 1 | a harm stop H1–H5 fired | **REJECT (harm)** | flag `off`; NEGATIVE_EVIDENCE entry (H1/H3/H4) or incident (H2/H5) |
| 2 | fewer than 49 scored roots in either arm | **INCONCLUSIVE (acceptance)** | flag `off`; closed; learning ledger |
| 3 | U < +0.10 | **REJECT (below floor)** | flag `off`; NEGATIVE_EVIDENCE entry. A gain below +0.10 kill share does not pay for one extra maker lease per root, even when L > 0 |
| 4 | L ≤ 0 (and so U ≥ +0.10) | **INCONCLUSIVE** | flag `off`; closed; learning ledger |
| 5 | L > 0, U ≥ +0.10, and all of: Δ̂ ≥ +0.10; L_b > 0; uncovered periods hold ≤ 10 % of eligible triggered roots; S1 Δ̂ ≥ −0.05; S2 ratio ≤ 2.0; the interaction rule (§4) holds | **PROMOTE** | §8 |
| 6 | L > 0, U ≥ +0.10, and any condition of branch 5 fails | **SUPPORTED, NOT PROMOTED** | flag `off`; operator decision with the numbers; no NE entry |

**Operating characteristics** (normal approximation, n 86 per arm, σ 0.35, no missing values; branches 3–5):

| true δ | P(PROMOTE-eligible: L > 0) | P(REJECT below floor) | P(INCONCLUSIVE) |
|---|---|---|---|
| 0 | 0.025 | 0.47 | 0.51 |
| +0.05 | 0.15 | 0.15 | 0.70 |
| +0.10 | 0.47 | 0.025 | 0.51 |
| +0.15 | 0.80 | 0.00 | 0.20 |
| +0.20 | 0.96 | 0.00 | 0.04 |

At n 86 the CI half-width (0.105) exceeds 0.10, so L > 0 already implies Δ̂ ≥ +0.10.

## 8. Promotion, holdout monitoring and rollback

**The flag.** `STR_PROD_001_MODE`:
- `off`, the default: byte-identical to today, with no `str_prod` metadata.
- `experiment`: 50 / 50.
- `default`: retry for everyone except the hbucket < 10 holdout.

The implementation PR registers the flag in `EVOLUTION_FLAGS` (acting).

**Code path.** `loop-daemon.ts`, in the maker phase of `executeGoal`, between the end of evolve selection (8a) and checker dispatch (8b). It runs:
1. `LoopService.retryLoopRun(run.id, { maker_lease_id })` with the frozen instruction. `RetryLoopInput` has no instruction field today; that field is the one new surface.
2. Then `runDeterministicChecks`.
3. Then the adoption rule.
4. Then the STR scorer (§5) and `grade()`.

Nothing else changes.

**Promotion.**
- It is an operator flag change from `experiment` to `default`, made in the readout PR as a dated amendment.
- **It is not automatic before S5** (§9 G0.3). Once S5 is live, a later amendment may let the readout switch the mode itself.

**Holdout monitoring (pre-registered).**

**Epochs and their start times.**
- **What defines an epoch.** An epoch k is fixed by its flag value (`default`) and its scorer identity. The scorer identity is the pinned STR scorer sha plus the `gym-failure-tasks.ts` sha, both recorded in every root's `str_prod` metadata.
- **E_k, the epoch start,** is the trigger timestamp (UTC, ms) of the **first** root that triggers with mode `default` and epoch k's scorer identity.
  - E_1 is therefore the first post-promotion trigger.
  - E_2 is the first trigger after a scorer or generator change. That change needs a dated amendment.
- **Cohort k** is the roots that first trigger in [E_k, E_{k+1}): the default cohort is hbucket ≥ 10, the holdout is hbucket < 10.
  - Cohorts are never pooled across epochs.
  - Experiment-period roots are never part of the monitor.
- **At most 2 epochs.** A third scorer or generator change ends automatic monitoring for good. The holdout stays as a descriptive comparison, and any revert after that is an operator decision through an amendment.

**Looks, relative to each epoch start only.**
- The looks of epoch k fall at exactly E_k + 28 d, E_k + 56 d, E_k + 84 d and E_k + 112 d (calendar-independent: 86 400 000 ms per day).
- Each look reads cohort k, cumulatively over the roots that triggered before the look instant.
- A look decides only when n_holdout ≥ 8 scored. A look that falls in a pause (≥ 7 d without any scorer value) is skipped, not postponed.
- If epoch k + 1 starts before one of epoch k's looks, that look and every later look of epoch k are cancelled, and their error budget is not reused.
- E_1 + 14 d (the roadmap's 14-day point) is recorded descriptively and decides nothing: about 4 holdout roots will exist by then.
- The holdout accrues 0.24–0.30 scored roots per day: about 7–8 by +28 d, 20–25 by +84 d and 27–33 by +112 d.

**Revert rules at a deciding look.** Revert means `STR_PROD_001_MODE=off`, plus a NEGATIVE_EVIDENCE entry "promoted, did not hold". It happens when any rule holds:
- **R-eff.** The cumulative Δ̂(default − holdout) ≤ 0.
  - Unscored roots are imputed against the default: default = 0, holdout = 1.
  - That imputation applies only when either cohort's missing share is > 5 %. Otherwise R-eff uses the scored roots.
- **R-harm.** One of the statistical harm rules trips, each tested at one-sided **α_H / 24 = 0.025 / 24 ≈ 0.00104**. The 24 is 3 rules × 4 looks × 2 epochs.
  - **H1′.** Verified-rate Δ(default − holdout) ≤ −0.15 **and** the matching one-sided Newcombe bound < 0.
  - **H3′.** The settlement-`fail` rate is ≥ 2× the holdout's **and** the one-sided Fisher exact p < α_H / 24.
  - **H4′.** The tokens-per-verified ratio's one-sided lower bound is > 3.0.
- **R-incident.** H2 or H5 (scope violation or write outside the worktree) is an incident and reverts at once at any time. It is not a statistical test.

**Lifetime false-revert risk** (true effect > 0, no real harm, no incident):
- **R-eff.** Per epoch, by simulation (σ 0.35, holdout 0.24–0.30 per day, 4 looks): 0.04 at +0.20, 0.10–0.11 at +0.15, 0.24 at +0.10. Over the at most 2 disjoint epochs: 1 − (1 − p)².
- **R-harm.** At most α_H = 0.025 for the whole lifetime, by the union bound over the 24 tests.

| true effect | R-eff, lifetime (≤ 2 epochs) | R-harm, lifetime | **total lifetime false-revert (union bound)** |
|---|---|---|---|
| +0.20 | ≤ 0.08 | ≤ 0.025 | **≤ 0.10** |
| +0.15 | ≤ 0.21 | ≤ 0.025 | **≤ 0.24** |
| +0.10 | ≤ 0.42 | ≤ 0.025 | **≤ 0.45** |

**Correct-revert probability** (R-eff alone, one epoch): 0.68–0.70 at a true 0, and 0.96–0.97 at −0.10.

**After the last look of the last epoch** (E_k + 112 d), the holdout stays as the standing comparison for the learning ledger, but
automatic reverts stop. A later revert is an operator decision through an amendment.

## 9. Preconditions (gate 0): all hold before `STR_PROD_001_MODE=experiment`

| | precondition | status on 2026-10-29 |
|---|---|---|
| G0.1 | **U1 live** (roadmap gate 0): the settlement label fails ≥ 10 % at n ≥ 30 and agrees with mutant kill. The STR primary does not depend on it (§5), but S4 and the roadmap gate do | not live (`kill_share_now` exists in shadow, n 42; U1 is in PR #1090) |
| G0.2 | **Alerts live (O1):** stalls persisted and pushed, `VALUE_ANOMALY_ALARM=on`, and the #947 replay alerts within 24 h | not live |
| G0.3 | **Maker isolation (S5):** not required to start. Stage 1 **may start without S5**: the retry is one more maker lease of the same species, lane, caps, approval route and worktree confinement as today's makers and evolve siblings, so it adds exposure (≤ 1 extra maker execution per triggered root) but no new privilege. **No automatic promotion before S5** | not live (design only, PR #950) |
| G0.4 | **WIP:** ACE-001, STE-001 and X1 have verdicts, and `wipCheck` is green with STR-001-PROD added | X1, STE and ACE stop 11-06, 11-14 and 11-15; earliest start **2026-11-16** |
| G0.5 | **Period boundaries live:** PR #1091 (`experiment_period_boundaries`, `treatment_env`) is merged and deployed, and STR-001-PROD declares the §4 `treatment_env` list | open (#1091) |
| G0.6 | **Endpoint sources on** for the whole run: `GRADED_FITNESS_MODE=shadow`, `SETTLEMENT_EXECUTION_MODE=shadow`, `FAIL_BEFORE_PASS_AFTER_MODE=shadow` | on |
| G0.7 | **Implementation PR merged** with failing-first tests (see below), plus one end-to-end smoke on a non-population goal | not built |
| G0.8 | **Admission expiries defused (O3):** no runtime admission of the maker species expires during the run | open (#1091) |

**What the G0.7 tests must cover:**
- `off` is byte-identical;
- the golden buckets;
- the root key along the lineage;
- the text-hash and leak refusals;
- the adoption rule;
- no bandit outcome from the retry;
- the scorer: mutant set, per-mutant cap, baseline-red and infra classes, target restore;
- `str_prod` metadata at the trigger only.

## 10. Experiment registry

`experiment-registry.ts` cannot hold a planned entry without activating something, so **no entry is added before the start**:
- `ExperimentDef` has no status field, so a definition counts as active.
- `stop_by: null` lands in `no_stop_date`. The stall watch then reports it, and `experiment-registry.test.ts` asserts `no_stop_date` is empty.
- A fifth `oracle_goals` definition fails the static `wipCheck`.

The start PR adds the entry with these values:
- id `STR-001-PROD`, flag `STR_PROD_001_MODE`, this protocol, population `oracle_goals`;
- `treatment_env` as in §4;
- `started_at` = the start, `target_n` 86;
- `stop_by` = start + 87 d.

The static `wipCheck` counts registered definitions, closed ones included: today ACE-001, STE-001, X1 and memory-holdout are 4
of 4. The start PR must make the guard skip definitions with a recorded close or verdict. An `approved_over_limit` reason
would hide a real WIP breach, and that is not allowed here.

## 11. Guardrails

- No new dependency.
- No change to the TG or gym surface, the frozen protocols of other experiments, auto-merge, the bandit or settlement.
- No prod write except through the flag and the code path above.
- The retry never sees a mutant, a score or a settlement result.
- At the readout, raw per-root results go to `docs/research/str-001-prod/results.json`, with secret-shaped strings redacted.

## Amendments

Amendments are appended below the fingerprint line, dated, with a reason. They never change the text above it.

---
PREREG_SHA256: 0b5d6ea568b5afedfb6581da5fd48a91b648354928972eee72a349877f736cc8 (sha256 of everything above this line; computed 2026-10-29 for revision r3, before any STR-001-PROD runner, flag or enrolled goal existed)
