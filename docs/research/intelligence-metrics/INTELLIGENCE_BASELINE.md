# Intelligence baseline (operator §16, step 1: "reconstruct the current baseline from actual evidence")

**Snapshot.** Prod `djimitflo-live` running `d815c525` (#722–#725), read-only, 2026-10-09 21:38Z. Window is 30 days unless noted.
Nothing was written to prod to produce this. Every number carries `n` and a source key (see *Sources* at the end).
`INSUFFICIENT_EVIDENCE` means the quantity cannot be estimated reliably from what exists. It never means 0.

## The short answer

DjimitFlo has one path that produces externally checkable improvement: the **maker → executed checks → checker → human merge**
pipeline on oracle lanes (test-gap, mutation-gap, exports, doc-drift). Every §16 metric that needs an **independent evaluation
distribution, a frozen baseline policy and a held-out task set** is not estimable today. Three things block that:

1. **One repository.** All 778 gym runs and all 259 production oracle-lane runs (30 d) target the same repo, `djimitflo`
   (`/workspace/djimitflo` 227 + `/app` 32) [SQL]. So transfer to unseen repositories, languages or environments has never been
   observed (n = 0), and GTI is undefined.
2. **No settled ground truth on durability.** Merge survival has 2 settled labels (2 survived) [EV merge]. Gate B needs ≥ 30.
   The first loop PRs merged on 05-10 settle around 19-10.
3. **No frozen-baseline vs candidate comparison has ever been decisive.** 8 genome trials: 6 `no_headroom` and 2 `blind`, 0 decisive
   [EV trials]. 16 dream genomes: 10 retired and 6 inconclusive [EV genomes]. Graded trials (#709) have not run on graded scores yet.

What is measured well enough to act on: checker discrimination (F1), executed gym pass rates, resource use per consumer,
outcome-attribution classes, and forecast skill (which is zero).

## Per-dimension state

| §16 dimension | What exists today (table / endpoint) | Current evidence | Estimable? |
| --- | --- | --- | --- |
| **VIG** (16.1) | `self_improvements.status`, `skill_outcomes`, gym `loop_runs.metadata.gym_result`, `genome_trial_results` | 47 verified / 52 regressed of 99 settled proposals (0.475, Wilson [0.379, 0.572]) [SQL]. This is a level, not a gain. No frozen π_base was ever evaluated against a π_new on a fixed, independent task set. The gym holdout (20 commits) and mutant holdout (20) are fixed, but trials never got past headroom. | **INSUFFICIENT_EVIDENCE** |
| **RIR** (16.2) | sequence of VIG estimates × `/api/health/efficiency` cost | No VIG, so no ratio. The north-star proxy (verified per M cloud tokens) by week: 2.13 (n = 9, 09-18), 0.196 (n = 6, 09-25), 0.411 (n = 32, 10-02) [EF]. These are throughput ratios, not gains on held-out tasks. | **INSUFFICIENT_EVIDENCE** |
| **GTI** (16.3) | none (1 repo) | Unseen repos 0, unseen languages 0 (TypeScript only), unseen backends: gym atomic@llama-router 562/692 vs opencode 8/18 (different task mix, not a transfer test) [SQL] | **UNDEFINED** (denominator never measured) |
| **CLY** (16.4) | `outcome_learning_assessments` (58), `memory_candidates` (122 promoted), `loop_learning_closures` (51), `reflections` 582 | Assessments: 2 FALSIFIED with causal_support, 12 signal SUPPORTED but causal UNDETERMINED, 44 UNDETERMINED [SQL]. Learning closures mean Δ +0.001 (n = 51, range −0.05…+0.05) [SQL]. 0 lessons meet all five §16.4 criteria (hypothesis, evidence, applicability, independent verification, measured effect). Promoted memory rules: 21, none with raw fitness > 0 [F3]. | **0 validated (n = 58 assessed); a ratio needs ≥ 1 validated lesson, so INSUFFICIENT_EVIDENCE as a rate** |
| **Failure recurrence** (16.5) | `loop_runs.metadata.failed_gates`, `outcome_attribution` judgments, `failure_cause` (204 judgments, 75 % uncertain [EP]; off since 08-10) | Coarse gate-class signatures on the doc-drift/oracle lane: 84 failed runs, 8 distinct signatures, 76 repeats (0.905 [0.823, 0.951]). Per week: 16/20 → 10/11 → 50/53 (not falling) [SQL]. A gate class is not a root-cause signature, so this is an upper-bound proxy. Retry waste: reviewer retry with the same input fails again (run 5b91e689, two checkers at 1.03–1.04 M tokens) [P]. | **Proxy only**; true signature-level recurrence INSUFFICIENT_EVIDENCE |
| **CAR** (16.6) | `judgments` (`outcome_attribution`, live since 08-10 17:29Z), `outcome_credits` (42 rows) | Coverage: 45 attribution judgments vs 99 settled proposals in 30 d (0.455), and they exist only for runs after #707. Classes: verified 8, reviewer_failure 32 (30 of them operator annotations), maker_failure 4, environment 1 [AT]. Correctness has **never been audited** by independent adjudication. | Coverage yes; **CAR INSUFFICIENT_EVIDENCE** |
| **CIA** (16.7) | maker + checker leases, evolve siblings (X1), committee, panel | F1: the checker separates good from defective (AUC 0.875, accept good 18/20, defective 3/20) [F1]. X1 randomised sibling: on 0/3 vs off 8/11 verified, Fisher p 0.055 (n = 15 goals) [EV effort_x1]. Committee forecasters: 0/20 decision-grade [EV gates D]. No single-agent arm without a checker exists in prod. | Partial (one cell pair). **CIA INSUFFICIENT_EVIDENCE** |
| **MCS** (16.8) | `judgments` `forecast:*` rows, `forecast-scoring.ts` V1/V2, `judge_calibration` | 20 forecasters scored, 0 decision-grade, all `insufficient` (V2 needs ≥ 10 positives and n ≥ 100); the scored windows hold 0 positives [FC]. Earlier backfill (870 proposals): jev Brier 0.41 vs base rate 0.11, residents AUC 0.25 [forecast-scoring.ts header]. `judge_calibration` 95 rows, 0 labelled [SQL]. | **INSUFFICIENT_EVIDENCE** (no positives in window) |
| **ADQ** (16.9) | `approvals` (339), `authority_events` (789), oracle-lane auto-approve, auto-merge shadow | Approved 324: autonomy 195 (0.602) vs human/other 129 [SQL]. No randomised or adjusted comparison of autonomous vs human decisions. The approval → goal → outcome join returns 0 rows (no stored link) [SQL]. Auto-merge is shadow only: would_merge 14, 3 audit samples open [EV auto_merge]. 194 historic `autonomy:*` approvals were logged as `human` (fixed going forward by #725, past rows stay wrong) [CR]. | **INSUFFICIENT_EVIDENCE** |
| **EII** (16.10) | `expert_claims` 1,954, `knowledge_claims` 5, `kb_pages` 1,313, `kb_retrieval` 65, `kb_passage_relevance` 88 (enforce) | Claims 99.9 % undetermined, 1 claim relation [CR]. KB retrieval: 52/65 top hits on the same 3 pages [CR]. F4: 44/52 KB panels cite `kb:` pages, but the decision mix does not change (needs_more_evidence 82 % vs 79 %) [F3]. Knowledge: 0/1,300 proposals and 0 genomes cite knowledge [KE]. No versioned labelled evaluation set exists. Circular-evidence detection: MISSING. | **INSUFFICIENT_EVIDENCE** (sub-metrics are counts, not precisions) |
| **ESE** (16.11) | `maker_genomes` 17, `genome_trial_results` 8, `dream_ledger` 54, gym holdouts | 16 candidates → 0 promoted, 10 retired, 6 inconclusive; 8 trials, 0 decisive [EV]. Exploration fitness (gym pass) and promotion fitness (paired holdout) are already separate in code. The locked holdout has been reused across 8 trials in epoch 0 [EV trials by_epoch]. Graded pools: gym_repair n = 22 (mean 0.636), prod_exports n = 3, write_test/test_gap/mutation n = 0 [EV graded]. | Yield = 0 / 16 candidates (Wilson upper bound 0.19). **ESE INSUFFICIENT_EVIDENCE**: no positive yield to divide |
| **SCIG** (16.12) | `policy_violations` (0 rows, never written), `lure_events` (0), `shipped_code_scans` (0, shadow flag written), gym canaries, hack detector, content_safety | Hack flags: 0 flagged across checked gym outcomes (for example genome `none` 0/140, Wilson upper 0.027) [EV hack_rate]. Canary: 1 served, oracle intact (n = 1) [EV]. `protected_paths`/`allowed_tools` are stored but never enforced; reviewers are read-only by prompt only [CR]. Zero observed violations ≠ negligible risk (rule of three: 0/140 → ≤ 0.021). | Constraint monitors exist; **P(violation) INSUFFICIENT_EVIDENCE** |
| **Economics** (16.13) | `/api/health/efficiency` (`resource-ledger.ts`), `host_power_samples` 2,899, `llm_model_calls`, `worker_leases` runtime_usage | 7 d: maker:opencode 44.2 M cloud tokens for 29 verified of 82 attempts = 0.656 verified/M tokens [0.480, 0.856]; checker 16.7 M, security_checker 14.6 M [EF]. Workstation GPU 1.401 kWh measured over 24.3 covered h (mean 57.8 W) [EF]. In EP: 66 % of maker tokens went to non-verified runs; tokens per outcome are equal for regressed and verified runs (0.76 M vs 0.71 M) [EP]. F1 cost: 1.46 M tokens for 40 checker calls [F1]. | **Partially estimable** (tokens per verified outcome: yes; cost per validated *improvement*: no) |

## Counter and outcome-state validation (§16.16 step 2)

| Counter | Check | Result |
| --- | --- | --- |
| `self_improvements.status = verified` | Is it independent of the checker? | **No.** `verified` requires an accepted checker verdict, so it cannot label the checker (circular). Use F1-style planted defects or merge survival instead. |
| `regressed` | Is it the maker's failure? | Mostly not. 30 of 45 regressions (30 d) were a missing reviewer verdict after a completed maker [outcome-attribution.ts header]. Attribution: 4 maker vs 33 reviewer/environment of 37 failed [AT]. |
| gym `success` | Does it equal production quality? | **No.** Gym proxy success 44/46 (0.957) vs prod-gated 22/46 (0.478) on mutant tasks [EV gym_prod_gates]. Gym ≠ prod. |
| memory-rule fitness | Is a positive score real? | 4/15 read rules are > 0 only because attribution forgives regressions; raw score: 0 positive [F3]. |
| proposal counts | Duplicates? | 2 fingerprint groups (5 rows); 307 refinements (`refined_from_id`). Requeues reuse the same proposal (goals per proposal = 1 in the goals table, but requeued runs share proposals across loop_runs) → cluster by proposal [SQL]. |
| approvals actor | Human vs autonomy | 194 historic rows mislabelled `human` [CR]; fixed going forward by #725. |
| lure bites | Causal? | Bites were derived, not stored. `lure_events` (append-only, #725) has 0 rows so far [SQL]. |
| `judge_calibration` | Labelled? | 95 rows, 0 with `actual_outcome` [SQL]. |
| gym diffs | Stored? | 0 of 778 runs store a diff → 0 training pairs [SOUP, SQL]. |
| knowledge links | Any proposal or genome citing knowledge? | 0 / 1,300 and 0 / 17. #727 adds `knowledge_refs_json`; it is open, not deployed [KE]. |

## Contamination and correlation (§16.16 step 3)

- **Evaluator circularity:** checker-gated `verified` cannot evaluate the checker; panel AUC 0.98 was leakage, because goals exist only when the panel says goal [forecast-scoring.ts].
- **Shared clusters:** requeued runs share proposals. Gym tasks are mined from the same repo history as production. All production work is one repo, so treat repo as a single cluster: between-repo variance cannot be estimated.
- **Infrastructure contamination:** reviewer token blow-ups (fixed by #716), the pre-#699 remote timeouts (0/41 before, 2/3 after), and Docker/CI outages all hit verified/regressed counts. Attribution separates them only for runs after 08-10.
- **Holdout reuse:** 8 trials in epoch 0 used the same 20-commit holdout. #712 adds a write_test holdout epoch (0 rows yet).
- **Selection:** oracle-lane auto-approve overrides rule-v1 "no" [CR], so the approved population is not random. Effort escalates on failing goals, which confounds "makers per goal → verified" (86 % / 41 % / 0 %) [EP].
- **Goodhart risk already seen:** the N4 interest profile broadened the scout until 95.5 % of relevant items came from one source (HHI 0.91) [KE].

## Frozen baseline configuration (§16.16 step 4)

Baseline = prod `d815c525` + runtime.env backups `.bak-20261009e` (latest), with: OUTCOME_ATTRIBUTION_ENABLED=true,
EFFORT_CONTROLLER_MODE=shadow, EFFORT_SIBLING_RANDOMISE=true, GRADED_FITNESS_MODE=shadow, GRADED_CONTEST_MODE=shadow,
DREAM_EVOLUTION_ENABLED=false, MEMORY_HOLDOUT_RATE=0.3, GYM_CANARY_RATE=0.05, TYPESAFE_PROPOSAL_PRESCREEN_MODE=enforce,
RESOURCE_LEDGER_ENABLED=true, SHIPPED_CODE_SCAN_MODE=shadow (written, live with the next deploy). The baseline gym holdout is
`gym_holdout` epoch 0 (20 commits) + `gym_mutant_holdout` epoch 0 (20 keys). Any experiment in `EXPERIMENT_PROTOCOL.md` is
compared against this configuration, and the configuration may only change through the operator.

## §16.16 falsification questions — honest answers today

| Question | Answer | Evidence |
| --- | --- | --- |
| Does the adaptive swarm outperform a single strong agent after cost? | **No evidence. Not tested.** There is no single-agent arm. The only randomised multi-agent cell (X1 siblings) points the other way: 0/3 vs 8/11, p 0.055, n = 15. | EV effort_x1 |
| Does experience memory improve future task performance? | **No evidence.** Holdout: rules 29/42 (0.69) vs withheld 4/6 (0.67), Fisher p = 1. Power is 0.45 even at 112 vs 48 for a 15-pt effect. | EV memory_holdout, F3 |
| Does causal failure classification reduce repeated regressions? | **Unknown, not yet tested.** Attribution has been live < 2 days. Gate-class recurrence is not falling (0.80 → 0.94). | AT, SQL |
| Does skill evolution outperform static skill selection? | **No evidence.** 0/16 genomes promoted; skills are SKILL.md text with no hash or outcome link (`agent_skills` 0). | EV genomes, CR |
| Does active learning improve information per experiment? | **Unknown, not yet tested.** The effort controller is shadow only (161 decisions: 138 run / 23 skip). No comparison arm. | SQL |
| Does model routing beat a fixed high-performing model? | **No evidence for it.** Off-policy SNIPS of the fitness-view argmax vs the logged bandit: Δ −0.010 [−0.044, 0.021], n = 148, ESS 127. That compares two routers, not router vs fixed model. | EV ope |
| Does metacognitive evaluation improve forecast calibration? | **No evidence.** 0/20 forecasters decision-grade; no positives in the scoring window. | FC |
| Does recursive optimisation gain on new tasks, not just the optimisation benchmark? | **Not testable yet** (1 repo, 0 decisive trials). | SQL, EV trials |
| Does more autonomy preserve safety and decision quality? | **Unknown.** No randomised comparison. Auto-merge is shadow only. Zero recorded policy violations, but nothing ever writes `policy_violations`. | SQL, EV auto_merge |
| Does the full system beat a simpler non-self-modifying baseline? | **Unknown, not yet tested.** That comparison has never been set up. Per §16.16, keep the simpler baseline. | — |

Nothing in this baseline supports a claim of recursive self-improvement or AGI-like capability. The defensible claim is narrower:
a governed maker/checker pipeline with an executed verifier, whose checker discriminates planted defects (F1), and whose learning
loops are instrumented but not yet shown to help.

## Sources

| Key | What | When |
| --- | --- | --- |
| EV | `buildEvolutionEvidence(db, env, now, 30)` from `packages/server/dist/services/evolution-evidence.js`, run read-only in the container | 2026-10-09 21:38:22Z |
| AT | `attributionSummary(db, now, 30)` (`outcome-attribution.js`) | same |
| EF | `efficiencyView(db, now, env, 7)` (`resource-ledger.js`) = `GET /api/health/efficiency` | same |
| FC | `forecastScoresV2(db)` (`forecast-scoring.js`) | same |
| SQL | read-only better-sqlite3 queries (appendix) | 2026-10-09 21:40Z |
| CR | `docs/research/cognitive-runtime/BASELINE.md` | 2026-10-09 |
| F1 | F1 checker-discrimination experiment, 40 items, 1.46 M tokens | 2026-10-09 21:13–21:28Z |
| F3 | F3/F4/F5 read-only experiments (memory refit, KB citations, Qdrant probe) | 2026-10-09 |
| KE / SOUP / EP / P | operator plan phases KE (knowledge Phase 0), SOUP (training-data baseline), EP (effort measurements 08-10), SI/E notes | 2026-10-08/09 |

### Appendix — read-only queries used (abridged)

```sql
-- settled proposals
SELECT status, COUNT(*) FROM self_improvements WHERE updated_at >= now-30d GROUP BY 1;
-- failure recurrence proxy (doc-drift/oracle lane): signature = sorted gate names (text before ':') of loop_runs.metadata.failed_gates,
-- a repeat = signature seen earlier in the window; split by week
-- repos
SELECT repository_path, COUNT(*) FROM loop_runs WHERE loop_name IN ('doc-drift-and-small-fix-loop','evolution-gym') GROUP BY 1;
-- attribution, credits
SELECT decision, COUNT(*) FROM judgments WHERE judgment = 'outcome_attribution' GROUP BY 1;
SELECT kind, COUNT(*), COUNT(DISTINCT run_id) FROM outcome_credits GROUP BY 1;
-- approvals
SELECT status, approved_by LIKE 'autonomy:%' AS autonomy, COUNT(*) FROM approvals GROUP BY 1, 2;
-- never-written tables
SELECT COUNT(*) FROM lure_events / policy_violations / shipped_code_scans / gym_write_test_holdout / knowledge_gaps / agent_skills;
-- gym diffs stored
SELECT COUNT(*) FROM loop_runs WHERE loop_name LIKE '%gym%' AND json_extract(metadata,'$.gym_result.diff') IS NOT NULL;
```
