# Experiments: AW-0 ideas tested on DjimitFlo

Nothing in this file has been run. These are proposals. Each one lists what already exists, so no capability is built twice ([CAPABILITY_INVENTORY.md](CAPABILITY_INVENTORY.md)).

## 0. Constraints these designs respect

| Constraint | Value | Consequence |
|---|---|---|
| Verified outcomes | ≈ 118 per 30 d (≈ 4/day) | Prospective arms on "verified" take months |
| Completed maker leases | ≈ 192 per 30 d (≈ 6.4/day; 353 leases in total) | The unit of analysis for a transition predictor |
| Label noise | 38.8–48.6 % of non-verified outcomes are environment failures; maker-attributed failures are 22.3 % | Use executed checks as the primary label; filter by attribution in sensitivity analyses |
| Delayed label | 14-d survival: 22 survived / 0 regressed | Not a usable label (no variance) |
| Gym caps | remote ≈ 40/day (plan, 23-10); local default 12/day | Gym-based arms compete with the epoch-1 trial |
| WIP | `EXPERIMENT_WIP_LIMIT = 4`; 6 active (2 grandfathered); **no free slot** | **No new prospective production arm.** Offline replay on existing records needs no slot (precedent: MFR-001 offline phase, L3-v2 §9). |
| Hard limits of this programme | no prod writes, no flag changes, no paid model calls, no new services | Offline only. Local model on the RTX 2060. Reads use existing read paths. |
| Decision-grade forecasts | n ≥ 100, ≥ 10 positives, skill CI excludes 0 (forecast-scoring.ts:154) | Reuse this rule unchanged |

### Power reference for Brier skill (simulation, this review)

The setup is a perfectly calibrated forecaster against a constant base rate. This is a best case: real forecasters are miscalibrated, so they need more data. Cluster bootstrapping by goal adds a design effect of about 1.2–1.5.

| Base rate | Forecaster AUC | Brier skill score (BSS) | n for 80 % power, two-sided α 0.05 |
|---|---|---|---|
| 0.35 | 0.66 | 0.07 | ≈ 390 |
| 0.35 | 0.70 | 0.12 | ≈ 230 |
| 0.35 | 0.74 | 0.17 | ≈ 140 |
| 0.50 | 0.66 | 0.08 | ≈ 360 |
| 0.50 | 0.70 | 0.13 | ≈ 190 |
| 0.50 | 0.79 | 0.25 | ≈ 75 |

Reading: **the V2 minimum (n = 100) only detects a strong predictor (AUC ≳ 0.76).** To detect a useful but modest one (AUC ≈ 0.70) you need **≈ 250–350 leases**, which is about 40–55 days of completed maker leases. If at least two months of history exist with reconstructable pre-dispatch context, one offline pass can decide. A census is the first step.

## 1. The five architectures

| Arm | Architecture | What already exists | Status |
|---|---|---|---|
| **A** | Current baseline: rule-based, event-driven loop (retry/split/sibling within budgets), no outcome prediction | All of it (loop-lifecycle-service, evolve-selection) | Incumbent |
| **B** | Planner + skills: skill/playbook lines condition the maker | Skill cards (record-only), playbook gene, epoch-1 trial genome `g-d14c1156` (gym) | **Already under test. Do not duplicate.** E0 trial power is only 0.17–0.31 (EPOCH1 prereg). |
| **C** | Planner + learned transition predictor: a calibrated P(checks pass) before the maker runs, used to defer, escalate or pick a runtime | Scoring (forecastScoresV2), substrate (judgment-service + local System One), marginal baselines (EP posterior, base-rate forecaster) | **Missing piece = per-lease predictor (H1)** |
| **D** | Joint model: one trained network generating plan + predicted outcome + action (AW-0-style) | Soup precondition (≥ 300 gym attempts / ≥ 200 tasks / ≥ 100 failures / holdout ≥ 100) as a gate | Blocked: data, hardware (FEASIBILITY O1) |
| **E** | Hybrid predictive replanning: on a failed lease, choose the retry operator (plain retry / strengthen-assertions / split / escalate) by predicted advantage. This is AW-0's own stated fix for its validity-only arbiter. | Operators exist (STR-001 strengthen retry Δ +0.316 kill, n = 40; MFR-001 falsified); retry lineage on leases | Needs H1 plus paired per-operator outcomes |

**Ordering logic.** C and E both depend on the existence of predictable signal, which is H1. B is already running. D is gated by data volume. So H1 comes first and costs the least.

## 2. Hypotheses

