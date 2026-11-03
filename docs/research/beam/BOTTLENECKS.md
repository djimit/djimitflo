# BEAM-001 Phase 3: bottleneck register

**Prod snapshot:** 2026-10-21 20:34Z, `djimitflo-live` read-only, deploy 5a8d1b9c. Windows: 7 d and 30 d.
**This extends** `ecosystem/bottlenecks.md` (20-10, P0–P5). That file's P0 security and provenance items are mostly closed (#914, #915, #918, #923). This register covers throughput and cost limits on *verified, policy-compliant outcomes per unit of system cost*, and asks whether a model swap could move each one.
**Rule:** a bottleneck is called model-related only when an observation ties it to model behaviour. Tags: FACT, INFERENCE, HYPOTHESIS, UNKNOWN.

## 0. Baseline numbers (FACT, prod)

| Metric | 7 d | 30 d |
|---|---|---|
| Oracle-lane proposals (all `gap_analysis`) | 74: 44 verified, 18 regressed, 9 infra_failed, 3 other | 248: 117 verified, 71 regressed, 29 archived, 27 infra_failed |
| LLM-originated proposals → verified | 0 proposals | reflection 1/319, refinement 0/57, feedback 0/32 |
| Supply caps | test-gap 8/day + mutation 4/day (= 84 per 7 d), in-flight 3 | same |
| opencode maker leases (glm-5.2) | 74: 41 completed, 26 failed, 7 cancelled; 10 timed out | 206 with glm-5.2 recorded (+121 without a model id): 125 completed, 67 failed |
| Maker outcome (skill_outcomes) | opencode 26/70 (37 %), remote 18/26 (69 %) | opencode 89/231 (39 %), remote 26/90 (29 %) |
| opencode maker tokens, completed vs failed leases | 15.24 M vs 15.18 M total (**50 % on failed leases**); uncached in+out 1.62 M vs 1.42 M | 64.4 M vs 61.3 M total (49 %) |
| Per-lease tokens, completed maker (30 d) | — | median 0.40 M total (incl. cache), 29 k uncached in, 4.0 k out; log-SD 0.67 |
| Reviewer verdicts (opencode checker / security) | — | checker: 137 accepted, 20 insufficient_evidence, 4 needs_revision, 1 rejected, 5 none → **15 % non-decisive**. Security: 135 / 19 / 2 / 3 / 1 → **12.5 % non-decisive** |
| Manual security_checker leases | 62 created, 0 completed, 61 cancelled | 263 created, 0 completed |
| Loop PRs | 44 created: 25 auto-merged (mean 12.5 h), 3 human-merged, 16 open (5 audit sample, 11 ineligible) | 114 created: 75 merged (25 auto at 12.5 h, 50 human at 48.7 h), 4 closed, **35 open now, mean age 193 h** |
| Merge survival | — | 22 of 26 settled survived (skill_outcomes domain merge) |
| Verified per day (doc-drift lane) | 3–9 | mean 4.26, SD 2.94 (27 days) |
| Ollama Cloud | 1 weekly-limit outage (18-10 ~14:00Z, 6 runs annotated environment_failure) | same |
| € prices | `docs/usage-plan-limits.json` monthly_eur all null | € per surviving change **UNKNOWN** |

## 1. Register

### B1. Human merge throughput for ineligible and audit-sample PRs
- **Symptom:** 35 loop PRs are open, with a mean age of 193 h. Ineligible PRs that were human-merged took 48.7 h on average; auto-merged ones took 12.5 h.
- **Evidence (FACT):** 7 d: 3 human merges against 16 PRs left open. 30 d: 50 human merges and 35 open.
- **Root cause (INFERENCE):** the operator's review time. Auto-merge (`LOOP_AUTO_MERGE_TEST_ONLY=act`) covers test-only PRs only, keeps a 10 % audit sample for the human, and binds the verified head sha (#914).
- **Alternatives:**
  - batch-merge sessions;
  - widen the auto-merge class only on survival evidence: survival 22/26 today, n too small for ≥ 95 % at n ≥ 100;
  - the assurance report in the PR body (LOOP_PR_BODY_V2), to cut minutes per review.
- **Possible Beam intervention:** none. A faster or cheaper model does not shorten a human queue.
- **Causal experiment:** measure operator minutes per PR before and after LOOP_PR_BODY_V2 (G0.4 metric). This is not a model experiment.
- **Expected effect of Beam:** 0.
- **When Beam would not help:** always, for this bottleneck.
- **Tag:** FACT / INFERENCE.

