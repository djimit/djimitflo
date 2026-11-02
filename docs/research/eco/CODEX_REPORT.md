# CODEX master directive (11-10): report

Scope: the 13 deliverables of the operator's CODEX MASTER DIRECTIVE. Evidence is reused from earlier audits (linked) plus fresh
read-only prod queries on 11-10 ~14:30Z (container `djimitflo-live`, SQLite read-only). Labels: IMPLEMENTED_AND_PROVEN,
IMPLEMENTED_UNPROVEN, PARTIAL, DORMANT, BROKEN, MISSING, UNKNOWN. No capability-improvement claim is made anywhere in this report.

## 1. Executive verdict

1. Djimitflo is a working **oracle-graded test-writing factory**, not yet an evolving system: one capability class (test files in its own repo) runs the full loop; nothing else does.
2. No genome, skill, memory policy or knowledge item has a validated, production-transferred improvement. Evolution: INSUFFICIENT_EVIDENCE.
3. Evaluation integrity is now enforced at one promotion boundary (#772, open), after #753 left a fail-open path (exposure errors read as a fresh holdout).
4. The bandit reward counted infra, no-change and gate-passing contest losses as maker losses; fixed in #771 (open).
5. The largest causal bottleneck is **gym → production transfer**: workstation species 78.8 % in the gym vs 7.0 % in production (30 d). Gym-derived selection cannot be trusted until that gap is explained.
6. Four ablations run on production goals (ACE-001, STE-001, X1, F2, plus memory holdout), but they share ~4.5 oracle goals/day; results need 6–7 weeks.
7. **New in this report:** ACE-001's treatment is mostly not delivered. 2 of 11 treated factor slots received the treatment; the rest fell back to control for lack of a proposal vector, so the experiment currently measures intent, not treatment.
8. Commons produces no verified change; its idle state is a deliberate switch-off (energy reallocation 09-10), not a fault.
9. Ground truth for production survival is n = 2 merged-and-settled loop PRs.
10. Next action: measure ACE-001 treatment delivery and fix the fallback before more goals are spent (§12).

## 2. Repository baseline

| Item | Value |
|---|---|
| origin/main (HEAD of this worktree) | `04510d0116fab8fe497572f47e50f0d9745657f0` (#769) |
| Prod | `04510d01`, `commit_matches_build: true`, last verdict_ok 14:17Z |
| Open PRs relevant here | #771 fitness audit, #772 promotion boundary (in merge train); #766 (Telegram delivery, not part of this work) |
| Local checkout `~/djimitflo` | stale branch `audit/fase5-close-loop` with uncommitted operator files; untouched |

Key prod flags (names from `runtime.env`, values from the plan): `ACE_001_MODE=on`, `STE_001_MODE=on`, `GYM_HOLDOUT_EPOCH=1`,
`MEMORY_HOLDOUT_RATE=0.3`, `EFFORT_SIBLING_RANDOMISE=true` (X1), `CHECKER_FAMILY_RANDOMISE=on` (F2), `LOOP_BANDIT_ENABLED=true`,
`OUTCOME_ATTRIBUTION_ENABLED=true`, `MERGE_SURVIVAL_ENABLED=true`, `DREAM_EVOLUTION_ENABLED=false`, `GRADED_FITNESS_MODE=shadow`,
`GRADED_CONTEST_MODE=shadow`, `MODEL_SELECTOR_MODE=shadow`, `TYPESAFE_PROPOSAL_PRESCREEN_MODE=enforce`, `COMMITTEE_SWARM_ENABLED=true`,
`EVOLUTION_GYM_REMOTE_MAX_PER_DAY=20`, `WEAK_ASSERTION_CHECK_MODE=shadow`, `SHIPPED_CODE_SCAN_MODE=shadow`.

## 3. Verified existing capabilities (code + tests + prod data)

| Capability | Evidence |
|---|---|
| Oracle test lanes (test-gap / exports / mutation) produce verified changes | 30 d opencode prod 53/144 verified; 22 loop PRs merged by the operator |
| Deterministic gates + checker + scope gate | `loop-daemon.ts`, `runDeterministicChecks`; F1 replay: checker AUC 0.875 on 20 good / 20 defective diffs |
| Outcome attribution (maker / reviewer / environment / unknown) | `outcome-attribution.ts`; 23 backfill annotations 10-10; cockpit shows unknown separately (#742) |
| Holdout freezing, exposure tracking, epoch rotation | `genome-registry.ts`, `holdoutExposure`; epoch 1 live |
| Paired genome trials (McNemar / graded) | `dream-evolution.ts` `evaluateTrials`; 17 genomes evaluated (1 active baseline, 6 inconclusive, 10 retired); 0 non-baseline promotions |
| Randomised production ablations | ACE-001, STE-001, X1, F2, memory holdout: assignment by `sha256(goal)`; gates identical (tests) |
| Merge survival labelling | `merge-survival` service; 2 settled, both survived |
| Explicit health states, no false green | #742/#749 (cockpit), #739 (detector health) |
| Outbound guard, policy-violation log | 2 `outbound_denied` rows (hand-added `djimitkb-mcp` probe), guard working |

## 4. Falsified assumptions

| Assumption | Source | Evidence against |
|---|---|---|
| "Exhausted holdouts might not block promotion" | this directive | Partly true: #753 blocked in `evaluateTrials`, but `holdoutExposure` swallowed errors → fail-open; fixed at one boundary in #772 |
| Commons 737 proposals vs 761 statuses = aggregation error | operator Commons analysis | 688 + 42 + 7 = 737; the 761 was an addition slip (`scratchpad/commons-trace.md`) |
| `planner_accuracy` measures planning | code | It counts completed maker leases (#771 renames it) |
| Assertion-strength check never evaluates on prod | B13 review | It evaluates; shadow keeps `status: skipped` by design, verdict in `shadow_status` (#754) |
| Reviewers see 'skipped' for assertion strength | my #754 note | Reviewer summary already shows `shadow <verdict>` since #730 (#767 guard test) |
| ACE-001 compares similarity vs recency examples | ACE-001 protocol | In production the control arm received **0 examples** in 6 of 7 observed contexts (`examples: []`, `examples_source: fallback_recency`); the S contrast is closer to "2 similar examples vs none" — see §8 |
| Gym success predicts production | historical design | 78.8 % gym vs 7.0 % prod for the same species (30 d) |
| A per-kWh efficiency figure exists | cockpit before #741 | 23 % power coverage; now INSUFFICIENT_EVIDENCE |

## 5. Causal bottlenecks (ranked)

```
GYM/PROD MISMATCH ──► gym fitness ≠ production fitness ──► genome selection on gym data untrustworthy ──► no defensible evolution
TREATMENT FALLBACK ─► ACE-001 arms mostly receive control context ──► ablation measures intent, not mechanism ──► 6–7 weeks may yield nothing
LOW VOLUME (4.5 oracle goals/day) ──► every production experiment needs weeks ──► 5 concurrent factors dilute nothing but delay all
REWARD NOISE (fixed in #771) ──► bandit routed on unfair zeros ──► species selection biased
SPARSE SETTLEMENT (n=2) ──► no production survival ground truth until ~19-10
KNOWLEDGE WITHOUT CONSUMER ──► claims/cards cited, never decision-moving (F4) ──► no knowledge→experiment edge
```

| # | Bottleneck | Evidence | Impact | Confidence | Subsystems |
|---|---|---|---|---|---|
| 1 | Gym→prod transfer | 569/722 vs 4/57 (workstation, 30 d) | blocks trustworthy selection of any genome/species | high (counts); cause UNKNOWN | gym, dream evolution, bandit, D6 |
| 2 | ACE-001 treatment fallback | 2/11 treated slots delivered (§8) | the main production ablation may be uninformative | medium (n = 8 contexts) | ACE-001, embeddings |
| 3 | Production volume | ~4.5 oracle goals/day; caps 8 test-gap + 4 mutation | all causal answers take weeks | high | all experiments |
| 4 | Settlement sparsity | 2 merge outcomes | no long-term fitness | high | merge survival, U1 |
| 5 | Knowledge has no consumer | F4: KB cited 44/52 panels, decision mix unchanged; 0/1 300 proposals cite knowledge | discovery spend without effect | high | Frontier, KB, discovery |
| 6 | Memory value unproven | F3: rules arm 2 V vs holdout 4 V (n 5–6) | memory rules may be neutral or harmful | low (n) | memory rules |

## 6. Implemented changes (this directive series)

| PR | Problem | File / function | Minimal fix | Compatibility |
|---|---|---|---|---|
| #753 `fb597f45` | promotion on a reused holdout | `dream-evolution.ts` `evaluateTrials` | inconclusive when exposure > limit | none |
| #772 (open) | #753 check only in one path; exposure errors fail open | new `genome-promotion.ts` `holdoutValidity` / `promoteGenome` | single writer of `status='active'`, unknown → refuse | none; static test pins it |
| #771 (open) | bandit reward counted non-maker zeros as losses | `runtime-bandit.ts` | exclude infra / no-change / gate-passing contest losers | bandit shares shift toward the fair rate |
| #758 `2ca59259` | grounded target invisible to prescreen; unparseable panel = verdict | `self-improvement-service.ts`, `specialist-panel-service.ts` | target in description; panel_failed → retry once | path stays off by design |
| #763 `118e47f1` | discovery not steered by failures; funnel hid stop steps | `interest-feedback.ts`, Commons funnel | gap trial slot (kill rule 14 d / 18.1 %); stop-step counts | display + 1 trial slot |
| #767 `a58dcf51` | gym outcomes unhashed; token rejections opaque; loose token parse | `gym-skill-hash.ts`, `spawn-token.ts`, `routes/remote-gym.ts` | hash, logged reason, exact 3 fields | narrower token acceptance |
| #768 `2dfbff84` | 2 735 paper units without abstract (no paper id) | `technique-card-service.ts`, DataCite adapter | copy abstract from same-title row; fetch under real ref | ponytail: exact-title match |
| #769 `04510d01` | ambiguous maker instructions untested | `ste-lint.ts`, `ste-001.ts`, `MAKER_TEMPLATE_RULES_STE` | STE lint + STE-001 factor | flag-gated |

## 7. Test evidence (from PR bodies; commands run in builder worktrees)

| PR | Command / suites | Result |
|---|---|---|
| #753 | `npx vitest run holdout-reuse-block` + 10 related suites | 3 new (reused case fails on old code); 88 tests pass; tsc + eslint clean |
| #772 | `npx vitest run promotion-path-integrity` + 10 related suites | 6 new, 4 fail on origin/main; 89 tests pass; tsc + eslint clean |
| #771 | runtime-bandit, g32-meta-evolution, curiosity, fitness-view, evolve suites | 57/57; new bandit test fails on old code |
| #758 | `commons-grounding-defects.test.ts` + 25 related files | 3 new (2 fail on old code); 168 tests pass |
| #763 | `eco-gap-discovery-funnel.test.ts`; full server suite | 4 new (3 fail on main); full suite 4167 passed, 1 expected fail |
| #767 | `followups-1110.test.ts` + 24 related files | 4 new (3 fail on main); 123 tests pass |
| #768 | `technique-card-service.test.ts` + 7 related files | new test fails on old code; 38 pass |
| #769 | `ste-001.test.ts`; full server suite | 8 new; 4180 passed |

Not run in this report: end-to-end tests, property-based tests, failure injection beyond the cases above. No security test suite was
added for memory/knowledge poisoning in this series.

## 8. Experimental evidence (prod, read-only, 11-10 ~14:30Z)

| Experiment | Arms / counts | Status |
|---|---|---|
| Phase-1 requeue (reviewer failures) | 14 of 30 requeued: 7 verified / 3 regressed / 1 infra of 11 settled (64 %); 3 scheduled | above the 40 % falsifier; n small |
| ACE-001 (R × S, target 50/cell) | 00: 1/1 · 01: 1/2 · 10: 0/1 · 11: 1/2 verified | collecting; INSUFFICIENT_EVIDENCE |
| STE-001 (target 100/arm) | arm 0: 1/3, arm 1: 0 | collecting |
| X1 sibling randomisation | off 21 · on 10 events | collecting (target 94/arm) |
| F2 checker family | cross 5 · same 6 | collecting (target 93/arm) |
| Memory holdout (30 d) | 16 holdout vs 274 rules-on assignment contexts | collecting |
| Merge survival | 2 settled, 2 survived | n too small |
| Genome trials | 17 genomes: 1 active (baseline), 6 inconclusive, 10 retired | 0 promotions; dream evolution off |
| Gym vs prod (30 d) | workstation gym 569/722 (78.8 %) · prod 4/57 (7.0 %); opencode gym 8/18 · prod 53/144 (36.8 %) | transfer gap |

**ACE-001 treatment delivery (new finding).** The 14 assignment contexts since ACE-001 went live:

| arm | fallback | examples injected | KB pages | n |
|---|---|---|---|---|
| none (non-oracle lane) | – | 0 | 0 | 6 |
| 00 | – | 0 | 0 | 1 |
| 01 | – | 2 | 0 | 1 |
| 01 | s | 0 | 0 | 1 |
| 10 | – | 0 | 1 | 1 |
| 11 | s + r | 0 | 0 | 4 |

Treated factor slots: 01 ×2 (S), 10 ×1 (R), 11 ×4 (R + S) = 11; delivered: 2 (18 %). The 4 arm-11 contexts are likely retries/siblings of
one goal without a proposal vector (same goal → same arm). The control arm received 0 examples, so the protocol's "recency" baseline is
not what production gives. Uncertainty: n = 8 oracle contexts; the fallback rate must be measured over more goals before acting.

**Memory influence trace (3 most recent production maker runs, 11-10 13:59–14:01Z, test-gap lane):**

| run | injected | why | arms | outcome |
|---|---|---|---|---|
| `74390405` | 3 memory rules (`95a34322`, `aa2a9224`, `62031529`); 0 examples; 0 KB | rules: fitness-selected engineering rules; examples: S fallback | memory rules on, ACE 01 (S fallback), STE 0 | regressed (run blocked) |
| `e9a0f9f1` | same 3 rules; 0 examples; 0 KB | same | ACE 11 (R + S fallback), STE 0 | verified |
| `73fd8de8` | same 3 rules; 0 examples; 0 KB | same | ACE 11 (R + S fallback), STE 0 | regressed (run blocked) |

Which decision a rule influenced is **UNKNOWN**: the system records injection and outcome, not use. The same three rules were injected
into a verified and two regressed runs.

**Gym → production transfer: concrete differences.**

| Dimension | Gym (`scripts/gym-worker.mjs` `gymGoal`) | Production remote maker (`runMakerJob`) |
|---|---|---|
| Prompt | one precise sentence: file, target, exact vitest command, "change only X" | full LOOP_WORK assignment (objective header, rules, examples, memory rules) flattened by `oneLine()` into one long line |
| Task source | mined fix commits, seeded mutants, failure-derived write_test | real gap proposals (untested exports, mutation targets) |
| Oracle | tests green + prod gates (`GYM_PROD_GATES`) + mutant kill | deterministic gates + LLM checker + security checker + scope gate + evolve contest vs opencode |
| Outcome counted | gym attempt success | skill outcome after contest; 6 of 53 zeros were gate-passing contest losses (#771) |
| Budget | `--max-steps 60`, 900 s | same binary and limits |

Most discriminating experiment (not run): on 20 frozen write_test gym tasks, run atomic@llama-router twice per task, once with
`gymGoal()` and once with the production assignment text generated for the same target (paired, same seed/model). Prompt mismatch
predicts a large drop (≈ 79 % → ≈ 10–20 %); with that effect McNemar at 20 pairs has power > 0.9. A small drop points the gap at
the oracle/contest/task distribution instead. Cost: 40 gym attempts ≈ 2 days of the 20/day cap.

**Commons idle causes (directive's 8 classes).**

| Class | Evidence | Verdict |
|---|---|---|
| transport/connectivity | external agents have no adapters; 0 agent heartbeats in 24 h | applies to external agents |
| identity/authentication | per-agent tokens exist; no rejected-token evidence for residents | not dominant |
| routing | — | UNKNOWN |
| runtime | residents' runtime set off: `SOCIAL_AUTOPILOT_RUNTIME=off` in compose since 09-10 energy reallocation | **dominant for residents — intentional** |
| capability mismatch | grounded proposals are feature ideas without an executable oracle (commons-trace) | dominant for yield |
| task selection | panel 'backlog' never becomes a goal (3 of 24) | minor |
| model quality | 10 of 24 groundings archived after a model-failure panel (fixed #758) | historical |
| incentive/protocol | Commons judgments off (Y7), forecast-only residents | intentional |

`agents` table: 28 rows, all labelled `active`, 0 heartbeats in 24 h → the `active` label is not liveness (the cockpit uses
connection_state instead).

## 9. Security assessment

| Item | Status |
|---|---|
| New trust boundaries | none added; #767 narrows token acceptance |
| Candidate → evaluator | genome lines are prompt text only; #772 guard rejects evaluator-targeting lines; static test pins the single promotion writer |
| Candidate → own promotion criteria | memory review can file a proposal to change its own panel criteria (ends behind the human merge) — residual |
| Holdout leakage | protected answers are never sent to makers (gym worker receives task + target, not the original fix); not re-tested in this series |
| Poisoning (memory / knowledge / skills) | content_safety on untrusted input (shadow scope); no adversarial poisoning test exists → MISSING |
| Outbound | guard blocks workstation addresses; 2 shadow rows logged |
| Audit | #743 records human actors; self-approval flagged |
| Residual | no property-based or failure-injection tests for promotion; `skill_genomes` mutates fitness numbers in place (unread) |

## 10. Evolution status

| Component | Status |
|---|---|
| Oracle test lanes | IMPLEMENTED_AND_PROVEN (verified + merged) |
| Outcome attribution | IMPLEMENTED_UNPROVEN (CAR audit sampler waits for operator labels) |
| Genome trials / promotion | IMPLEMENTED_UNPROVEN (0 promotions); DORMANT in prod |
| Holdout integrity | IMPLEMENTED_UNPROVEN (#772 pending deploy) |
| Graded fitness | IMPLEMENTED_UNPROVEN (shadow) |
| Bandit selection | PARTIAL (reward fixed in #771; little real-maker data per species) |
| Memory rules | IMPLEMENTED_UNPROVEN (holdout running; F3 trend against) |
| Knowledge → experiment | BROKEN edge (no consumer) |
| Skill evolution (`skill_genomes`) | DORMANT / proxy design (0 rows) |
| Committee swarm forecasters | IMPLEMENTED_UNPROVEN (19 forecasters, none decision-grade) |
| Commons collective intelligence | DORMANT (residents off) |
| Capability graph / gap engine | MISSING (by decision: no consumer) |
| Production transfer measurement | PARTIAL (counts exist, cause UNKNOWN) |
| Settlement | PARTIAL (n = 2) |
| Harness evolution | PARTIAL (template gene + STE-001; no harness ablation beyond prompts) |
| Meta-evolution | DORMANT |

## 11. Remaining bottlenecks (ranked)

| # | Bottleneck | Impact | Confidence | Depends on | Effort | Risk |
|---|---|---|---|---|---|---|
| 1 | ACE-001 treatment fallback | high (protects 6–7 weeks of data) | medium | none | small (embed missing proposals at creation or at goal time) | low |
| 2 | Gym → prod transfer cause | high | high on gap, none on cause | gym cap budget | small experiment (40 attempts) | low |
| 3 | Control arm gets 0 examples | medium (protocol validity) | medium | #1 | small | low |
| 4 | Memory value | medium | low | holdout data | none (wait) | — |
| 5 | Knowledge consumer | medium | high | a selection signal | medium | low |
| 6 | Settlement volume | high | high | time (~19-10) + operator merges | none | — |

## 12. Next best action

**One:** measure ACE-001 treatment delivery over all oracle goals since 10-10 19:06Z and, if the fallback rate stays above ~20 %, embed
every oracle-lane proposal at creation (the K2 `proposal_embeddings` path exists) so treated arms receive their treatment — before
more goals are spent on an experiment that cannot detect its mechanism.

Secondary:
1. Run the paired gym prompt-mismatch experiment (§8) to locate the gym→prod gap.
2. Align ACE-001's control with the protocol (recency examples actually injected) or amend the protocol before analysis.
3. Merge and deploy #771/#772; confirm `promoteGenome` is the only writer in the deployed build.
4. ~19-10: read the first merge-survival labels; decide U1 / auto-merge act on them.

## 13. Evidence index

| Topic | Location |
|---|---|
| Single promotion boundary | `packages/server/src/services/genome-promotion.ts` (PR #772), `__tests__/promotion-path-integrity.test.ts` |
| Holdout block | `services/dream-evolution.ts` `evaluateTrials` (#753), `__tests__/holdout-reuse-block.test.ts` |
| Bandit reward | `services/runtime-bandit.ts` (#771), `__tests__/runtime-bandit.test.ts` |
| Fitness audit | `docs/research/eco/FITNESS_AUDIT.md` (#771) |
| ACE-001 | `services/ace-001.ts`, `docs/research/ace/ACE-001_PROTOCOL.md`, `assignment_context` loop events |
| STE-001 | `services/ste-001.ts`, `services/ste-lint.ts`, `docs/research/ace/STE-001_PROTOCOL.md` |
| Memory injection | `services/assignment-context.ts`, `services/loop-service.ts:2298` |
| Gym prompt | `scripts/gym-worker.mjs` `gymGoal()`, `runMakerJob()`, `oneLine()` |
| Commons trace | `scratchpad/commons-trace.md`; #758, #763 |
| Prod reconciliation | `scratchpad/b3-reconciliation.md`; `docs/research/operator-cockpit-3/` |
| Current state / gaps | `docs/research/ace/CURRENT_STATE.md`, `GAP_ANALYSIS.md`; `docs/research/eco/PHASE0_AUDIT.md`, `PHASE_PLAN.md` |
| Commits | #753 `fb597f45`, #758 `2ca59259`, #763 `118e47f1`, #767 `a58dcf51`, #768 `2dfbff84`, #769 `04510d01` |

### Revalidated historical ACE findings

| Finding | Now | Evidence |
|---|---|---|
| Holdouts exceeded reuse limits | RESOLVED for new trials (epoch 1 since 10-10); epoch 0 exhausted | `GYM_HOLDOUT_EPOCH=1` |
| Holdout exhaustion does not hard-block promotion | PARTIALLY_RESOLVED → RESOLVED on #772 deploy | #753 fail-open on errors; #772 |
| Gym lacks headroom | CURRENT | parent 17/20 on mined holdout; probe tiers ≈ 85 % |
| Dream evolution dormant | CURRENT (by decision) | `DREAM_EVOLUTION_ENABLED=false` |
| Genomes rarely/never promote | CURRENT | 0 non-baseline promotions of 17 |
| Skill evolution disconnected from executable behaviour | CURRENT | `skill_genomes` 0 rows; traits mutated in place (#771 audit) |
| Memory improvement unproven | CURRENT | holdout 16 vs 274 contexts; F3 inconclusive |
| Knowledge retrieval rarely changes decisions | CURRENT | F4; 0 proposals cite knowledge |
| Commons activity ≠ collective learning | CURRENT | 0 verified from Commons; residents off |
| Forecasters lack decision-grade skill | CURRENT | 19 forecaster judgments, all insufficient |
| Swarm experiments lack power | CURRENT | X1 31 events, F2 11 vs targets 94/93 per arm |
| Gym poorly predicts production | CURRENT | 78.8 % vs 7.0 % |
| Settlement evidence sparse | CURRENT | 2 merge outcomes |
