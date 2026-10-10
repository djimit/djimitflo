# ACE — current state (baseline, 2026-10-10)

Operator directive "DjimitFlo Evolution Engine 2.0 / Autonomous Capability Evolution (ACE)", 10-10. This file is the
forensic baseline the directive asks for first: what the 11-stage loop already has in code and in prod, read-only.
Code evidence is `origin/main` fb597f45; prod state is the deployed build d69d1451 and the flags recorded in the
operator plan (runtime.env backups `.bak-2026100*`). Paths are relative to `packages/server/src/`.

States: **IMPLEMENTED** (code + live in prod with a consumer) · **PARTIAL** (code exists, shadow, dormant or missing a
link) · **DECLARED_ONLY** (named in docs/tables, no working path) · **MISSING**.

## 1. The ACE loop mapped onto existing parts

| Stage | Existing part (file:line) | Prod state | State |
|---|---|---|---|
| Discover | fleet `discovery.*` bus events → `services/external-event-ingest-service.ts:192` (`ingestDiscovery`); scout + HF Daily + operator reading list publishers (`scripts/fleet-discovery-publisher.py`); interest profile `services/interest-feedback.ts:87` | live; 7 249 discovery events / 14 d, 71 % from one scout (HHI 0.54) | IMPLEMENTED |
| Discover → relevance | jev `discovery_relevance` judgment; source gate `services/committee-swarm.ts:271` (`fleetSourceGate`); FE2 units only for relevant (`FRONTIER_UNITS_REQUIRE_RELEVANCE`) | live; 83 % of verdicts `uncertain`, relevant set 95 % from the scout | PARTIAL — no ground truth for precision |
| Discover → gap-driven search | — (discovery is source-driven: feeds and profiles, never "search for a fix to measured failure X") | — | MISSING |
| Understand | Frontier units → technique cards + claims `services/technique-card-service.ts:48` (abstract fetch `:26`); claims since #727 | live; 84 claims since 09-10 | PARTIAL — claims have no consumer (Phase KE) |
| Reverse-engineer | `services/shipped-code-scan.ts:228` (`scanPackage`), `:345` (`diffReports`) — parse-only, never executes the target | `SHIPPED_CODE_SCAN_MODE=shadow`, 4 runtimes scanned daily | PARTIAL — evidence only, no gate consumes it |
| Reproduce | gym replays mined fix commits `services/gym-task-miner.ts:44`; seeded mutant-repair `services/gym-mutants.ts:63`; failure-derived `write_test` tasks with seeded target mutants `services/gym-failure-tasks.ts:36` | remote gym live (cap 20/day); `GYM_FAILURE_TASKS_ENABLED=true` | IMPLEMENTED for our own repo only |
| Benchmark | graded fitness `services/graded-fitness.ts:27` (mutant-kill share); paired trials + McNemar/permutation `services/dream-evolution.ts:26,80`; holdouts (`gym_holdout`, `database/migrate.ts:1301`); IRT `services/gym-irt.ts:40`; exposure `services/evolution-evidence.ts:106` | graded shadow; holdout epochs 0 exhausted (11/10, 12/10 candidates) | PARTIAL — benchmark exists, its holdouts are spent |
| Improve | dream mutation of strategy genomes `services/dream-evolution.ts` (`evaluateTrials` `:419`); committee evolution `services/committee-swarm.ts:170`; model selector `services/model-selector.ts:94` | `DREAM_EVOLUTION_ENABLED=false` since 09-10; 14 genomes, 0 promoted; selector shadow | PARTIAL (dormant) |
| Integrate | maker/checker lanes `services/loop-daemon.ts` (bandit `:511`, X1 `:601`, F2 `:732`); evolve selection `services/evolve-selection.ts:74`; scope gate + policy-violation log `services/policy-violations.ts:13`; human merge of draft PRs | live; only test-writing lanes verify | IMPLEMENTED for tests; DECLARED_ONLY for source capabilities |
| Verify | deterministic checks + checker + security checker; runtime admission `execution/execution-engine.ts:320`, `execution/runtime-admission.ts:48` | live; F1 checker AUC 0.875 | IMPLEMENTED |
| Deploy | auto-deploy + post-deploy verdict `scripts/auto-deploy.sh:42`, check gate `:80` | live; d69d1451 verdict_ok 17:16Z | IMPLEMENTED (whole build, no canary) |
| Learn | outcome attribution `services/outcome-attribution.ts:53`; merge survival `services/merge-survival.ts:59`; K1 examples + memory rules `services/assignment-context.ts:43`; memory holdout (`MEMORY_HOLDOUT_RATE`, `services/evolution-evidence.ts:41`); KB retrieval `services/kb-corpus.ts:54` | attribution live; merge survival n = 2 settled; memory holdout 0.3 live | PARTIAL — learning signals exist, effect unproven |

