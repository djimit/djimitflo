# ECO — phase plan and ranked build list

Basis: [PHASE0_AUDIT.md](PHASE0_AUDIT.md). Data volume that bounds every decision: ~4.5 oracle-lane goals/day
(44 % verified), remote gym capped at 20 attempts/day, merge survival n = 2 settled, 0 promoted genomes, 0/20
decision-grade forecasters. At this volume only effects of about 20 points are detectable in 6–7 weeks (ACE-001 power
calculation). Anything that cannot be measured at this volume is DEFER with a trigger.

## Phases (8 deliverable items each, short)

| # | Phase 1 — repair Commons → Evolution | Phase 2 — lineage and inheritance | Phase 3 — niches and causal evaluation | Phase 4 — bounded orchestration | Phase 5 — multi-generation validation |
|---|---|---|---|---|---|
| 1 Existing + refs | `groundFromCommons` (`self-improvement-service.ts:399`), panel scheduler (`self-improvement-auto-review-scheduler.ts:16`) | `parent_id` on `maker_genomes` / `committee_genomes`, `skill_content_hash`, P1 seals | lane-keyed skill outcomes; X1, F2, memory holdout, ACE-001 | effort controller (shadow), caps, spawn depth budget, runtime admission | merge survival, genome trials, estimators |
| 2 Deficiency + evidence | 24 valid groundings → 0 goals (trace) | no transfer of a winning gene across agents/niches; 0 promotions to inherit | niches beyond software have no oracle; tool and topology have no ablation | budgets are caps, not information-gain driven (EVC shadow only) | n = 2 survival; trials dormant on an exhausted holdout |
| 3 Minimal change | #758 (prescreen sees target; unparseable panel ≠ verdict); path stays off | none until a promotion exists | ACE-001 on (skill × retrieval credit) | none until EVC shadow shows a different allocation would have bought more verified changes | fresh holdout epoch 1; graded trials on the write_test holdout |
| 4 Tests | #758: 2 tests fail on old code | — | ACE-001: 7 tests, gates identical across arms | floor-invariant test exists (#711) | scenario 6/10/11 tests (#753, #755) |
| 5 Benchmark vs incumbent | operator labels agree with 17/18 pre-screen rejections | — | arm A = incumbent context | — | paired McNemar / permutation vs parent genome |
| 6 Security / ops | no flag change; no history rewritten | — | maker context only; evaluator untouched | — | holdout reuse block (#753) |
| 7 Migration / rollback | revert #758 | — | `ACE_001_MODE=off` | — | `DREAM_EVOLUTION_ENABLED=false` |
| 8 Result / uncertainty | not proven until a new grounded proposal passes the pre-screen | not started | collecting (0 arm leases yet) | not started | INSUFFICIENT_EVIDENCE |

## Ranked build list (smallest items with a measurable effect at today's volume)

| Rank | Item | Class | Effect measured by | Feasibility | Decision |
|---|---|---|---|---|---|
| 1 | Switch ACE-001 on (`ACE_001_MODE=on`; code merged #757) | PARTIAL → EXISTING | verified rate per arm, retrieval and example-selection main effects | 50 goals/arm ≈ 6–7 weeks; detects ~20 points | **do** (operator-approved 10-10; loads with the #758 deploy) |
| 2 | Fresh holdout epoch (`GYM_HOLDOUT_EPOCH=1`) + graded genome trials on the write_test holdout (`DREAM_PROMOTION_RULE=graded`, `DREAM_TRIAL_WRITE_TEST_HOLDOUT=true`) | PARTIAL (planner credit) | paired graded mean, parent vs mutant | ~80 attempts per trial ≈ 4 days at the 20/day cap; simulated power 0.5–0.84 for a 0.10 graded difference | epoch: **do** (approved); resuming dream evolution = **operator** (it was switched off by the 09-10 energy reallocation) |
| 3 | Gap-driven discovery: the top recurring failure signatures (#732) enter the scout as interest-profile exploration slots (#733 mechanism) | MISSING (GAP → DISCOVER) | jev-yes rate per term vs static baseline (18.1 %) | ~700 discovery events/day; n ≥ 20 per term in < 14 days | **build next** — but it measures relevance, not verified capability (discovery has no executable consumer yet); stop if no term beats the baseline in 14 days |
| 4 | Grounding → goal conversion metric in the Commons funnel (incl. `backlog` decisions that never become goals) | MISSING (§13) | count of grounded proposals per terminal transition | trivial; observability only | **build with #3**; no fitness effect claimed |
| 5 | Retire `swarm_capabilities` (498 auto rows, no consumer), dormant swarm / council / SEGML modules, unused `agent_skills` | DUPLICATE / BROKEN | fewer tables and services at equal verified / week | — | **operator, W8 review 14-10** |

## DEFER (with triggers)

| Item | Why not now | Trigger |
|---|---|---|
| Capability contract I/O/P/D/E/F/L and capability graph | no consumer selects by capability; `swarm_capabilities` shows an unconsumed registry rots (377/498 deprecated) | a router or planner that would pick between ≥ 2 measured capabilities for the same task |
| MAP-Elites / novelty search / multi-objective selection | no promoted genome; one niche with an executed oracle; nothing to keep diverse | ≥ 2 niches with executed oracles and ≥ 2 promoted genomes |
| Non-software niches (security, research, knowledge, operations, content) | no executed oracle | an oracle per niche (e.g. CodeQL alert fixed for security) |
| Tool and swarm-topology credit | no ablation; topology modules dormant | a tool or topology change proposed for a lane with ≥ 4 goals/day |
| Transfer / inheritance across agents | 0 promotions to transfer | first promoted genome or ACE-001 arm with a significant main effect |
| Canary deployment | one VPS, one container | a second serving instance |
| Budget allocation by information gain (act) | EVC is shadow; X1 interim says siblings cost more than they buy (0/3 vs 8/11, n 15) | X1 reaches 94/arm |
