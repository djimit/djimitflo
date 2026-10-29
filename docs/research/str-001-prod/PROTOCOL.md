# STR-001-PROD — the "strengthen the assertions" retry as a production procedure (pre-registration)

Status: **pre-registered, not started** (2026-10-29). This document is committed alone, as the first commit of branch
`docs/str-001-production-protocol`, before any code that can deliver the treatment or produce an outcome exists. No flag is
turned on and no registry entry is activated by this PR. Starting the experiment is an operator decision, and it may only happen
once every precondition in §9 holds.

Sources:
- STR-001 Stage A (`docs/research/eco/STR-001_STAGE_A_PROTOCOL.md`, sha256 `87c8927f…3a47`;
  result `docs/research/eco/STR-001_STAGE_A_RESULT.md`, SUPPORTED).
- Learning roadmap of 2026-10-29, stage 1 ("close one loop end to end").
- Teardown of 2026-10-29: `B-intelligence.md` (volumes, labels) and `E-assumptions.md` (A18: experiments share one goal
  population; A16: survival cannot fail).

## 1. Why this exists, and what it is not

- **Stage A result.** Offline, on the 40 MFR-001 items, the strengthen-retried test killed more independent Stryker mutants
  than the original test.
  - Kill share went from 0.158 to 0.474: Δ **+0.316** [+0.233, +0.402], 36 up / 3 down / 1 same, Holm p 1.8 × 10⁻⁸.
  - The fresh gym-mutant family agrees: Δ +0.343.
- **What Stage A did not show.**
  - It did not compare against a same-budget fresh attempt (Stage B).
  - It used one maker family: atomic-agent 0.6.5 with qwen38-27b. Production makers are almost all `opencode@glm-5.2:cloud`.
  - The gain was close to proportional to the added test code: slope +0.167 per 100 added lines, intercept ≈ 0.
    Retries with ≤ 202 added lines still gained **+0.200** [+0.117, +0.296].
- **What this experiment asks.** It is the production question: *on real oracle-lane goals, does one strengthen retry after
  the maker's first passing attempt raise the fresh-mutant kill share of the delivered test, at an acceptable cost and without
  lowering the verified rate?*
