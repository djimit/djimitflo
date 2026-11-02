# ASG-001 v1: pre-registration — Adaptive Skill Granularity for the oracle-lane maker

**Status:** frozen. This file is committed on its own, before any harness, fixture or measurement code exists on this
branch. Its sha256 is recorded in the next commit (`PREREG.sha256`). Any later change is a protocol deviation and is
listed in `RESULTS.md` §Deviations with a reason; it never silently redefines a result.

**Operator directive:** ASG-001 (2026-10-24). Sources: arXiv:2610.31461v1 (Zhang, Jiang, Wang, Zhou, 22 Oct 2026) and
`github.com/Jayceon-3/Adaptive-Skill-Agent` @ `1ab0dc346514c76bff7cab7a31e510ee67031397` (read, never executed; no
licence file, so no code is copied).

## 0. What is already known (not a blind protocol)

- The paper's pilot is 12 mixed tasks (Table 2/4) plus 7 fault-injected tasks (Table 3/5), one repetition, on 9 toy
  Python fixtures. It reports no confidence intervals although it promises them.
- Its learned router is trained on the *same* tasks it is evaluated on: `models/router_model_summary.json` in the
  repository shows 21 samples for the mode router and 23 for the recovery router, leave-one-out accuracy 1.0 and
  **0.39** respectively. "Emp. Match 1.000" (Table 4) is therefore an in-sample figure, and the recovery router is
  at or below chance out of sample. We do not treat the learned-routing result (arms D/F of the paper) as evidence.
- The paper's robust finding is mechanistic and plausible: unconditional macro→micro downgrade wastes cost when the
  macro already completed its work before failing ("late fault", Table 3). That motivates our arm E
  (verify-before-recovery). Upstream classifies every macro failure as recoverable; we do not.
- Djimitflo prior evidence (`docs/research/di-001/MAKER_FAILURES.md`): 30–33 % of opencode maker tokens are spent on
  environment bootstrap; repeated verification (re-running targeted tests) and Stryker inside the maker loop are the
  remaining tool-loop cost. Dependency bootstrap is already the randomised experiment MAKER-DEPS-001; ASG-001 does
  **not** touch it (no bootstrap macro).

## 1. Hypotheses

- **H1 (no fixed granularity dominates).** On the fixture set, micro-only (B) has a higher verified success rate than
  macro-only (C) on contract-mismatch tasks, and macro-only has a lower cost per verified task than micro-only on
  contract-match tasks.
- **H2 (routing).** Deterministic routing without recovery (D) is non-inferior to micro-only (B) on verified success
  and has a lower cost per verified task.
- **H3 (verify-before-recovery).** Routing + verify-before-recovery (E) recovers recoverable injected macro failures
  that D leaves unresolved, and on "failure after correct completion" faults E does **not** enter micro recovery
  (its postcondition check passes first), so E's cost on those tasks is within 10 % of D's.
- **H4 (safety invariants).** Across all arms and all injected faults there are zero: writes outside the declared
  effect set, micro detours after a policy refusal, repeated non-idempotent actions without reconciliation,
  permission widening by skill content, concurrent recoveries on one workspace, and budget overruns of the shared
  total budget. A single violation is decisive (REJECT for the implementation, regardless of H1–H3).
- **H5 (macro generalisation, separate evidence).** Macros whose procedures were derived from traces of the
  dev/train families apply (contract match) and succeed on unseen test families at a rate no more than 10 pp below
  their train-family rate. Routing decisions, retries and recoveries never count as cumulative evolution: only an
  admitted macro version that passes heldout validation counts as an evolution step. H5 is reported on its own and
  never pooled into H1–H3.

## 2. Arms

All arms use the same runtime, tools, permissions, fixtures, verifier and total budget. They differ only in the
admissible action set and recovery policy.

| arm | name | admissible actions | recovery |
|---|---|---|---|
| A | current | today's maker path, unchanged (`ASG_MODE=off`) | none beyond today's |
| B | micro-only | single allowed tools only | n/a |
| C | macro-only | the matched admitted macro only; no micro | none |
| D | routed, no recovery | MICRO / MACRO / HYBRID by the deterministic policy | none: macro failure is terminal |
| E | routed + verify-before-recovery | as D | on macro failure: verify postconditions first; recover with micro only if they fail and the failure is recoverable |
| F | learned routing | as E with a learned router | **only** if §6 justifies it; not expected in v1 |

## 3. Units, splits, order

- **Unit:** a task = (fixture, prompt, verifier). A task family = one fixture and its variants.
- **Split by family:** dev/train/test is assigned per family, never per task, so every variant of one fixture lands
  in one split. Assignment: `sha256('asg-001:' + family_id)` first 8 hex digits mod 10: 0–1 dev, 2–5 train,
  6–9 test. The salt is distinct from ACE-001, STE-001, X1, F2 and MAKER-DEPS-001.
- **Paired:** every task runs in every arm, each in its own fresh workspace copied from the pristine fixture.
- **Order:** randomised per repetition with a seeded shuffle (`seed = 20261024 + repetition`), recorded in the run
  manifest.
- **Repetitions:** repetitions of one task are not independent. Primary analyses use repetition 1 only;
  further repetitions are reported as within-task variance.
- **Decision-time features only:** the router sees the task prompt, the declared target paths, the fixture's
  initial workspace (file existence, sizes, digests of declared targets) and the macro contracts. It never sees
  the verifier's hidden tests, the outcome of the current run, other arms' results or post-hoc labels. The feature
  schema is fixed in code and its hash is recorded with every decision.