### B2. Task supply is cap-bound on one repo
- **Symptom:** every verified change in 7 d came from `gap_analysis` (test-gap and mutation sources).
- **Evidence (FACT):** 74 proposals in 7 d against a cap of 84 (88 %). EXTRA_REPOS is not configured, and the security-review-commons token is still with the operator. The finding-fix lane is shadow only (43 findings).
- **Root cause (FACT/INFERENCE):** caps (G1.4 raises them only while verify ≥ 30 %), one repo, and one verifier family. LLM-originated sources have no executable verifier: 1 verified out of 408 in 30 d.
- **Alternatives:** raise caps in steps of 2 (G1.4); second repo (G1.1); finding-fix lane on (G2.2).
- **Possible Beam intervention:** none on supply. A better model cannot make reflection or refinement proposals verifiable.
- **Causal experiment:** the G1.4 cap step with its existing guardrails.
- **Expected effect of Beam:** 0.
- **When Beam would not help:** while supply is the constraint, which is now.
- **Tag:** FACT.

### B3. Maker failures and the tokens they burn
- **Symptom:** the opencode maker completes 55 % of leases in 7 d, 37 % of attempts verify, and half of maker tokens go to failed leases.
- **Evidence:**
  - 7 d (FACT): 29 failed leases, of which 10 timed out, 11 exited 1 without a timeout, and 7 exited 0 but failed checks.
  - DI-001 classification, 213 leases to 14-10 (FACT): 21 of 22 token-brake failures and 19 of 20 wall-timeouts show **environment bootstrap**. Other classes: checks_failed 29 (12 mutation gain not met = oracle doing its job, 8 test failure = maker quality); infra classes about 58.
  - MAKER-DEPS-001 (`MAKER_DEPS_001_MODE=on`) is the running fix for the bootstrap cause.
- **Root cause:**
  - mostly environment and orchestration (FACT, DI-001);
  - a minority is maker quality (8 of 213 test failures, plus some exit-1 cases; INFERENCE);
  - the token volume is mostly cache reads from re-sending context on each step (DI-001: a 1.0 M brake lease ≈ 70 k in, 6 k out, 0.93 M cache read; FACT), so it scales with the step count, not with reasoning verbosity.
- **Alternatives:** finish MAKER-DEPS-001; give the remote workstation species more share (D6 rule; 69 % vs 37 % in 7 d, though 29 % vs 39 % over 30 d, confounded by bandit assignment); cap steps.
- **Possible Beam intervention (HYPOTHESIS):**
  - Beam's claimed ~3× fewer reasoning tokens would cut the *output* share. Output is 4–9 k per lease, about 5 % of total and 14–27 % of uncached tokens.
  - If Beam also solves tasks in fewer steps, cache-read volume falls.
  - Our probes 8/9 show no effort control on the OpenAI path, and opencode would run Beam at `max`.
- **Causal experiment:** EXPERIMENT_PROPOSAL A0 vs A1 vs A2 (paired on frozen tasks) plus A3 (incumbent model with the MAKER-DEPS workflow). A3 separates "model" from "environment".
- **Expected effect (HYPOTHESIS):**
  - verify rate: Δ in [−10, +10] pt. The vendor's own Terminal Bench puts Beam at par with GLM 5.2 (80.1 vs 81.0).
  - tokens per verified: −0 to −30 %, and only if the step count falls.
- **When Beam would not help:** failures caused by bootstrap, infra or remote timeouts (the majority in DI-001), or by oracle rejections that were correct (mutation gain not met).
- **Tag:** FACT (counts, DI-001) / HYPOTHESIS (Beam).

### B4. Reviewer verdict gaps
- **Symptom:** 15 % of checker and 12.5 % of security-checker leases end without a decisive verdict (30 d). The manual security_checker path never completes (0/263).
- **Evidence (FACT):** the verdict counts in §0. DI-001 REVIEWER_NO_VERDICT, 48 no-verdict leases: causes were budget, parser and `external_directory` permission (exit 1 after a valid verdict). #716 fixed the parser and budget.
- **Root cause:**
  - `insufficient_evidence` is a parsed verdict and partly model behaviour (INFERENCE);
  - the manual path is an orchestration defect (bottlenecks.md P1-5; FACT).
- **Alternatives:** the bounded reviewer strategy (`LOOP_REVIEWER_STRATEGY=bounded`, built, off); give reviewers the check logs inline; fix or retire the manual lease.
- **Possible Beam intervention (HYPOTHESIS):** a model with a lower `insufficient_evidence` rate. This only counts if discrimination holds: glm-5.2 is at 19/20 and 0/26 FR on SEC-F1, and AUC 0.95 on F1.
- **Causal experiment:** a Beam checker challenger on the SEC-F1 46 items (read-only reuse), measuring non-decisive rate, AUC, false rejects and tokens. The F1 case files were lost (noted 21-10), so the general slice must be re-frozen first.
- **Expected effect:** at most −5 to −10 pt non-decisive. Discrimination cannot improve much (headroom 1/20).
- **When Beam would not help:** non-decisive verdicts caused by permissions or missing logs, the manual path, and any swap that lowers discrimination. **Never remove or merge the independent checker.**
- **Tag:** FACT / HYPOTHESIS.