**Reading:** the loop is closed end to end for exactly one capability class — *writing tests for our own code* — where
an executed oracle exists. Every other stage either stops at evidence (reverse-engineer, understand) or is dormant
(improve) because the benchmark has no headroom and its holdouts are reused.

## 2. The seven subsystems

| Subsystem | What exists (evidence) | Live / shadow / dormant / dead | Measured effect |
|---|---|---|---|
| Agent evolution | strategy genomes `services/genome-registry.ts:215` (`strategyGenomeFor`), `services/maker-genome.ts:15`; bandit over species `loop-daemon.ts:511` | genome trials dormant (dream off); bandit live (`LOOP_BANDIT_ENABLED`) | 14 genomes, 0 promoted; every trial tied or lost on a ~80–90 % base-rate holdout |
| Subagent / swarm evolution | evolve siblings + X1 randomisation `loop-daemon.ts:601`; committee swarm `committee-swarm.ts:170`; F2 cross-family checker `loop-daemon.ts:732`; `swarm_sessions` (`database/migrate.ts:2118`) | X1, F2 collecting (target 94 / 93 per arm); committee capped 10/day; swarm sessions dormant | X1 interim siblings ON 0/3 vs OFF 8/11 (n 15, not significant); 0/20 committee forecasters with skill |
| Skill evolution | K1 examples `assignment-context.ts:9`; `SkillEvolutionGym` `services/skill-evolution-gym.ts:15`; `agent_skills` table | K1 live; skill gym and `agent_skills` effectively unused | K1 picks the 2 most recent verified paths (recency, not similarity); no measured effect |
| Memory evolution | memory rules with P1 seal + fitness (`LOOP_MEMORY_RULES_ENABLED`); memory holdout arm (`MEMORY_HOLDOUT_RATE=0.3`) | live | F3: inconclusive, trend *against* rules (2 V vs holdout 4 V, n 5–6/arm) |
| Knowledge evolution | Frontier units/areas, technique cards, claims (`technique-card-service.ts`), KB corpus + passage gate `kb-corpus.ts:25,54,94`, `knowledge_refs_json` on genomes (`database/migrate.ts:1378`) | live (KB context, cards); claim consumer missing | F4: KB pages cited in 44/52 panels, decision mix unchanged; 0 proposals or genomes cite knowledge |
| Learning evolution | gym curricula (mined, mutant tiers, write_test, IRT), graded fitness, paired trials, e-process, forecast scoring `services/forecast-scoring.ts:36` | gym live at cap; graded shadow; trials dormant | atomic 80.8 % gym vs 5.7 % prod (3/53): the gym does not predict production |
| Infrastructure evolution | model selector + LLM ledger `model-selector.ts:24,40,56`; runtime admission; resource ledger (`RESOURCE_LEDGER_ENABLED`); remote makers `services/remote-maker-queue.ts:8`; Qdrant | selector shadow; ledger live (23 % energy coverage); Qdrant swarm path **dead** (embedding model 404, 384 vs 768 dims) | per-kWh INSUFFICIENT_EVIDENCE; panel model A/B showed a hand-made prompt misleads (06-10 rollback) |

## 3. What is absent (verified by search, no file found)

- **External capability intake into code.** No path takes an external repository, paper or binary through
  Reproduce → Benchmark → Integrate. External material reaches the system only as discovery units, technique cards,
  claims and KB pages — text that is cited, never executed or adopted.
- **Capability registry / capability graph** as a data structure with gaps, dependencies and alternatives. Closest:
  the E4 taxonomy (Frontier capabilities) and the runtime-admission ledger; neither models DjimitFlo's own capability
  gaps.
- **Canary deployment.** Deploy is whole-build; the only staged rollout is shadow → act per flag.
- **Combination evaluation.** Subsystems are measured one at a time (X1, F2, memory holdout); no factorial or
  interaction design exists.

## 4. Safety invariants already in force (any ACE work must keep them)

Gates, oracles, the security checker, auth/deploy/secrets and the human merge are never evolved (plan §1); no candidate
may alter its own evaluator (Phase IM); promotion is blocked on an exhausted holdout epoch (#753); outbound guard
(`OUTBOUND_DENY_HOSTS`), runtime admission, content_safety on untrusted input, P1 artifact seals; community packages,
hooks and MCP servers are never installed (standing operator rule).
