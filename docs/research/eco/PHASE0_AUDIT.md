# ECO Phase 0 — audit of "Evolutionary Ecology and Capability Intelligence" against DjimitFlo

Operator system instruction, 10-10 (14 sections). Read-only audit of `origin/main` (after #758) and prod build
7c967931 (read-only queries, 10-10 ~20:00Z). Reuses, not redoes: [ACE CURRENT_STATE](../ace/CURRENT_STATE.md),
[ACE GAP_ANALYSIS](../ace/GAP_ANALYSIS.md), the Commons zero-yield trace (summarised in §2), and
[Operator Cockpit 3.0](../operator-cockpit-3/). Paths are relative to `packages/server/src/`.

Classes: **EXISTING** (code + live with a consumer) · **PARTIAL** (code exists; shadow, dormant or a missing link) ·
**BROKEN** (exists, produces wrong or no output) · **MISSING** · **DUPLICATE** (a second implementation of an existing
mechanism). Nothing below is inferred from UI labels.

## Counts

| Class | n (rows in §1–§13) |
|---|---|
| EXISTING | 32 |
| PARTIAL | 35 |
| BROKEN | 3 (two fixed by #758, deploying; `agent_skills` unused) |
| MISSING | 10 |
| DUPLICATE | 1 in the tables + 4 more in the register below (5 total) |
| **Classified rows** | **81** |

Reading: most of what the instruction asks for exists, but as PARTIAL — built, then dormant or shadow because the data
cannot yet show an effect. The MISSING items cluster in two places: capability contracts / transfer / diversity metrics
(nothing consumes them yet) and non-software niches (no executed oracle exists for security, research, content).

## §1 Audit inventory (existing implementation)

| Area | Evidence | Prod | Class |
|---|---|---|---|
| Commons, residents, proposals | social/Commons services, `self-improvement-service.ts:399` (`groundFromCommons`) | 737 proposals, 0 verified; residents off (`SOCIAL_AUTOPILOT_RUNTIME=off`, forecast-only) | PARTIAL |
| Genome trials, mutations, holdouts, gates | `dream-evolution.ts` (`evaluateTrials`), `genome-registry.ts:42-215`, `maker_genomes` (`database/migrate.ts:1297`) | 1 baseline active, 10 retired, 6 inconclusive, 0 promoted; `DREAM_EVOLUTION_ENABLED=false` | PARTIAL (dormant by evidence) |
| Agent registry, routing, federation | `agent-registry-service.ts:12` (declared `capabilities: string[]`), `registry_agents` (`migrate.ts:1356`), bandit `loop-daemon.ts:511` | 5 registry nodes, 28 `agents` rows; capabilities are self-declared strings, never measured | PARTIAL |
| Skills, memory, knowledge, learning | K1 examples `assignment-context.ts:9`; memory rules + seal; KB `kb-corpus.ts:54`; `agent_skills` | `agent_skills` = 0 rows; 21 engineering rules + 108 operational memories promoted | PARTIAL |
| Experiment execution, verification, settlement, merge survival | lanes `loop-daemon.ts`, checks, checkers, `merge-survival.ts:148` | merge outcomes: 2 settled (both survived) | EXISTING (survival data thin) |
| Model selection, forecasters, cost, allocation | `model-selector.ts:94`, `forecasters.ts:45`, resource ledger, `llm_model_calls` | selector shadow; 20 forecasters, 0 decision-grade; energy coverage 23 % | PARTIAL |

## §2 Zero-yield problem (Commons trace, 10-10)

| Requirement | Finding | Class |
|---|---|---|
| Reconcile status totals | 688 + 42 + 7 = 737 — the "761" was an addition slip; one population (719 reflection + 18 refinement), all time | EXISTING (no defect) |
| Trace the 24 valid groundings | 0 reached a goal: 10 panel-unparseable recorded as needs_more_evidence then archived; 6 no refinement (APPLY off by design); 3 panel `backlog` (only `goal` creates a goal, `self-improvement-auto-review-scheduler.ts:16`); 5 genuine rejections | — |
| Unparseable panel = verdict | model failure scored as needs_more_evidence | BROKEN → fixed #758 (merged, deploying) |
| Grounded target invisible to the pre-screen | target/test in `rationale`, pre-screen reads `description` (`judgments/proposal-prescreen.ts:14`) | BROKEN → fixed #758 |
| Earliest blocking transition | none common to all; the proposals are feature ideas whose "test" the maker would write itself → no independent oracle | — (path stays off; operator labels agree 17/18) |

## §3 Capability-centric evolution

| Requirement | Evidence | Class |
|---|---|---|
| Capability contract I/O/P/D/E/F/L independent of agent identity | none; agent records carry free-text capabilities | MISSING |
| `swarm_capabilities` (G23 auto-acquisition, `capability-acquisition.ts:15`) | prod 498 rows: 377 deprecated, 100 draft, 21 candidate; no consumer selects work by them | DUPLICATE (dead; retire candidate W8) |
| Provenance / P1 seal | memory-rule + KB-page content hashes, `skill_content_hash` on outcomes (#735) | EXISTING |
| Lineage | `parent_id` on `maker_genomes`, `committee_genomes`; `evolve_sibling_of` on leases | EXISTING |
| Composition / transfer between agents | none measured | MISSING |
| Retirement / rollback | genome retire on trial loss; committee extinction (`committee-swarm.ts:157-183`); loop auto-merge revert revokes class (`loop-auto-merge.ts:173-190`); deploy rollback = human | PARTIAL |

## §4 Causal loop OBSERVE → … → INHERIT

| Stage | Existing part | Class |
|---|---|---|
| OBSERVE | stall watch + detector health (#739/#749), cockpit, resource ledger | EXISTING |
| GAP | failure signatures (#732), outcome attribution; no gap→discovery link | PARTIAL |
| DISCOVER | discovery bus + scout + yield-gated profile (#733); source-driven, not gap-driven | PARTIAL |
| HYPOTHESIZE | proposals (gap_analysis lanes have file + command; reflection/Commons ideas do not) | PARTIAL |
| GROUND | `groundFromCommons`; APPLY off since 30-09 | PARTIAL (off by evidence) |
| MUTATE | dream-evolution one-gene mutants; committee child genomes | PARTIAL (dream off) |
| EXPERIMENT | gym (mined / mutant / write_test), paired trials, production arms X1 / F2 / memory holdout / ACE-001 | EXISTING |
| FALSIFY | McNemar / permutation / e-process, headroom precheck, holdout reuse block (#753) | EXISTING |
| SELECT | bandit (live), evolve selection, genome promotion (dormant) | PARTIAL |
| DEPLOY | draft PR + human merge; auto-deploy + verdict (whole build, no canary) | EXISTING |
| SURVIVE | merge survival (`merge-survival.ts`), n = 2 settled | PARTIAL (data thin until ~19-10) |
| INHERIT | winners join the bandit species list; no transfer of a winning gene to other agents/niches | PARTIAL |
| Durable / idempotent / no silent stalls | detector health, scheduler execution status (#739/#749), idempotent attribution/requeue | EXISTING |

## §5 Mutation dimensions

| Dimension | Evidence | Class |
|---|---|---|
| Skills / tool composition | K1 example sets only (genome gene `examples`); no tool-composition mutation | PARTIAL |
| Model / inference routing | species bandit; model selector shadow (`model-selector.ts`) | PARTIAL |
| Planning / reasoning strategy | genome `strategy_lines` / `anti_pattern` genes | EXISTING (dormant trials) |
| Memory / retrieval policy | memory holdout arm; ACE-001 R factor (KB by embedding) | PARTIAL (ACE-001 just merged, flag pending) |
| Delegation / spawning | X1 sibling on/off (acting); `nested-spawn-service.ts:142` with depth budget `:301` | PARTIAL |
| Swarm topology | committee size/members; `swarm_sessions` 0 rows ever | PARTIAL / dead |
| Verification / recovery | F2 checker family arm; reviewer retry (one fresh reviewer) | PARTIAL |
| Parent immutability | genome rows are never edited, children get new ids | EXISTING |

## §6 Ecology (niches, QD)

| Requirement | Evidence | Class |
|---|---|---|
| Per-niche fitness F(g,n,e) | skill outcomes keyed by lane (`loop-maker:<lane>:<runtime>`), gym vs production scopes kept apart (cockpit genomes table) | PARTIAL (lanes ≈ niches inside software engineering only) |
| Niches security / research / knowledge / operations / forecasting / content | forecasting = committee arena; others have no executed oracle | MISSING |
| MAP-Elites / novelty / multi-objective | none; Pareto not computed | MISSING (YAGNI, see plan) |
| Diversity preserved when it has niche value | committee keeps ≥ 3 members; bandit exploration floor | PARTIAL |

## §7 Causal credit assignment

| Component | Running ablation / credit | Class |
|---|---|---|
| Model | species bandit, F2 checker family (cross vs same, target 93/arm) | PARTIAL (collecting: 3 / 2) |
| Skill (examples) | ACE-001 S factor (similarity vs recency) | PARTIAL (merged, flag pending) |
| Tool | — | MISSING |
| Memory | memory holdout 0.3 (F3: inconclusive, trend against) | EXISTING (underpowered) |
| Retrieval | ACE-001 R factor | PARTIAL (merged, flag pending) |
| Planner | genome trials (dormant; holdout exhausted until epoch 1) | PARTIAL |
| Delegation | X1 siblings (target 94/arm; interim 0/3 vs 8/11) | EXISTING |
| Swarm topology | — | MISSING |
| No passenger credit | `outcome_credits` (#707): reviewer/env failures credit nobody; prod credits maker 16, reviewer 32, memory_rule 27, judgment 10, genome 2, model 1 | EXISTING |

## §8 Executable knowledge

| Requirement | Evidence | Class |
|---|---|---|
| Lessons → memory rules | memory candidates (21 engineering rules promoted, 30 rejected) | EXISTING |
| Lessons → tests / benchmarks | failure-derived `write_test` gym tasks (`gym-failure-tasks.ts:36`) | EXISTING |
| Lessons → negative examples | genome `anti_pattern` gene; dream evidence mutations | PARTIAL |
| Lessons → skills | `agent_skills` 0 rows; skill-evolution gym unused | BROKEN (declared, unused) |
| Inherited knowledge improves later tasks | memory holdout + ACE-001 measure it; F4 KB cited not decision-moving | PARTIAL |

## §9 Bounded reproduction

| Requirement | Evidence | Class |
|---|---|---|
| Budget by information gain | effort controller EVC/VOI shadow (#708), resource ledger | PARTIAL |
| Ephemeral specialists within sandbox | evolve siblings, remote makers, nested spawn depth budget | EXISTING |
| Promote specialist only after repeated value | D6 rule (≥ 20 outcomes ≥ incumbent), committee extinction | EXISTING |
| Prevent unbounded spawning / tool acquisition | spawn depth budget, daily caps, runtime admission, outbound guard | EXISTING |

## §10 Evaluator co-evolution

| Requirement | Evidence | Class |
|---|---|---|
| Adversarial tasks | seeded mutants tiers 1–6, write_test with seeded target mutants | EXISTING |
| Benchmark generation separate from evaluation | mutation step never sees holdouts (#600) | EXISTING |
| Immutable gold holdouts | frozen holdout tables; epochs; reuse block (#753) | EXISTING (epoch 0 exhausted; epoch 1 pending) |
| Contamination / reward hacking | canaries (`GYM_CANARY_RATE=0.05`, prod 2 served, 0 solved), hack classifier `gym-hack-classifier.ts:17`, hack rate evidence `evolution-evidence.ts:73` | EXISTING |
| Evaluator drift | oracle agreement κ (RX-9), F1 checker discrimination study | PARTIAL |
| Candidate cannot modify its evaluator | gates/oracles never evolved (plan §1); dream guard forbids gate/check words | EXISTING |

## §11 Production survival

| Requirement | Evidence | Class |
|---|---|---|
| Reuse PR / verification / merge survival | `merge-survival.ts` (v1 + v2 lines retained) | EXISTING |
| Canary deployment | whole-build deploy only | MISSING |
| Rollback / regression / extinction events | revert revokes auto-merge class; genome/committee retire; no deploy rollback event | PARTIAL |
| Experiment success ≠ production improvement | gym vs production scopes separated; scenario 6 test (#755) | EXISTING |

## §12 Governance invariants

| Requirement | Evidence | Class |
|---|---|---|
| No weakening of auth / sandbox / secrets / approvals | invariants in plan §1; authz route tests (#740), audit actor (#743); policy-violation log (1 row) | EXISTING |
| External material untrusted | content_safety on untrusted input, shipped-code scan parse-only, REA NO_GO (#756), no community installs | EXISTING |
| Experiment vs deploy permissions separated | makers write worktrees; merge human; deploy by host timer | EXISTING |

## §13 Observability

| Metric | Where | Class |
|---|---|---|
| Verified capability acquisition rate | intelligence section VIG/RIR (INSUFFICIENT_EVIDENCE) | PARTIAL |
| Fitness per generation | genome trials (0 promotions) | PARTIAL |
| Grounding / experiment conversion | Commons funnel (#604); no grounding→goal metric | PARTIAL |
| Verification / survival yield | scorecard verified_7d, merge survival | PARTIAL (n = 2) |
| Capability reuse / transfer | — | MISSING |
| Population / behavioural diversity | — | MISSING |
| Novelty / exploration effectiveness | — | MISSING |
| Cost per verified improvement | spend vs direct tokens (#742) | EXISTING |
| Failed hypotheses / avoided rediscovery | failure signatures + FRR (#732) | EXISTING |
| Stagnation / evaluator reliability | stall watch, oracle κ, canaries | EXISTING |

## DUPLICATE register (W8 review 14-10 decides retirement)

| Duplicate | Of | Justified? |
|---|---|---|
| `swarm_capabilities` (G23, 498 auto rows) | the missing capability registry | No — no consumer; retire candidate |
| `committee_genomes` next to `maker_genomes` | genome registry | Partly — different niche (forecasting) and fitness (Brier); same lineage shape; keep until the arena has decision-grade forecasters, then merge or retire |
| Forecaster "genomes" (`forecasters.ts`, committee members, residents) | forecast scoring | Partly — one scorer (`forecast-scoring.ts`) already unifies them; 0/20 decision-grade |
| Swarm / council / consensus modules (`swarm-*`, `council-*`, `multi-agent-consensus-service.ts`, `expert-swarm-orchestrator.ts`; `swarm_sessions` 0 rows) | committee arena + lanes | No — dormant; retire candidates (already on the W8 list) |
| SEGML bridges (`segml-*.ts`, 290/290 failed earlier) | learning / gym | No — retire candidate (W8) |
