# Fitness audit — what each score claims vs what it computes

Operator directive 11-10 (CODEX MASTER DIRECTIVE, FITNESS section). Scope: every fitness / reward / score / ranking /
success / verified / regressed / bandit / promotion use in `packages/server/src` that a decision, a learner or a
cockpit claim reads. Dream-evolution promotion is out of scope (builder B20). Prod facts: read-only query on
04510d01, 11-10.

Verdicts: **OK** (measures what it claims) · **PROXY_ERROR** (claims one thing, computes a cheaper proxy) ·
**MISLEADING_LABEL** (computation fine, name claims more) · **UNUSED** (no live consumer in prod).

## Decision-driving metrics

| # | Metric | Claims | Computes (file:line) | Drives | Verdict |
|---|---|---|---|---|---|
| 1 | Runtime bandit reward | maker species quality | verified/failed `skill_outcomes` per species, reviewer/env failures excluded (`runtime-bandit.ts` chooseSpecies) — **counted infra, no-change and eligible-evolve-loser zeros as losses** (prod: opencode 9 lost-eligible + 8 infra, workstation 6 of 53 zeros) | real maker traffic (LOOP_BANDIT_ENABLED=true) | PROXY_ERROR → **fixed** |
| 2 | Memory rule fitness (M5) | a rule's value | verified − maker-regressed among runs that read it (`assignment-context.ts:81`) — no baseline: at a 44 % base rate a rule gains fitness by being read on easy lanes; F3 (09-10) found the holdout arm no worse | which rules makers see | PROXY_ERROR → **not fixed now** (see below) |
| 3 | Evolve contest ranking | best maker change | hard gates, then mutation score, then **smaller diff** (`evolve-fitness-service.ts`) | which sibling wins | PROXY_ERROR, known: graded contest (SI-B) runs in shadow; GRADED_CONTEST_MODE=act is the operator's decision |
| 4 | Fleet source gate (AR-W6) | a discovery source's value | jev `discovery_relevance` yes-rate (≥ 50 judged, 0 relevant → stop) | stops ingest of a source | PROXY_ERROR, acknowledged at approval (04-10); upgrade = M6 "used in a verified run" |
| 5 | N4 interest profile yield | term usefulness | jev-yes rate vs the static-list baseline (`interest-feedback.ts`) | scout keywords | PROXY_ERROR, acknowledged (relevance, not verified capability) |
| 6 | Outcome attribution | who caused a failure | rules over failed gates + lease states (`outcome-attribution.ts`) | learners skip non-maker failures | OK |
| 7 | Graded fitness | test quality | mutant-kill share / red→green share (`graded-fitness.ts`) | contest + trials (shadow) | OK — observed phenotype |
| 8 | Merge survival | lasting value | ≥ 50 % of added lines still on main after 14 d (`merge-survival.ts`) | fitness source `merge` | OK (survival, not correctness; documented) |
| 9 | Fitness view (D0) | species fitness | weighted decaying posterior; `mean_clean` drops unfair zeros (`fitness-view.ts:39`) | shadow only | OK |
| 10 | Forecast skill | forecaster quality | Brier skill vs per-source base rate (`forecast-scoring.ts`) | arena gate, committee extinction | OK |
| 11 | Earned autonomy (U1) | class trustworthiness | human approvals / rejections / regressions per action class | auto-approve classes | OK |
| 12 | Model selector (MS-1) | cheaper model of equal quality | ok-rate + agreement with the incumbent (`model-selector.ts`) | shadow only (MODEL_SELECTOR_MODE=shadow) | PROXY_ERROR (agreement ≠ correctness), no decision while shadow |

## Cockpit / label-only metrics

| # | Metric | Claims | Computes | Consumer | Verdict |
|---|---|---|---|---|---|
| 13 | `planner_accuracy` (meta-evolution report) | planner accuracy | completed maker leases / all maker leases (`meta-evolution-service.ts:52`) | SSE `convergence` event, no reader | MISLEADING_LABEL → **renamed** `maker_lease_completion_rate` |
| 14 | Capability competence `success_rate` | capability success | completed leases / runs (`swarm-intelligence-service.ts:622`) | curiosity "competence gap" claims | MISLEADING_LABEL → gap text now says "lease completion rate"; field kept (shared type) |
| 15 | Agent reputation `score` | trust | 0.5 + task completion − failures − probe penalty (`agent-reputation-service.ts`) | advisory badge on join requests, never a gate | MISLEADING_LABEL (task completion ≠ trust); left — advisory only, documented in the service |
| 16 | Cockpit verified/regressed, tokens per verified | throughput | counts + spend vs direct tokens (CP3) | cockpit | OK (labelled "throughput, not intelligence") |
| 17 | KB retrieval hits | — | retrieval count | /knowledge | OK as a count; not presented as value |

## Unused in prod (proxy designs with no live consumer)

| # | Metric | Problem | Prod | Verdict |
|---|---|---|---|---|
| 18 | SkillEvolutionEngine genome fitness | mutates phenotype traits (reliability, generality) as if they were capabilities (`skill-evolution-engine.ts` mutate/crossover) | `skill_genomes` 0 rows; only the manual `/evolution/evolve` route | UNUSED — retire candidate (W8 14-10) |
| 19 | Proactive memory relevance | recency + usage count = "relevance" (retrieval count ≠ value) | `proactive_memories` 0 rows | UNUSED |
| 20 | Reasoning bank reward | approval decision = reward (approval ≠ correctness) | vector path dead (Qdrant swarm) | UNUSED |
| 21 | Memory candidate quality score | length/structure/keyword heuristic → promote | route only (`/memory-evolution`) | UNUSED |
| 22 | Meta-evolution dormant prune | 0 runs in 30 d → deprecated (zero use may be a routing failure) | 377 deprecated `swarm_capabilities`, table unread | UNUSED — W8 |

**Counts:** OK 9 · PROXY_ERROR 6 (1 fixed, 1 deferred, 4 known/acknowledged) · MISLEADING_LABEL 3 (2 relabelled) · UNUSED 5 (the 5 unused designs are all proxies).

## Fixed in this PR

1. **Bandit reward** (`runtime-bandit.ts`): a zero tagged `outcome_class:infra_failed`, `outcome_class:no_change` or
   `evolve:lost_eligible` is neither a win nor a loss — the same set fitness-view's `mean_clean` already excludes. An
   ineligible evolve loser still counts as a loss. Test fails on the old code.
2. **`planner_accuracy` → `maker_lease_completion_rate`** (meta-evolution report).
3. **Curiosity competence gap text**: "lease completion rate", not "success rate".

## Deferred, with reason

- **Memory rule fitness (#2):** the fix is to score a rule on excess outcome over the rules-off holdout arm,
  Σ(outcome − p_holdout) over its settled reads, instead of raw verified counts. Changing which rules makers see now
  would change the treatment of three running experiments (memory holdout, ACE-001, STE-001) mid-collection. Do it when
  the memory holdout settles, or as its own randomised arm.
- **Evolve ranking (#3):** graded contest in shadow; switching to act is the operator's decision once shadow shows real
  graded scores on ≥ 20 contests.