| ID | HYPOTHESIS | MECHANISM | BASELINE | PRIMARY METRIC | FAILURE CRITERION | REQUIRED SAMPLE | DECISION RULE | Exists? / WIP slot |
|---|---|---|---|---|---|---|---|---|
| **H0** (census, prerequisite) | Enough historical maker leases exist with (a) stored `deterministic_checks`, (b) pre-dispatch context reconstructable as of lease start, and (c) both outcome classes present | — (data audit) | — | Count of eligible leases; positives/negatives; span in days; fraction with `plan_json` | < 100 eligible or < 10 per class | All rows, read-only | ≥ 250 eligible → run H1 offline in one pass. 100–249 → run H1 but report as "estimate, not decision" unless the V2 rule is met. < 100 → H1 must wait for prospective shadow (needs a slot). | New, read-only. No slot. |
| **H1** (smallest first experiment: shadow transition predictor) | An existing local LLM, given only pre-dispatch context, predicts whether a maker lease's deterministic checks will all pass, with calibrated skill beyond the base rates we already compute | judgment-service-style typed `noul` question → local System One (Qwen3.6-35B-A3B, RTX 2060). p comes from the top logprobs. Context: work item and goal text, acceptance criteria, lane, runtime@model, genome id, retry lineage with prior outcomes; **no** post-dispatch fields (no `changed_files`, no diff, no checker output). Every row stamped with `as_of` < lease start (DI-001). | B0: trailing per-lane base rate with V2 shrinkage (k + 0.5)/(n + 1). B1: effort-controller `fitnessPosterior(lane, species).mean_clean`. B2: logistic regression on tabular lease features (FEASIBILITY O3), fit on the earlier half. B3: environment pre-flight proxy, i.e. how much of the failure share is attributed `environment_failure` (O5). | **Brier skill score vs the best of B0/B1** on the temporally later half. Cluster bootstrap by goal (B = 2000), the same code path as forecastScoresV2. Secondary: AUC, calibration slope and intercept, BSS vs B2. | BSS 95 % CI upper bound ≤ 0; or point BSS ≤ 0 at n ≥ 250; or calibration slope outside [0.5, 1.5] after a single isotonic recalibration fitted on the train half | ≈ 250–350 test-half leases for a modest effect (AUC ≈ 0.70, BSS ≈ 0.12); minimum per V2: n ≥ 100 with ≥ 10 positives | **GO to prospective shadow (H1b)**: V2 decision_grade vs B0 and B1, and BSS > BSS(B2). **ITERATE**: point BSS > 0 but CI includes 0, or the LLM ties B2 (the LLM adds nothing over tabular features; keep B2 only). **REJECT** and register a negative-evidence entry: BSS ≤ 0 at n ≥ 250. | **New.** Not a duplicate: forecasters predict proposal → verified; EP is marginal per lane × species. Offline, so **no slot**. $0. |
| **H1b** | H1 holds prospectively | Same predictor, written as shadow `judgments` at dispatch time | Same | Same | Same | Same rule, over ≈ 40–55 days | Same as H1 | Needs a WIP slot (or folding into an existing registered forecast experiment). **HOLD.** |
| **H2** (C → V → A ordering) | Conditioning the predictor on the plan (planner `plan_json` / chosen skill or playbook / planned target files) improves Brier over task-text-only context | AW-0 ablation: C → V → A 71.1 vs V → C → A 48.3; the plan should shape the predicted outcome | H1 predictor without plan fields, same leases | Paired Brier difference (with plan − without), cluster bootstrap | CI includes 0 at the H0-available n; or plan-conditioned is worse | Paired; with expected gain ≈ 0.01 and SD ≈ 0.08, **≈ 500 pairs**. Likely underpowered: report as an estimate. | Adopt plan-conditioning as the default predictor input only if the CI excludes 0. Otherwise keep the simpler context. | New. Same replay, no slot. Only leases with a planner lease are eligible. |
| **H3** (C: predictor-gated defer/escalate, offline counterfactual) | Deferring leases with p̂ < τ saves maker tokens at an acceptable loss of verified outcomes, better than the lane-level rule implied by EP | Skipping a run has an exactly identified counterfactual (nothing runs, nothing is verified, tokens are saved), so the trade-off curve is computable from logs. Indirect effects (freed capacity, re-queues) are not identified. | Lane-level skip by the B0/B1 posterior at the same token budget | Verified outcomes lost per 1 M maker tokens saved, at τ chosen on the train half, evaluated on the test half | No τ beats the lane-level rule; or any τ loses > 10 % of verified outcomes for < 20 % token savings | The H1 test half (≈ 250–350) | Proceed toward a prospective C arm (needs slot + approval) only if H1 = GO and H3 dominates the lane-level rule. The predictor may only **defer or escalate to a human**, never approve, merge or promote (NE-001 scope; `EFFORT_FLOOR`). | New, offline. Depends on H1. |
| **H4** (B: planner + skills) | Playbook lines from skill cards raise the gym/holdout success of the maker | Skills condition the action (AW-0: code with skills 71.1 vs code without skills 63.3) | Baseline genome | Per the epoch-1 prereg (paired McNemar on the 40 + 40 holdout) | Per the prereg | Per the prereg (E0 power 0.17–0.31 → probably inconclusive) | Per the prereg. **No new experiment.** If the readout is inconclusive, the AW-0 port of skill admission rules (failure taxonomy) stays HOLD until `skill_version` is bound to executions. | **Exists** (epoch-1 trial, `g-d14c1156`). Already counted. |
| **H5** (E: hybrid predictive replanning) | Choosing the retry operator per failed lease by predicted advantage beats "always the best single operator" | AW-0 J.2/L: validity-only arbitration lost 17.7 pp; arbitration on expected advantage is the stated fix | Always-STR (strengthen-assertions) for test-writing leases; plain retry for others | Held-out Stryker kill (test leases) or checks-pass (others), paired per item | No heterogeneity: the per-item best operator equals the overall best in ≥ 90 % of items; or the selection policy's CI includes 0 vs always-best | ≈ 140 paired items for 15 pp at discordance 0.40 (L6 planning rule). Today only 42 rebuildable MFR/STR items exist. | **HOLD** until H1 = GO and ≥ 140 paired operator outcomes exist. Then run offline in the STR-001 harness (no slot). | Operators exist; the selection policy is new. MFR-001 (NE-013) shows operators can hurt. |
| **H6** (D: joint model) | One trained model over (plan, predicted checks, diff) beats the modular C | AW-0 MoT joint denoising (71.1 vs AR 54.5 *within one model*; no modular baseline in the paper) | Arm C | Paired McNemar on a holdout of ≥ 100 vs prompt-only | Soup precondition not met | ≥ 300 gym attempts over ≥ 200 tasks, ≥ 100 failures, holdout ≥ 100 (SOUP_DECISION); realistically 10⁴+ aligned trajectories | **REJECT for now.** Reopen only if the precondition is met **and** H1 shows a learnable signal **and** a CUDA host exists. | Not built. Gated. |
| **X-DEDUP** (AW-0 "seeds are not scenes") | The holdouts' nominal n overstates effective n because of duplicate or near-duplicate items | RoboTwin collapses consecutive seeds onto one scene; our analogue is the same file + same mutant operator + same content hash | Nominal holdout counts (`gym_holdout*`, epoch-1 40 + 40) | Effective n after content-hash dedup; recomputed trial power | Duplicates ≤ 5 % (no action) | All holdout rows, read-only | Duplicates > 5 % → recompute the epoch-1 power and annotate the prereg. Duplicates > 10 % → propose a dedup step in holdout-manifest freeze (normal PR review). | New, read-only. No slot. |
| **X-RETRY** (AW-0 "hopeless retry" skip) | A measurable share of retries repeat the previous attempt's diff on an unchanged failing state, and they almost always fail | AW-0 Algorithm 2 line 11: skip if "already failed on stage k and nothing has changed" | Current retry budget rules | Share of retries with an identical diff and unchanged failing checks; their success rate | Share < 5 % or success rate not lower than other retries | All retry lineages (`retry_of`, `retry_attempt`) with diffs (`gym_attempt_diffs`; prod diff hash availability UNKNOWN) | Share ≥ 10 % with success < ½ of other retries → propose a no-repeat rule (normal PR review). | New, read-only. Data availability is uncertain. |

