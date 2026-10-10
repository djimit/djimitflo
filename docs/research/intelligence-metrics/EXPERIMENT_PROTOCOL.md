# Experiment protocol (§16.15, §16.16 steps 5–9)

Every experiment that may lead to a promotion is pre-registered in this form **before** its first outcome is read. A
registration is a markdown block committed to this file (or to a PR body linked here) and is immutable after the start date;
amendments are new versions with a reason. Baseline configuration: see `INTELLIGENCE_BASELINE.md` § Frozen baseline.

## Global rules

- **Evaluator isolation.** The candidate under test never writes, configures or selects its evaluator, the holdout, the risk
  limits, the endpoint or the promotion rule (§16.17). Changes to any of those are operator decisions, recorded separately and
  applied only between experiments.
- **Independent labels.** No endpoint may use a label produced by the tested component (checker-gated `verified` cannot evaluate
  the checker; gym pass cannot stand in for prod quality; jev cannot grade jev).
- **Randomisation.** Use the existing hash-of-goal-id mechanism (`assignSiblingArm`, X1) with a per-experiment salt. The arm is
  recorded as a `judgments` row **before** the maker starts.
- **Clustering.** Use CIs clustered by proposal. Repository is a single cluster today (n_repos = 1), so no repo-generalisation claim
  is allowed.
- **Multiplicity.** Primary endpoints of concurrently running experiments are corrected with Holm at family α = 0.05.
  Secondary endpoints are descriptive.
- **Sequential looks.** Fixed horizon by default; one interim futility look at 50 % of n. Monitored experiments use e-values
  (`genome_trial_results.e_value` already exists), with rejection at e ≥ 20.
- **Non-inferiority** for cost-saving changes: margin δ is pre-registered, and the change is accepted if the upper bound of
  (baseline − candidate) is < δ.
- **INSUFFICIENT_EVIDENCE** when n at the horizon is below the registered minimum. That result is never reported as "no effect".
- **Fresh holdouts.** A locked holdout epoch is retired after 3 decisions or 1 promotion, whichever comes first.

## Pre-registration template

```yaml
experiment_id:            # e.g. EXP-F2-cross-family-checker
version: 1
registered_at:            # ISO date, before first outcome
owner: operator           # approves start, stop and any amendment
hypothesis:               # H1 in one sentence; H0 stated explicitly
primary_endpoint:         # one metric_id from METRIC_CONTRACTS.yaml + exact formula
secondary_endpoints: []
unit_of_randomisation:    # goal | task | item
arms:                     # name → configuration diff vs the frozen baseline
assignment:               # sha256(goal_id + salt) mod 2, recorded as judgments row <name> before start
eligible_population:
exclusions:               # pre-declared; environment_failure handling stated
labels_source:            # who produces the outcome label; must be independent of the tested component
minimum_n:                # per arm, from the power calculation below
power_calculation:        # effect size, alpha, power, method
horizon:                  # date or n, whichever first
stopping_rules:           # futility / harm / budget (tokens, kWh)
analysis:                 # estimator + uncertainty method + clustering
decision_rule:            # promote / retain baseline / inconclusive
rollback:                 # exact flag or config to restore
known_confounders:
evaluator_isolation_check: # how the candidate is prevented from touching evaluator/holdout/rule
```

## Registered and next experiments

### EXP-1 — F2: cross-family checker (after F1)

- **Why.** F1 showed the checker discriminates (AUC 0.875, n = 40). It still accepted 3/7 kind-B defects, where matchers were
  replaced by `toBeDefined`. F2 asks whether a checker from a different model family catches more defects, and whether its errors
  are less correlated with the maker's.
- **Arms.** A: the current checker (opencode, same family as the maker). B: a checker from a different provider family (an alias
  through the existing LiteLLM proxy; no new framework).
- **Stage 1, offline (cheap, has ground truth).** The F1 harness with the 20 F1 pairs plus 16 new kind-B pairs → 36 defective +
  36 good, each item through both arms (paired). Primary endpoint: accept rate on defective items. **Power:** 0.15 vs 0.45 needs
  36 per arm (α 0.05, 80 %), so 36 defective items is just enough. McNemar on discordant defective items. Cost ≈ 72 × 2 calls ×
  36 k tokens ≈ 5.2 M tokens; abort at 15 M (F1 rule).
- **Stage 2, online (only if stage 1 shows a difference).** X1-style hash randomisation of the checker family on oracle-lane goals.
  Primary endpoint: Cohen's kappa of checker verdict vs merge-survival outcome per arm. Δkappa CI must exclude 0. Needs ≥ 93
  settled per arm for a 20-pt verified-rate effect; at ~12 oracle goals/day under the caps that is ~16 days for both arms.
  Kappa needs survival labels, which first settle around 19-10.