- **What it is not.**
  - It is not a mutant-feedback retry. Showing mutants is falsified (MFR-001, NEGATIVE_EVIDENCE "Mutant-kill feedback retry
    for exports-lane test makers"): the retry never sees a mutant, a graded score or a settlement result.
  - It is not a change to any running experiment's treatment, population or analysis (§4).

**Hypothesis H-STR-P:** for exports-lane and test-gap-lane goals, delivering the strengthen retry raises the mean fresh-mutant
kill share of the delivered test.
**H0:** the difference (retry − none) is ≤ 0.

## 2. Population: which lanes have a graded value label

The decision is made from the label data the teardown measured (`B-intelligence.md` §1–2, 30 d to 2026-10-29).

| lane | 30 d makers / verified | graded label at maker time | fresh-mutant label at settlement | in STR-001-PROD? |
|---|---|---|---|---|
| `test-gap#exports` (exports) | 136 / 87 | `metadata.graded` kind `mutant_kill`: ≤ 3 seeded gym mutants (`graded-fitness.ts recordMakerGraded`), n 66 verified graded; verified-vs-kill AUC 0.45 | `settlement_execution.answers.kill_share_now`: fresh mutants seeded `S<main sha>`, minus the maker-time ones (`settlement-execution.ts`) | **yes** |
| `test-gap` | 33 / 14 | the same `mutant_kill` machinery (`laneOf` → `test-gap`); sparse, with 3 graded test-gap leases in the 21-10 MFR export | the same | **yes** (a stratum) |
| `mutation-gap` | 111 / 42 | kind `mutation_score`: the lane's own `test:mutation:grounded` Stryker score, which is the maker's optimisation target; mean 0.90 (ceiling); 0 non-verified graded | computed, but `kill_share_maker` is null (not a mutant-kill kind) | **no** |

Mutation-gap is excluded for four reasons:
- Its maker-time label is the score the maker was told to raise, not an independent value label, and it sits at a ceiling of 0.90.
- Its first attempt is already a "kill these surviving mutants" task, which is the falsified MFR-001 treatment family.
- Stage A covers only exports-lane tests.
- Its diff cap (400 lines) differs from the other two lanes (200).

It can be a later, separately registered extension.

**Unit.** One unit is the **root goal**: a goal, or, for a requeue successor, the first goal of its requeue lineage. Every run,
requeue successor and evolve sibling of a root goal shares its arm.

**Eligible.** A root goal is eligible when all of these hold:
- it was created at or after the start timestamp (§9) from a `gap_analysis` proposal;
- `laneOf(evidence)` is `exports` or `test-gap`;
- its repo is the primary repo (settlement runs on the primary repo only);
- it is not a gym, manual, feedback, reflection or refinement goal.

**Trigger (entry into the analysis).** The goal's delivered maker reaches the trigger point: the maker lease that goes to the
reviewers, after evolve selection.
- That lease is `completed`, its deterministic checks pass, and it changed a test file.
- The test file is found by the rule `recordMakerGraded` uses: the proposal's `artifactPath` if changed, else the first changed
  test file.
- Both arms are identical up to the trigger, so entry is pre-treatment and cannot be biased by the arm.
- The trigger rate per arm is reported as a check; it must not differ beyond chance.

## 3. Treatment and control (frozen)

### Assignment

- **Bucket.** `bucket = uint32(first 4 bytes of sha256('str-prod-001:' + root_goal_id)) mod 100`.
- **Experiment mode.** Arm `retry` when bucket < 50, else `none`.
- **Recording.** The arm, bucket, salt `str-prod-001:` and the text hash are written to the loop run's metadata (`str_prod`) at the
  trigger point. Nothing is recorded for a goal that never triggers.

### Treatment `retry`

Exactly one retry maker lease runs in the same loop run, right after evolve selection and before checker dispatch.

**What the retry gets.**
- **Species.** The same runtime and model as the delivered maker. It is not a new bandit draw.
- **Caps.** The same lane caps: timeout, step budget and `diff_max_lines` (200 for these lanes), counted exactly as the gate counts it today. No cap is raised.
- **Dependency arm.** The same MAKER-DEPS-001 arm as the goal, because that arm is per goal.
- **Starting state.** The worktree holds the delivered test file as the delivered maker left it.

**The instruction is the frozen text below**, rendered once and sent as the retry's task instruction.
- The lane's ordinary maker template wraps it, as for any maker of that lane. The wrapper is the same in both arms; the only
  arm difference is whether the retry happens.
- Template, verbatim, one line, UTF-8, with no trailing newline:

  `Retry of a test-writing task: the vitest test file {test} already exists and covers {target}, but it is too weak: a subtly broken {target} can still pass it. Edit {test} so that it still passes against the real {target} and fails when {target} is subtly broken. Keep importing {target} with a relative import, do not mock it, skip nothing, and make it pass with: cd packages/server && npx vitest run {test_rel}. Change only {test}; do not edit {target} or any other file. Strengthen the assertions of this test.`

- Template sha256: **`1a7cc5b85ae01a9f0d92ef434e9917406cd46984e4ed7e5126ed2491e2c8710f`**.
- **Placeholders.**
  - `{test}` is the repo-relative path of the delivered test file.
  - `{target}` is `gradedTarget(test, proposal target)`.
  - `{test_rel}` is `{test}` without its leading `packages/server/`.
- **Rendering.** Replace `{test_rel}` first, then `{test}`, then `{target}`.
- **Source.** This is the MFR-001 CONTROL text, which is the STR-001 Stage A "strengthen" arm: `scripts/mfr-001/lib.mjs buildPrompt`, arm `control`.
  - The file sha256 is `16334c1b…0fcd`, which equals the MFR-001 pin.
  - For `test = packages/server/src/__tests__/usage-telemetry.exports.test.ts` and
    `target = packages/server/src/services/usage-telemetry.ts`, the rendered text equals `buildPrompt` byte for byte. Its sha256 is
    `2747d68433ce41602af0b0ab7193f3680c9b227b4aa00bcbaac7c028d5b8a0aa`.
  - The fingerprint test pins both hashes.

**Runtime guards.**
- The runner recomputes the template hash before every retry. On a mismatch it delivers no retry and records `text_mismatch`.
- The retry input never carries a mutant key, a mutant description, a graded score, an FBPA result or a settlement result. This is checked before sending, in the spirit of MFR-001 `assertNoLeak`; a hit means no retry and `leak`.

**Adoption.**
- The retry is **adopted** only when both hold:
  - its deterministic checks pass under the same `daemonCheckOptions`;
  - its diff against the delivered maker changes only `{test}`.
- Otherwise the delivered first attempt stays the active maker, and the retry is recorded with one of these classes:
  - `retry_failed_checks`
  - `retry_no_change`
  - `retry_timeout`
  - `retry_scope_violation`
  - `retry_error`
  - `retry_needs_approval`
  - `text_mismatch`
  - `leak`
- **Approval.** A retry that needs an approval it cannot inherit is not parked. The first attempt is delivered and the class is
  `retry_needs_approval`. The approval route is the one evolve siblings use: auto-approve in the auto-approved lanes, else
  strict inheritance.
- **Bandit.** The retry lease writes no bandit-read maker outcome (`loop-maker:<loop>:<runtime>`). The bandit posterior and every other experiment's attempt counts see the same attempts as without STR.
- **After adoption.** Grading (`recordMakerGraded`, `recordFailBeforePassAfter`) runs on the adopted lease. The first attempt
  keeps its own graded row, written before the retry; that row is a pre-treatment covariate.

### Control `none`

- No retry. Everything else is today's behaviour.

### Budget accounting (both arms)

- The cost of a goal is the tokens of every maker and checker lease of all its runs. That includes the retry lease in `retry`.
- The token-unknown share is reported per arm.
- Caps are identical in both arms.

### After promotion (§8)

- A permanent **10 % holdout**, drawn with a separate salt: `hbucket = uint32(first 4 bytes of sha256('str-prod-001/holdout:' + root_goal_id)) mod 100`.
- Arm `none` when hbucket < 10, else `retry`.

## 4. Isolation from ACE-001, STE-001, MAKER-DEPS-001, F2 v2 and X1

**Choice: salted, independent assignment on the shared population, without exclusion.** STR-001-PROD takes its own salt,
`str-prod-001:`, on the root goal id. Every running oracle-population experiment keeps its registered population, assignment
and analysis unchanged.

**The salts are independent.** The STR-001-PROD salt shares no prefix with any other: `ace-001:`, `ste-001:`,
`maker-deps-001:`, `effort-x1:` and `checker-family:v2:` (F2 v2). The assignments are therefore statistically independent.
- In expectation each of their arms holds the same share of STR `retry` goals.
- Their main-effect estimates stay unbiased.
- STR adds only variance and a possible interaction.

**Why not exclusive assignment.** Exclusive assignment means STR goals are excluded from the other experiments' analyses. It would break the running experiments:
1. It would be a post-hoc change to frozen analyses. The registered populations of MAKER-DEPS-001 and F2 v2 contain these goals.
2. The STR population is about 70 % of all verified oracle-lane work: exports plus test-gap is 101 of 143 verified in 30 d.
   - Excluding it would cut MAKER-DEPS-001 (52 / 63 terminal of 141, stop 2026-12-16) and F2 v2 (stop 2027-01-15) to a fraction of their accrual. Both would miss their registered targets.
   - A small reserved STR-only slice would instead need ≈ 160 days at the current volumes.

**Which experiments overlap.** By §9 G0.4, STR-001-PROD does not start before X1 (stop 2026-11-06), STE-001 (2026-11-14) and
ACE-001 (2026-11-15) have recorded verdicts. The only concurrent oracle-population experiments are then MAKER-DEPS-001 and
F2 v2. In each, the STR treatment is downstream of their own treatment:
- the retry inherits the goal's dependency-preparation arm;
- the F2 checker reviews whatever maker is active, so it sees the retried diff in `retry` goals, equally in both F2 arms.

**Analyses that must stratify.**
- **STR's own primary.** The bootstrap is stratified by lane. A balance table of STR arm × MAKER-DEPS-001 arm and STR arm × F2 v2 arm is reported, with Δ within each stratum (descriptive).
- **Any other analysis.** An analysis that pools oracle-lane goals created after the STR start stratifies by
  `str_prod.arm ∈ {retry, none, not_triggered, not_eligible}`, or reports STR arm as a factor. This covers MAKER-DEPS-001 and F2 v2 sensitivity analyses, the learning ledger and the bandit's OPE.
- **The start is a period boundary.** It is the first goal with `str_prod` metadata, and pooling across it without that stratum is not allowed (E-assumptions C8). Their registered primaries are not amended by this document.
- **Later experiments.** Any later experiment on the oracle-goal population uses its own independent salt and stratifies by `str_prod.arm` the same way.

## 5. Endpoints

### Primary: fresh-mutant kill share at settlement (the U1 label)

- **The value.** The `kill_share_now` of the goal's PR in its `settlement_execution` judgment: the delivered test re-run at
  origin/main against fresh seeded mutants of the target, ≥ 14 d after merge.
  - The continuous kill share is the endpoint. The binary U1 pass / fail is secondary S4.
  - Neither attempt, nor any maker in the run, ever saw these mutants.
- **A unit is labelled** when its PR merged and its settlement row carries a numeric `kill_share_now`.
- **Fallback: graded kill at verification.** It is used only when §9 G0.1 fails at the start and the operator starts anyway, recorded before the first enrolment.
  - The value is the `metadata.graded.score` (kind `mutant_kill`) of the delivered (adopted) maker lease. Its mutants are seeded by the run id and no maker in the run saw them.
  - The primary label is fixed before the first enrolled goal and **never switched afterwards**.
  - If the chosen label stops being produced, enrolment pauses, and the label is not switched. "Stops being produced" means ≥ 7 d with no `settlement_execution` tick, or `GRADED_FITNESS_MODE` off.
- **Not survival.** 14-day line survival cannot fail (49/49 settled survived; E-assumptions A16) and is not an endpoint.

### Secondary (reported, they do not decide alone except the guards in §7)

| | measure |
|---|---|
| S1 | verified rate per triggered goal (ITT), Newcombe 95 % CI of retry − none |
| S2 | tokens per verified goal: total and in + out, ratio retry / none with a goal-bootstrap CI; token coverage per arm |
| S3 | fail-before-pass-after pass share among delivered tests with a decisive FBPA verdict (`recordFailBeforePassAfter`, shadow) |
| S4 | the other label: graded kill at verification when U1 is primary, else U1; plus the U1 binary pass rate |
| S5 | mechanism, within `retry` goals that adopted: graded(retry) − graded(first attempt) on the same run-seeded mutants (the Stage A analogue), with the sign test |
| S6 | adoption classes; retry added lines; label yield (labelled / triggered) and merged share per arm; settlement `fail` rate; auto-merge share |
| S7 | precision: the primary Δ adjusted by ANCOVA for the first attempt's maker-time graded kill share (pre-treatment) and lane |

## 6. Power, n and duration

**Effect size for the design.** The design effect is δ = **+0.20**, not Stage A's +0.316:
- Production makers run under a 200-line diff cap. In Stage A, retries with ≤ 202 added lines gained +0.200 [+0.117, +0.296].
- The production maker family differs from the Stage A one.
- About 8 % of delivered exports tests already kill every seeded mutant (5/66), so they have no headroom.

**Spread.** σ = 0.35, a conservative SD for a kill share on 3 mutants.
- Maker-time exports scores, mean 0.263 with 31/66 below 0.2 and 5/66 at 1, imply σ ≈ 0.31.
- The settlement mean is 0.413 (n 42).

**Test.** Two-sample, one-sided α 0.025 (the 95 % CI lower bound > 0), power 0.80, normal approximation, goal-level.

| design δ | σ 0.30 | **σ 0.35** | σ 0.40 |
|---|---|---|---|
| +0.316 (Stage A) | 15 | 20 | 26 |
| **+0.20 (Stage A small-retry subset)** | 36 | **49** | 63 |
| +0.15 | 63 | 86 | 112 |

**Required n: 49 labelled goals per arm** (98 labelled). The acceptance minimum is 30 labelled per arm.

**Operating characteristics** (σ 0.35, normal approximation):

| true δ | at 49 / arm | after the one extension (98 / arm) |
|---|---|---|
| 0 | P(SUPPORTED) 0.025, P(FALSIFIED) 0.29 | P(SUPPORTED) 0.025, P(FALSIFIED) 0.52 |
| +0.10 | 0.29 / 0.025 | 0.52 / 0.025 |
| +0.20 | **0.81** / 0.00 | 0.98 / 0.00 |
| +0.316 | 0.99 / 0.00 | 1.00 / 0.00 |

The two looks (first readout and extension), each at nominal one-sided 0.025, give an overall one-sided type-I error of
≈ 0.042. This is accepted because the treatment already has a confirmatory offline result.

**Accrual from current volumes** (`B-intelligence.md`, 30 d window).
- **Verified.** Exports plus test-gap gave 87 + 14 = 101 verified in 30 d. The window crosses the 1.5-day lost window, so the rate is ≈ 3.5 per day, and 3.4 per day is used. Verified is a lower bound for triggered goals.
- **U1 label yield.** It is ≈ 0.60 per verified: 71/101 merged × 42/49 settlement executions with a numeric `kill_share_now`.
  - That gives ≈ 2.0 labelled per day, or ≈ 1.0 per arm per day.
  - Exports alone would give ≈ 0.93 per arm per day.
- **Fallback label yield.** It is ≈ 0.76 per verified (66/87 exports verified graded), which gives ≈ 1.3 per arm per day and no lag.

**Expected duration.**

| primary label | enrolment to 49 / arm | label lag | readout |
|---|---|---|---|
| U1 (settlement) | ≈ 49 d | merge + 14 d settlement + tick / merge slack: 21 d after the last enrolment | **≈ start + 70 d** |
| fallback (graded at verification) | ≈ 38 d | ≤ 2 d | ≈ start + 40 d |

- **Enrolment stops** when the enrolled triggered goals reach 82 per arm (49 / 0.60) or at **start + 56 d**, whichever comes first.
- **Readout.** It runs once, at enrolment stop + 21 d (U1) or + 2 d (fallback), on every labelled unit enrolled in the window.
  - The maximum first readout is start + 77 d.
  - With the earliest start of 2026-11-16, the expected readout is ≈ 2027-01-25.
- **Honest note.** The roadmap's "2–4 weeks" for stage 1 is not reachable on the U1 label at δ 0.20 with today's volume. It is reachable only if the true effect is near Stage A's (20 per arm ≈ 20 d + 21 d), or with more units of selection (roadmap stage 2).

## 7. Stop rules, readout and decision

**Harm-only monitoring.**
- **What is computed.** Weekly, from ≥ 20 triggered goals per arm, the harm metrics only. The primary contrast is never computed before the readout: no peeking and no efficacy stop.
- **Stop at once** (flag to `off`) when any of these holds:
  - **H1.** Verified rate retry − none ≤ −0.15, with the Newcombe 95 % upper bound < 0.
  - **H2.** Any retry diff that touches a non-test file reaches a PR or main. That should be impossible past adoption, so it is an incident.
  - **H3.** Settlement `fail` (test red at main) in `retry` is ≥ 3 and ≥ 2 × the `none` rate.
  - **H4.** Tokens per verified, retry / none, is > 3.0 at ≥ 20 verified per arm.
  - **H5.** Any retry lease is detected writing outside its worktree or to the control DB. S5 is not live, so detection relies on the existing audits. This is an incident.
- **After a harm stop.** H1, H3 and H4 need a NEGATIVE_EVIDENCE entry with the harm. H2 and H5 are incidents first.

**Maximum duration.**
- First enrolment: 56 d.
- The one extension: +42 d of enrolment, up to 98 labelled per arm.
- Readout after the extension: + 21 d.
- Hard cap: start + 119 d.

**Statistics (single readout).**
- **Δ.** Δ = mean label(retry) − mean label(none) over labelled units, ITT by assigned arm. A `retry` goal whose retry was not adopted stays in `retry` with its delivered first attempt.
- **CI.** Goal-level percentile bootstrap 95 % CI with 10 000 resamples, stratified by arm × lane, seed 20261029.
- **Reported p.** One-sided permutation p of arm labels within lane, with 10 000 permutations, seed 20261030.

**Label-yield guard.**
- **Trigger.** Labelling depends on merging, which happens after treatment.
- **Rule.** If label yield differs between arms by more than 0.10 absolute, SUPPORTED also needs the bound analysis to keep its CI lower bound > 0. In the bound analysis, an unlabelled `retry` unit counts as 0 and an unlabelled `none` unit as the `none` mean. Otherwise the verdict is INCONCLUSIVE.

| Verdict | Condition | Action |
|---|---|---|
| **SUPPORTED → PROMOTE** | CI lower > 0, ≥ 30 labelled / arm, the yield guard holds, S1 point Δ ≥ −0.05, S2 ratio ≤ 2.0, no harm stop | promote with the 10 % holdout (§8) |
| SUPPORTED, NOT PROMOTED | CI lower > 0 but the S1 or S2 guard fails | flag `off`; operator decision with the numbers; no NE entry (the effect is real, the cost is not accepted) |
| **FALSIFIED → REJECT** | CI upper < +0.10, the practical floor (a gain below +0.10 kill share does not pay for one extra maker lease per goal) | flag `off`; a `NEGATIVE_EVIDENCE.yaml` entry in the readout PR |
| **INCONCLUSIVE → EXTEND ONCE** | anything else, including < 30 labelled / arm | extend once under the same rules and analyse once on all units; still INCONCLUSIVE means close INCONCLUSIVE, flag `off`, no promotion, recorded in the learning ledger |

## 8. Promotion mechanics and rollback

**The flag.** `STR_PROD_001_MODE`:
- `off`, the default: no retry and no `str_prod` metadata. It is byte-identical to today's maker phase.
- `experiment`: 50 / 50 by `str-prod-001:`.
- `default`: retry for everyone except the 10 % holdout by `str-prod-001/holdout:`.

The implementation PR registers the flag in `EVOLUTION_FLAGS` (acting) and adds the registry entry (§10).

**Code path.** `loop-daemon.ts`, maker phase of `executeGoal`, as a new step between the end of evolve selection (step 8a) and
checker dispatch (step 8b). It runs:
1. `LoopService.retryLoopRun(run.id, { maker_lease_id })` with the frozen instruction. `RetryLoopInput` has no instruction field today, so that field is the one new surface.
2. Then `runDeterministicChecks`.
3. Then the adoption rule (§3).
4. Then `grade()`.

Nothing else changes: lane templates, caps, the bandit, evolve, the checker, auto-merge and settlement.

**Promotion.**
- It is an operator flag change from `experiment` to `default`, made in the readout PR and recorded there as a dated amendment.
- **It is not automatic before S5** (maker isolation, §9 G0.3). The roadmap's "a win becomes the default automatically" applies only after S5 is live.
- Once S5 is live, a later amendment may let the readout switch the mode itself.

**Holdout monitor and rollback.**
- **Check dates.** The first check is at the first 14-day boundary after promotion that has n_holdout ≥ 5 labelled goals. The expected date is +21 to +28 d, because the holdout gets ≈ 0.34 triggered goals per day.
- **Check frequency.** Then every 14 d until n_holdout ≥ 20.
- **Label.** Graded at verification until the holdout has ≥ 5 U1 labels, then the primary label.
- **Revert** (`STR_PROD_001_MODE=off`, plus a NEGATIVE_EVIDENCE entry "promoted, did not hold") when either holds:
  - at a check, mean(holdout) ≥ mean(default);
  - a harm rule H1–H5 trips with default versus holdout in place of retry versus none.
- **False-revert risk.** The point-estimate rule is deliberately sensitive. At a true +0.20 the false-revert probability is ≈ 0.11 at n_holdout 5 and ≈ 0.04 at 10; at +0.10 it is ≈ 0.27 and 0.20.
- **The holdout is permanent.** It stays after n_holdout ≥ 20, as the standing comparison for the learning ledger.

## 9. Preconditions (gate 0): all hold before `STR_PROD_001_MODE=experiment`

| | precondition | status on 2026-10-29 |
|---|---|---|
| G0.1 | **U1 live.** The settlement kill-share label is recorded in prod (`SETTLEMENT_EXECUTION_MODE=shadow`), the U1 pass/fail label fails ≥ 10 % at n ≥ 30 and agrees with mutant kill (roadmap gate 0). If it does not hold at the start, the operator may start on the fallback label (§5) by an explicit, dated decision before the first enrolment. Recommended: wait unless U1 is > 2 weeks late | **not live**: `kill_share_now` exists in shadow (n 42), U1 is in progress, not merged |
| G0.2 | **Alerts live (O1).** New stalls are persisted and pushed to Telegram, `VALUE_ANOMALY_ALARM=on`, and a replay of the #947 failures alerts within 24 h. The harm rules need someone to see them | not live |
| G0.3 | **Maker isolation (S5).** Recorded, not required to start. Stage 1 **may start without S5**: the retry is one more maker lease of the same species, lane, caps, approval route and worktree confinement as today's makers and evolve siblings, so it adds exposure in proportion (≤ 1 extra maker execution per triggered goal) but no new privilege. **It must not auto-promote before S5**: promotion makes that extra execution permanent on 90 % of goals, so until S5 is live it is an operator action (§8) | **not live** (design only, PR #950) |
| G0.4 | **WIP.** ACE-001, STE-001 and X1 have recorded verdicts, so the experiments on the oracle-goal population without `approved_over_limit` stay ≤ `EXPERIMENT_WIP_LIMIT` (4) with STR-001-PROD added, and `wipCheck` is green | X1, STE-001 and ACE-001 stop 11-06, 11-14 and 11-15. Earliest start: **2026-11-16** |
| G0.5 | **Endpoint sources stay on** for the whole run: `GRADED_FITNESS_MODE=shadow`, `SETTLEMENT_EXECUTION_MODE=shadow`, `FAIL_BEFORE_PASS_AFTER_MODE=shadow` | on per the teardown |
| G0.6 | **Implementation PR merged** with failing-first tests (see below) | not built |
| G0.7 | **Admission expiries defused (O3).** No runtime admission of the maker species expires during the run | open; runtime admissions are due for reassessment before 27-11 |

**What the G0.6 tests must cover:**
- `off` is byte-identical;
- the assignment and holdout buckets for pinned ids;
- a text-hash mismatch means no retry;
- the leak check refuses;
- the adoption rule: failed or scoped-out retries keep the first attempt;
- no bandit outcome from the retry;
- `str_prod` metadata at the trigger only.

The PR also needs one end-to-end smoke on a non-population goal, which is not scored.

## 10. Experiment registry

`experiment-registry.ts` cannot hold a planned entry without activating something, so **no entry is added in this PR**:
- `ExperimentDef` has no status field. Every definition is reported as running, and verdict null counts as active in the WIP report.
- `stop_by: null` lands in `no_stop_date`. The stall watch (`experiment_overdue`) then reports "violates know-when-to-stop", and `experiment-registry.test.ts` asserts `no_stop_date` is empty.
- A fifth `oracle_goals` definition without `approved_over_limit` fails the static `wipCheck` CI guard.

The start PR (after G0.4) adds the entry with these values:
- id `STR-001-PROD`, flag `STR_PROD_001_MODE`, this protocol, population `oracle_goals`;
- `started_at` = the start timestamp, `target_n` 49;
- `stop_by` = start + 77 d, the first readout cap; the extension is a dated amendment.

The static `wipCheck` counts registered definitions, closed ones included: today ACE-001, STE-001, X1 and memory-holdout are 4
of 4. So the start PR must also make the guard skip definitions with a recorded close or verdict. Giving STR-001-PROD an
`approved_over_limit` reason would hide a real WIP breach, and that is not allowed here.

## 11. Guardrails

- No new dependency.
- No change to the TG or gym surface, the frozen protocols of other experiments, auto-merge, the bandit or settlement.
- No prod write except through the flag and the code path above.
- The retry never sees a mutant, a score or a settlement result.
- Raw per-goal results are written to `docs/research/str-001-prod/results.json` at readout, with secret-shaped strings redacted.

## Amendments

Amendments are appended below the fingerprint line, dated, with a reason. They never change the text above it.

---
PREREG_SHA256: 279fb5fe84efe19ee81990c76cec3f5a5a21488571273f883ba16b1adfe8c405 (sha256 of everything above this line; computed 2026-10-29 before any STR-001-PROD runner, flag or enrolled goal existed)