### B5. Single-provider concentration (Ollama weekly limit)
- **Symptom:** the 18-10 weekly-limit hit turned into false regressions and a paused supply.
- **Evidence (FACT):** all `:cloud` makers, checkers and panel calls share one legacy Max account. The Claude fallback produced 0/13 makers.
- **Root cause (FACT):** a legacy plan with weekly limits (new plans use monthly credits), and one provider.
- **Alternatives:** switch the Ollama plan (operator; usage-limits research 18-10); calibrate the token budget throttle (`INFERENCE_BUDGET_THROTTLE=shadow`); a different-provider failover tier (DeepSeek proposal 18-10, operator).
- **Possible Beam intervention:** only if Beam weighs less against the weekly limit ("Low Usage", VENDOR_CLAIM, meaning UNKNOWN). **It does not add redundancy**, because it is the same account.
- **Causal experiment:** read the Ollama usage page before and after a fixed Beam token volume in the throwaway run. That is an operator-side observation.
- **Expected effect:** UNKNOWN.
- **When Beam would not help:** as a failover, never. It fails together with glm-5.2.
- **Tag:** FACT / UNKNOWN.

### B6. Cost is not measurable in €
- **Symptom:** "per unit of total system cost" cannot be computed.
- **Evidence (FACT):** monthly_eur is null for ollama_cloud, claude_max, chatgpt_pro, vps and workstation kWh. Operator minutes are an estimate (2 min/approval). Remote makers report no tokens.
- **Root cause (FACT):** the operator inputs are missing (G0.3).
- **Alternatives:** the operator fills in prices; until then, compare tokens and list-equivalent $.
- **Possible Beam intervention:** none.
- **Expected effect / when Beam would not help:** any Beam € claim is UNKNOWN until G0.3 is filled.
- **List-equivalent bound (INFERENCE):**
  - 7 d opencode maker + reviewers at Ollama glm-5.2 list prices come to about **$17.5** (maker ≈ $13.2: 2.44 M in, 27.4 M cached, 0.60 M out; reviewers ≈ $4.3).
  - That is about **$0.40 per verified change** (44 verified).
  - The 17-10 placeholder model puts operator time at about €3.80 per verified.
  - So model spend is roughly 10 % of the placeholder unit cost.
  - On the flat subscription the marginal $ is about 0 until the weekly limit. A model swap can therefore save at most around 10 % of unit cost even at zero model price. It matters more if it avoids a limit outage.
- **Tag:** FACT / INFERENCE.

### B7. Panel, refinement, Commons and Frontier spend produce no verified value
- **Symptom:** model calls with no verified outcome.
- **Evidence (FACT):**
  - panel 84 calls in 7 d (gemma4 42 + kimi-k3 42, although only gemma4 is configured; the source of the kimi rows is UNKNOWN);
  - panel Brier 0.33;
  - refinement 0/57 and reflection 1/319 verified in 30 d.
- **Root cause (FACT/INFERENCE):** no executable verifier, and the outputs gate nothing that earns.
- **Alternatives:** workflow simplification B (pause or subtract), not a model swap.
- **Possible Beam intervention:** none worth testing.
- **When Beam would not help:** always. A better judge without a verifier stays unmeasured.
- **Tag:** FACT.

### B8. Learning loops cannot read out (units of selection)
- **Symptom:** 0/11 loops closed (learning ledger).
- **Evidence (FACT):** about 4 verified per day, shared by the running experiments (ACE-001, STE-001, F2 v2, MAKER-DEPS-001, memory holdout, R2). TG-001 r2 was INCONCLUSIVE at n = 80.
- **Root cause (FACT):** low unit supply (B2).
- **Possible Beam intervention:** none. Worse: **a prod Beam arm would compete for the same units** and add a period boundary to every running experiment.
- **When Beam would not help:** any prod A/B before the running experiments read out. This is why the proposal is offline only.
- **Tag:** FACT / INFERENCE.

## 2. Ranking by expected effect on verified, surviving changes per unit cost

1. **B2 supply** (caps, one repo, one verifier).
2. **B1 human merge.**
3. **B3 maker failures.** The environment part is being handled by MAKER-DEPS-001; the model part is the only plausible Beam target.
4. **B5 provider concentration** (plan choice).
5. **B4 reviewer gaps.** Beam is a weak candidate.
6. **B6 € measurement**, which blocks any cost claim.
7. **B8 learning units.**
8. **B7 non-verifying spend.**

**INFERENCE:** none of the top two limits is model-related. The prior read ("human merge throughput, task supply/caps, one repo, maker timeouts/diff limits, reviewer verdict gaps") holds on current numbers, with two changes:
- diff limits no longer bite: 0 `over_diff` in 7 d, 9 in 30 d, all on leases without a recorded model id (dates not checked);
- auto-merge now handles most eligible PRs, so the merge bottleneck has narrowed to ineligible and audit-sample PRs.