- **Falsifier.** Stage 1: arm B accepts defective ≥ arm A, or the McNemar p ≥ 0.05 → retain the single-family checker.
- **Decision 10-10 (operator).** Stage 2 built as `CHECKER_FAMILY_RANDOMISE` (#734, default off, arm B `ollama/kimi-k3:cloud`) to this registration: ≥ 93/arm, primary = a checker-independent label (merge survival once settled, else the other failed gates), attributed-outcome kappa secondary and marked circular.
- **Isolation.** The checker prompt, harness and defect generator are frozen at the F1 commit; the arm only swaps the model alias.

### EXP-2 — X1 evolve-sibling arm (running, operator-approved 08-10)

- **State.** `EFFORT_SIBLING_RANDOMISE=true` since 09-10 00:3x local. Interim: on 0/3 verified vs off 8/11, Fisher p 0.055,
  n = 15 goals. This is **not** a stopping look. The registration (4 weeks, ~94/arm) stands.
- **Power at the registered n.** 94/arm detects 0.6 vs 0.4 with power 0.79. It detects a 10-pt effect (0.55 vs 0.45) with power
  only 0.28. A small sibling benefit will therefore read as inconclusive, not as "no effect".
- **Secondary.** Tokens per verified outcome per arm (the cost side of CIA).
- **Decision.** If siblings do not beat no-siblings on verified rate, or are non-inferior at higher cost, the effort controller
  gets "no sibling" as default (operator).

### EXP-3 — F3 memory holdout (continuation)

- **State.** `MEMORY_HOLDOUT_RATE=0.3` since 10-08. Evidence builder: rules 29/42 (0.69) vs withheld 4/6 (0.67), Fisher p = 1.
  The F3 refit gave 0 rules with raw fitness > 0.
- **Primary endpoint.** Attribution-adjusted verified rate (maker_failure counts as failure; reviewer and environment excluded),
  rules vs withheld, Cochran–Mantel–Haenszel stratified by lane.
- **Power.** A 15-pt effect (0.70 vs 0.55) at a 0.3 holdout needs 267 + 115 settled runs. At 112 + 48 the power is only 0.45.
  Option (operator): raise the holdout to 0.5 for this experiment, which needs ~160/arm (~320 settled, ≈ 4–5 weeks at the current
  oracle-lane rate).
- **Falsifier.** The rules arm is ≤ the withheld arm at the horizon → stop injecting rules (retain the simpler baseline).
- **Harm stop.** The withheld arm is better with a one-sided p < 0.01 at the interim → stop early and withhold.

### EXP-4 — Graded genome trials (SI-C, #709/#712)

- **Preconditions (all must hold before start).** `gym_write_test_holdout` epoch with ≥ 5 frozen tasks (today 0 rows); real
  `graded:` scores, not binary fallback, on ≥ 20 trial pairs; `DREAM_EVOLUTION_ENABLED=true` (today false by the 09-10
  reallocation, so this is an operator decision).
- **Primary endpoint.** Paired graded mean difference (mutant − parent) on the frozen epoch; promote if the exact sign-flip
  p < 0.05, the mean difference is ≥ 0.05 and the mined net loss is ≤ 1 (the rule as coded).
- **Power.** The simulation in #709 (20 pairs, 0.75 vs 0.85, 5–10 mutants/task) gave 0.50–0.84. write_test has 3 seeded mutants,
  so real power is lower. Register 40 pairs, or report INSUFFICIENT_EVIDENCE.
- **Guard.** Epoch 0 has already been used by 8 trials. EXP-4 must start on a fresh epoch, and retires it after 3 decisions.

### EXP-5 — Weak-assertion check: shadow → enforce

- **Why.** F1 kind B: the checker accepted 3/7 `toBeDefined` weakenings. A deterministic check (truthy-only matchers, assertion
  count per test) needs no LLM. Builder: `feat/gym-diff-weak-assert`, `WEAK_ASSERTION_CHECK_MODE=shadow`.
- **Stage 1, offline.** Ground truth = the F1 items plus generated weakenings. Endpoint: sensitivity on defective items and
  false-positive rate on merged good tests. **Power:** telling the checker's kind-B miss rate (0.43) apart from a target miss rate of
  0.10 for the check needs 27 per group. Register ≥ 30 defective + ≥ 40 good.
- **Stage 2, prod shadow (2 weeks).** Flag rate on test-lane makers. Concordance: flagged tests should have a lower graded
  kill-share than unflagged ones (Mann–Whitney).
- **Enforce criterion (operator).** Sensitivity ≥ 0.8 and an FP upper 95 % bound ≤ 0.15 on n ≥ 40 good items. Enforce changes a
  gate, so it is an evaluator change: applied by the operator between experiments, never by a candidate.

### EXP-6 — First full knowledge trace (KE milestone 1, operator-approved 09-10)

- **Nature.** A **feasibility trace, n = 1**, not an effect test. No power claim.
- **Endpoint.** A complete provenance chain reconstructable from the database alone: discovery event → unit (with abstract) →
  technique-card claim → trial genome with `knowledge_refs_json` → trial result → genome status → outcome event. Every id is
  recorded in the write-up.
- **Expected result.** Most likely "inconclusive" at the trial step, because of holdout headroom and power. That still passes the
  feasibility endpoint if the chain is complete.
- **Preconditions.** #727 merged and deployed. Backfill run. DREAM on for exactly one cycle (backup + idle recreate), then off.

## Not yet registrable

| Question (§16.16) | Missing for a registration |
| --- | --- |
| Swarm vs single strong agent | no single-agent arm without a checker in prod; F1 shows the checker adds discrimination, so a no-checker arm needs an operator risk decision (offline only) |
| Active learning information gain | effort controller is shadow only; VOI is not logged per decision; needs an `effort_decision` acting arm |
| Routing vs fixed best model | OPE exists (SNIPS Δ −0.010, ESS 127); a fixed-model arm needs the bandit to be overridable per goal hash |
| Gains on new tasks | a second repository in the gym and in the prod lanes |
| Autonomy vs reference | approval → outcome link not stored |