## 4. Endpoints

**Primary endpoint: cost per fully verified solved task.**
- *Numerator:* the total cost of **every** attempt of the arm on the analysed tasks, including failed, stopped,
  budget-exhausted and recovered attempts.
- *Denominator:* the number of tasks whose final workspace passes the independent verifier (run by the harness on
  the final workspace, never the agent's claim) **and** has no effect outside the declared effect set.
- *Zero successes:* the endpoint is **undefined (+∞)**, never 0. A bootstrap draw with zero successes contributes
  +∞ to the percentile CI.
- *Cost unit:* provider-reported tokens (input + output + cache read, as recorded in `runtime_usage.total_tokens`)
  for model-backed runs. In the mechanism pilot, deterministic scripted cost units per action (fixed table in the
  harness, hashed into the manifest). Pilot costs are never compared with model-backed costs.

**Primary comparison:** E vs A.
- **Non-inferiority margin for verified success: −5 percentage points (absolute)**, one-sided α = 0.025.
  Motivation: the prod verified rate after #716 is about 0.79 (MAKER-DEPS-001 §4). A 5 pp loss is about 6 % fewer
  verified goals relative to that base. We accept that only together with a ≥ 20 % cost saving per verified task,
  i.e. the efficiency gain must exceed the relative output loss by more than 3×. A larger margin would let a
  granularity mechanism trade away verified work for cost, which the operator has not authorised.
- **Minimal relevant cost saving: 20 %** reduction of cost per verified task, judged on the upper bound of the 95 %
  cluster-bootstrap CI of the ratio E/A (must be < 0.80 for "relevant"). Motivation: environment bootstrap alone is
  30 % of maker tokens (MAKER_FAILURES §3); a granularity mechanism that saves less than 20 % does not pay for a new
  execution mode's maintenance, review and risk surface, and is inside the day-to-day token-mix variation.
- **ADOPT** requires both: success non-inferior and cost ratio CI upper bound < 0.80, plus H4 with zero violations.
- **REJECT:** any H4 violation, or success inferior (CI lower bound below −5 pp and point estimate below 0), or cost
  ratio CI lower bound > 1.0.
- **REVISE:** H4 clean, success non-inferior, cost saving not relevant, or mechanism defects found in the pilot that a
  revision can fix.
- **INCONCLUSIVE:** insufficient evidence for any of the above — in particular every mechanism-pilot-only outcome.

**Secondary (process) endpoints, each with n:** macro adoption rate; route distribution; route-reason codes;
recovery trigger rate; recovery success rate (credited only when the recovered micro trajectory produces a verified
final state); transition count per run; budget-exhausted rate; incidents (success with a recorded exception);
H4 invariant violations by kind.

## 5. Statistics

- **Paired binary (success):** exact McNemar (two-sided binomial test on discordant pairs) for every pairwise
  comparison of interest (E–A, D–B, C–B, E–D), on repetition 1. For NI the 95 % CI of the paired difference is the
  Newcombe hybrid-score interval for paired proportions; sensitivity: cluster bootstrap by family.
- **Cost per verified task:** ratio of sums, CI by **cluster bootstrap resampling task families** with replacement,
  10 000 draws, seed 20261024; percentile CI; draws with zero successes yield +∞.
- **Faults:** natural failures and injected faults are reported separately and never pooled into the primary.
  Injected fault kinds: precondition mismatch, partial change, failure after correct completion, invalid tool
  schema, timeout with uncertain outcome, crash, duplicate delivery, concurrent execution.
- **Multiplicity:** only E–A is confirmatory. Everything else is descriptive.

## 6. Learned routing (arm F)

F is run only if the train split has ≥ 200 tasks with recorded per-route outcomes **and** the deterministic policy's
route disagrees with the empirically best route on ≥ 15 % of train tasks. Otherwise F is not run and that is
reported. A learned router, if ever trained, is trained on train only, tuned on dev only, evaluated once on test.

## 7. What may run without authorisation

- **Mechanism pilot (authorised):** deterministic fixtures with scripted/mock agents and no paid model call. It
  validates the state machine, routing, recovery, injected faults and invariants. It is reported as a **mechanism
  pilot, not an effect estimate**, and its decision is INCONCLUSIVE by construction for H1–H3 and H5.
- **Model-backed run (not authorised):** the exact command, budget and sample size are written in `RESULTS.md`.
  It needs a separate operator authorisation (Ollama Cloud credits or the workstation GPU).

## 8. Sample size for the model-backed run

- Paired NI on success with margin δ = 0.05, one-sided α = 0.025, power 0.80, expected true difference 0, expected
  discordant-pair rate p_d = 0.10 (assumed; paper Table 2 implies at least 2 of 12 discordant tasks between its two
  macro-using arms, 0.17, on toy fixtures where most tasks succeed in both arms):
  n ≈ (z₀.₉₇₅ + z₀.₈₀)² · p_d / δ² = 7.85 · 0.10 / 0.0025 ≈ **314 paired test tasks**.
- With p_d = 0.05, n ≈ 157; with p_d = 0.20, n ≈ 628. The run is analysed at the pre-specified n only; there is no
  efficacy early stop. Harm stop: any H4 violation stops the run.

## 9. Lifecycle and promotion

A macro passes candidate → replay_validated → heldout_validated → shadow → eligible → active → deprecated. No state
after `candidate` is reachable without the evidence record of the previous gate (replay on train, heldout on test,
shadow run count). Nothing in code reads this experiment's result to promote anything automatically.