## 3. The smallest first experiment, specified (H0 → H1)

**Why this one.** It needs no new model, service, flag, prod write or WIP slot, and costs $0. It answers the question every other arm depends on: is the next observation predictable before the maker acts, beyond what we already compute?

1. **Census (H0)**, read-only, via the existing read path. Count maker leases with `deterministic_checks`. For each lease, record the lease start time, lane, runtime@model, genome, retry lineage, the linked goal and work item, whether a planner lease and `plan_json` exist, and the realised label. Label = all non-hidden deterministic checks exit 0 (`withoutHiddenChecks`). Also record the attribution class and the checker verdict as secondary labels. Exclude leases with no checks recorded (cancelled or timed out) and report the exclusion count. Check that nothing in the context is timestamped at or after lease start.
2. **Freeze the pre-registration** before any prediction: question text, context template (sha256), model id and quantisation, decoding (single token, top logprobs), temporal split (first half calibrates and fits B2, second half is the test set), exclusions, primary metric, decision rule from §2. Store it in-repo as `H1_PROTOCOL.md` with a `.sha256`, following the MFR-001/STR-001 convention. That is a later PR, not this one.
3. **Predict offline.** Run the frozen prompt over the test-half leases on the local System One (RTX 2060). Write the results to a local file, **not** to prod `judgments`. Replicate a 10 % subset to measure nondeterminism (variance of p under repeated calls).
4. **Score** with the forecastScoresV2 statistics (trailing base rate, cluster bootstrap by goal) against B0, B1 and B2. Report BSS, AUC, a reliability diagram, and the decision per the rule.
5. **Report** as `docs/research/aw0/H1_RESULT.md`. Record a negative result in the negative-evidence registry if REJECT.

Draft question (typed `noul`): *"Given only the information below, recorded before this maker started, will every deterministic check on the maker's result pass? Answer yes or no."* The context lists lane, runtime@model, task/goal text and acceptance criteria, target-file hints from the plan (H2 arm only), and prior attempt outcomes in this lineage.

**Known threats.**

- Leakage through task text written after earlier attempts. Mitigated by stamping `as_of` and `context_at` and dropping post-resolution context, as in DI-001.
- Environment failures dominating the label. Mitigated by an attribution-filtered sensitivity analysis and the B3 comparison.
- Distribution drift between halves. This is the realistic deployment condition, so it is kept.
- Model nondeterminism. Measured in step 3.
- The local model being unavailable. This only delays the experiment. No paid model is used.
