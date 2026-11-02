# Recursive learning architecture: how the learning parts connect today

This describes the existing loop and the places where it breaks. It proposes no new framework, database, bus or orchestration
layer. "Recursive" here means only this: an outcome changes a component that produces later outcomes. Whether that **improves**
later outcomes on unseen tasks is not shown (see `INTELLIGENCE_SCORECARD.md`).

## The loop as it exists

```text
 proposal (self_improvements) ──► goal ──► maker lease ──► executed checks ──► checker / security_checker ──► gates
      ▲                              │  assignment context: memory rules,                         │
      │                              │  examples (recency), genome (strategy)                    ▼
      │                              │                                     settled: verified / regressed / infra / no_change
      │                              │                                                           │
      │                              │                          outcome attribution (#707) ──────┤ class + outcome_credits
      │                              │                                                           │
      │      ┌───────────────────────┼──────────── learners (maker-side, only maker_failure counts as failure) ◄──┘
      │      │                       │   runtime bandit (species) · fitness view (shadow) · memory-rule fitness
      │      │                       │   genome evidence · earned autonomy (display) · efficiency ledger (#706)
      │      │                       ▼
      │      │   effort controller (#708, shadow): sibling yes/no, gym band, judgment VOI → effort_decision rows
      │      │   X1 randomiser (acting): siblings on/off by hash(goal id)
      │      │
      │      └─► gym (workstation): mined / mutant / write_test / canary tasks ─► graded fitness (#710, shadow)
      │              │                                                              │
      │              ▼                                                              ▼
      │          genome trials (dream genomes vs baseline on frozen holdouts; DREAM_PROMOTION_RULE; #709 graded rule)
      │              │  promote / retire / inconclusive  (DREAM_EVOLUTION_ENABLED=false since 09-10)
      │
      └── generators: test-gap / mutation-gap / exports / doc-drift (gap_analysis 95 of 99 settled), reflection, requeue
          knowledge pipeline: discovery → unit → (claim) ─╳─► proposal / genome   (no link column until #727)
```

## Component by component

| Component | Learns from | Changes what | Acting or shadow | Evidence it helps |
| --- | --- | --- | --- | --- |
| Runtime bandit | attributed maker outcomes per species | which maker species runs | **acting** (maker species only) | OPE: fitness-view argmax vs bandit Δ −0.010 [−0.044, 0.021] (n 148); no fixed-model comparison |
| Memory rules (M5) | rule fitness from attributed outcomes | rules injected into the assignment | acting (injection), holdout 30 % | none: holdout p = 1; 0 rules with raw fitness > 0 |
| Examples | recency (2 latest verified test paths) | examples in the assignment | acting | not measured (no holdout arm) |
| Skills | — (SKILL.md text, no outcome link) | prompts | static | `agent_skills` 0, `skill_content_hash` NULL, `skill_genomes` 0 |
| Genomes (dream) | gym trials on frozen holdouts | maker strategy lines | promotion path exists; dream **off** | 0/16 promoted; 8 trials, 0 decisive |
| Gym | executed oracles (tests, mutants) | task difficulty band; trial evidence | acting (tasks), 20/day cap | proxy 0.957 vs prod-gated 0.478 on mutant tasks: gym ≠ prod |
| Graded fitness | mutant-kill share, red→green share, mutation score | contest labels, trial rule | shadow | pools: repair n 22, exports n 3, others 0 |
| Effort controller | EVC estimate | sibling / gym / judgment effort | shadow (161 decisions) | no comparison arm |
| Outcome attribution | lease metadata, gates, annotations | what learners count as failure | acting (labels for learners) | coverage 0.455; CAR unaudited |
| Resource ledger | tokens, GPU power | value-per-resource view | display | 1.40 kWh measured over 24.3 h; tokens per verified 0.656/M |
| Forecasters / committee | resolved proposals | arena gates | shadow | 0/20 decision-grade |
| Knowledge pipeline | discovery sources, jev relevance | units, technique cards | written-only | 0 claims from 680 card attempts; 0 proposals/genomes cite knowledge |

## Gaps that break the recursion

1. **No knowledge → proposal path.** 7,249 discovery events (14 d) end in units with no abstract. 0 of 1,300 proposals and 0
   genomes cite knowledge. #727 (open) adds abstracts and `knowledge_refs_json`, so at least the trace becomes possible.
   `outcome_credits` has a `knowledge` kind with 0 rows.
2. **The gym stores 0 diffs.** 778 gym runs produced executed-oracle labels but no (task, diff, oracle, gates) rows. The gym can
   therefore select strategies, but cannot supply training or repair-example data. Builder `feat/gym-diff-weak-assert`
   (`GYM_STORE_DIFFS`, redacted) is in progress.
3. **No fine-tune data, and none should be produced yet.** Threshold for a first fine-tune: ≥ 300 stored rows over ≥ 200 tasks,
   ≥ 100 failures, split by source file, holdout ≥ 100 weighted to tiers 4–6, paired McNemar. Checker labels are circular. Model
   training stays on HOLD (operator declined own-output fine-tuning in SI).
4. **Evolution has no headroom and no fresh holdout.** The parent passes 17/20 deciding tasks, so trials skip. Epoch 0 has been
   reused 8 times. `gym_write_test_holdout` has 0 rows.
5. **Skills are not evolvable assets.** They have no hash, no outcome link and no holdout. "Skill evolution" cannot be tested
   until a skill's identity is recorded on the lease.
6. **One repository.** Every learner is fit and evaluated on `djimitflo`. Overfitting to this repo cannot be detected.
7. **Durability labels lag.** Merge survival has 2 labels. Learners currently optimise "passes gates", which is the checker's own
   label for anything the checker gates.
8. **Failure memory is off.** `failure_cause` → dream rules was stopped (X3, 08-10; dream rules 0 V / 3 R). Nothing currently turns
   a classified failure into a remediation with a link back to its signature.

## Invariants (must hold for any change to this architecture)

- **No component evaluates itself.** The checker is evaluated on planted defects and merge survival, never on `verified`. Genomes
  are evaluated on frozen holdouts they cannot read. Forecasters are scored only on forecasts made before goal creation.
- **No candidate changes its own evaluator.** Genomes cannot edit gym-worker, holdouts, the promotion rule or gates. Memory rules
  cannot change rule fitness. Attribution changes are operator-reviewed and re-audited (CAR).
- **Hard floors are never selected away.** Gates, security checker, human merge, auth/deploy/secrets (charter §1), and the
  ≥ 5 % exploration floor of the effort controller (invariant test in #711).
- **Shadow before act.** Each acting class needs operator approval.
- **Executed verifier first.** Under operator rule S1 (09-10), no evolving artefact is admitted without an executed verifier;
  LLMs propose but never certify.
