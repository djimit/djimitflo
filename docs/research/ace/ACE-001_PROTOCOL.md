# ACE-001 — retrieval × skill selection (pre-registration)

Operator directive 10-10 ("DjimitFlo Evolution Engine 2.0", experiment ACE-001). Registered before any arm ran. Flag `ACE_001_MODE` (default `off`).

## Hypothesis

Giving the maker knowledge and examples chosen by similarity to its task raises the share of oracle-lane goals that verify, without raising inference cost or regressions.

## Population

Real maker goals of the oracle lanes: test-gap, exports (`test-gap:<svc>#exports`) and mutation (`mutation-gap:<svc>`). Nothing else is in the experiment.

## Arms (2 × 2 factorial)

`arm = sha256('ace-001:' + goal_id) mod 4`. Every run of a goal (retries, evolve siblings) is in the same arm.

| Arm | R (knowledge) | S (examples) |
|---|---|---|
| 00 — A, control | today's context | today's K1 examples: the 2 most recent verified tests of the lane (mutation: none) |
| 01 — C | today's context | the 2 verified tests of the same lane whose proposal vector is closest to this goal's proposal |
| 10 — B | + top-3 KB pages by cosine to the goal's proposal (≥ 0.3), as reference data | today's K1 examples |
| 11 — D | + KB pages | similarity examples |

- **No network on the assignment path.** Both retrievals use vectors stored earlier: `proposal_embeddings` (written at proposal insert, `PROPOSAL_DEDUPE_MODE=shadow`) and `kb_pages` (KB ingest). KB pages whose body no longer matches their ingest sha are skipped (P1).
- **Intent to treat.** A goal whose proposal has no stored vector keeps the control context in that factor and records `fallback` (`r`, `s`). Prod coverage over 30 days: 73 % of oracle-lane proposals have a vector (exports 96 %, mutation 74 %, test-gap 49 %).
- **What does not change:** gates (`LOOP_DAEMON_CHECK_SCRIPTS`, diff limit, scope gate), checkers, security checker, approval, merge. A test pins that the check set is identical with the flag on.
- **Memory rules.** Rules are not retrieved by similarity: they have no stored vectors, and there are 16 promoted engineering rules (choosing 3 of 16 is a small lever). `MEMORY_HOLDOUT_RATE` keeps running with its own salt, so it is an independent third factor; ACE analyses stratify by it. Replacing it would end an experiment that is already collecting, and independent randomisation keeps both unbiased.

## Endpoints

- **Primary:** the goal's proposal is `verified` (pass/fail) — the production oracle (tests, lint, type-check, mutation where applicable, checker, security checker).
- **Secondary:** graded score (mutant-kill share, SI-A) where recorded; tokens per maker run; regressed and scope-gate failure rate (safety); whether a verified diff touched an injected example's or KB page's subject (retrieval-use proxy); skill reuse via `skill_content_hash`.
- **Recorded:** `assignment_context` event and maker lease carry `ace_001` (arm, lane, `examples_source`, `kb_paths`, `fallback`); the skill outcome carries `ace-001-arm:<RS>`; `evolution-evidence.ace_001` shows per arm n, verified, Wilson 95 % CI, graded mean, mean tokens, and both main effects.

## Power and sample size (prod, last 30 days, read-only)

- Oracle-lane goals: 134 in 30 days ≈ **4.5 per day** (exports 50, mutation 42, test-gap 42). Verified among settled: 51 / 117 = **0.44**.
- Main effect (one factor's two halves pooled), α = 0.05 two-sided, power 0.80, p₀ = 0.44:
  - +20 points: 94 per half → **47 per arm**;
  - +15 points: 170 per half → 86 per arm.
- **Registered n: 50 per arm (200 goals)** → minimum detectable main effect ≈ 19–20 points (intent to treat; with 73 % vector coverage the per-protocol effect must be ≈ 27 points). At 4.5 goals/day: **≈ 45 days (6–7 weeks)**.
- The R × S interaction needs ~4× the n; it is **exploratory only** at this size.
- Graded scores exist for few production runs (8 in 30 days): secondary, descriptive.

## Analysis (at 50 per arm, once)

1. Main effects R and S: difference in verified rate (factor on − off), exact permutation test of arm labels stratified by lane and memory-holdout arm, two-sided.
2. Secondary model: logistic regression `verified ~ R + S + R:S + lane + holdout`.
3. Safety: regressed and scope-failure rate per arm; tokens per run per arm.

No interim efficacy looks. **Safety stop:** from 20 goals per arm on, an arm whose regressed rate exceeds control (00) by ≥ 20 points is stopped (flag off, reported).

## Decision rule

A factor is **promoted** (made the default context) only if all hold:

- its main effect is > 0 with permutation p < 0.05;
- regressed and scope-failure rates are not higher than control (upper 95 % bound of the difference ≤ 5 points);
- mean tokens per run rise ≤ 20 %;
- gates and security results unchanged.

**Falsified** (H rejected for that factor) if the effect's 95 % CI includes 0 at n = 50/arm. Promotion is an acting change → operator decision with the numbers.

## Not built in this experiment

- similarity retrieval of memory rules (no rule vectors);
- an independent, held-out task set: the population is live production goals, so the "independent evaluation set" is the production oracle itself, not a frozen benchmark. A frozen gym set is not used because gym success does not predict production (80.8 % vs 5.7 % for atomic, Cockpit 3.0 EVOLUTION_VALIDATION).
