# PL-001 — a task-fit procedure for the gym repair maker (pre-registration)

Status: **pre-registered, frozen before any code that can produce an outcome** (2026-10-25). This document is the first
commit of the PR that adds the procedure registry and the shadow selector (`PROCEDURE_SELECTOR_MODE`, branch
`feat/procedure-selector-pl001`). Not started. The experiment runner is **not** built in that PR. Starting PL-001 is an
operator decision.

## Why this exists, and what it is not

- Gap matrix 2026-10-25 (`~/.djimit/procedure-loop-gap-matrix-20261025.md`): a validated procedure reaches a gym maker only
  inside a genome trial, and a trial genome is picked by trial order, never by how well it fits the task. Reuse on a fitting
  task and rejection on an unfit task are both missing.
- The selector PR only **decides and records** (a `procedure_selection` judgment, mode `shadow`, per ordinary remote gym
  claim). It delivers nothing: in shadow the claim payload is byte-identical to off. Epoch-1 trials and every running
  experiment see no change.
- PL-001 is the comparison that decides whether the procedure's lines are worth delivering at all. No `on` mode exists before
  PL-001 has a verdict, and an `on` mode is a separate operator decision even after a positive one.
- The procedure adapts the **idea** of two MIT-licensed ECC agents (`agents/build-error-resolver.md` and
  `agents/tdd-guide.md`, ECC HEAD `e49479937753c8aca5a09aa76dbe2eea1b68f187`): reproduce the failure first, read the exact
  error, make the smallest change, rerun the named test. The lines below are DjimitFlo's own words. No ECC text is copied
  and ECC is never installed.

**Hypothesis H-PL1:** for atomic@llama-router on gym repair tasks the procedure applies to, adding the procedure's lines to
the gym goal raises the share of tasks with a gated verified success.

## The treatment (frozen)

Procedure `ts-build-error-repair-v1`, version 1, stored as a `maker_genomes` row (gene `procedure`, origin `procedure`,
status `candidate` — never `trial`, never `active`). Its five lines, verbatim, in this order:

1. `Before touching any file, run the named failing test once and keep its exact error output.`
2. `Read the first error in full: the file, the line, the expected value and the actual value.`
3. `Make the smallest local edit in the source file that explains that error, and leave every unrelated line as it was.`
4. `Prefer a null guard, an import fix or a corrected condition over new logic, a rename or a refactor.`
5. `After each edit, run the same named test again; stop editing as soon as it is green.`

- Content digest: `lines_sha256 = sha256(lines.join('\n'))` =
  `6dddbba133cdca3774927f6c634e256a2b1d53d65b127dd3b2637511be95f068`. Any other digest is a different treatment and is not
  PL-001.
- Every line passes the dream-evolution genome line guard (`guardLines`: at most 5 lines, at most 200 characters, none of
  the forbidden words).
- Applicability contract v1 (the selector applies it deterministically; the first failing clause is the reason):
  - task kinds: `repair` (a task without a kind is a repair; any other kind is unknown and does not apply);
  - lanes: `gym-repair` (the lane of a repair task; a write_test task carries its own lane);
  - file patterns (the file the maker changes, `task.source`): `packages/server/src/services/**/*.ts`;
  - required worker capabilities: `prod_gates`;
  - exclusions, which win over a file pattern: `**/__tests__/**`, `**/*.test.ts`, `**/*.d.ts`, `**/*.generated.ts`.

## Arms

| Arm | Species | Gym goal |
|---|---|---|
| A — baseline | atomic@llama-router | today's gym goal, no extra lines |
| B — candidate | atomic@llama-router | today's gym goal plus the five lines, delivered the way genome strategy lines are delivered today |

Both arms share the runtime, the model, `--max-steps 40`, `GYM_MAKER_TIMEOUT_MS`, the oracle, the mutant kills and the
production gates (`GYM_PROD_GATES`, worker capability `prod_gates`). The budget is the same per attempt.

- **Fire check, both arms.** B's attempt counts only when the worker's `fire_check` shows 5 of 5 lines in the maker prompt;
  otherwise it is VOID and served again. A's attempt records its `goal_sha256` and must show 0 procedure lines.
- **Order.** Per task, the arm that runs first is fixed at freeze time: A first when the first byte of
  `sha256('pl-001:' + task_key)` is even, else B first.

## Population

- A **new** frozen task set: never an epoch-0 or epoch-1 holdout task and never a holdout key of any table
  (`gym_holdout`, `gym_mutant_holdout`, `gym_write_test_holdout`, any epoch), never a TG-001 task (`tg_attempts`), never a
  trial-attempted or dream-exposed key (`holdoutExclusions`), and never a key with an earlier `evolution-gym` attempt.
- Every task must be one the procedure applies to under contract v1 (selector decision `applies`) — in practice TypeScript
  repair tasks on `packages/server/src/services`: seeded mutant repairs at tiers 3–6, plus mined repairs when available.
- Manifest: 75 tasks (60 pairs plus a margin for censoring), ordered by `sha256('pl-001:' + task_key)`, served in that
  order. The manifest (task keys, base commits, mutants, contract, lines and their digest) and its sha256 are frozen before
  the first attempt; the freeze is the operator's.
- **Pre-start selector check:** a seeded set of at least 10 unfit tasks (a write_test task, a test file, a JS file, an
  excluded path, a worker without `prod_gates`, an unknown kind) must all get `does_not_apply`. One `applies` stops the start.

## Isolation

- Own loop name: `loop_runs.loop_name = 'pl-001'`, never `'evolution-gym'`. Every gym statistic, the species breaker, IRT,
  the hack rate, the graded pool, trial deciding sets and the bandit select `loop_name = 'evolution-gym'` and so never count
  a PL-001 attempt (the TG-001 provenance pattern).
- No `skill_outcomes` row for a PL-001 attempt. No `maker_genomes` row with status `trial`. No line reaches a production
  maker (skill cards stay record-only, `GENOME_APPLY_MODE` stays shadow).
- ACE-001, STE-001, MAKER-DEPS-001, F2 v2 and the memory holdout run on production makers; PL-001 is gym-only.

## Outcomes

A **gated verified success** is an attempt with `gym_result.status = 'success'`, claimed with the production gates and
carrying the per-check `gym_result.prod_gates` map (`ELIGIBLE_GATED`), not VOID and not quarantined.

- **Primary:** the share of assigned tasks with a gated verified success, per arm, paired by task. Intention to treat: a
  censored arm counts as not verified.
- **Secondary** (descriptive; no multiplicity correction, no claims):
  - graded score (`tests_green` share or binary), mean paired difference;
  - tokens where known, with coverage per arm; an unknown count is kept separate and never treated as 0;
  - maker wall time, median paired difference;
  - infra rate per arm (infra discards per physical attempt, and censored arms).
- **Sensitivity:** the primary test on the pairs with no censored arm.

## Missing data and infra

As TG-001: an infra discard (`infra:` reason, discarded, lost or orphaned run) or a VOID attempt re-serves the arm, at most
2 retries (3 physical attempts). The first non-infra, non-VOID result is the observation. If all 3 are infra or VOID the arm
is **INFRA_CENSORED**: in the primary analysis it is not verified; in the sensitivity analysis the pair is dropped. Every
physical attempt is kept.

## Analysis

- Pairs: b = tasks where B is verified and A is not; c = tasks where A is verified and B is not.
- Test: exact one-sided McNemar, p = P(X ≥ b), X ~ Bin(b + c, ½) (`mcnemarOneSided`). H-PL1 is supported iff b > c and
  p < 0.05. No other test decides.
- Verdicts: `SUPPORTED`; `NOT_SUPPORTED` (60 pairs, not significant); `INCONCLUSIVE` (day 14 before 60 pairs; the analysis is
  still reported on the pairs completed); `STOPPED_FOR_HARM`.

## Sample size and power

- n = 60 completed pairs (a pair is complete when both arms have an observation or are censored).
- Baseline gated pass rate 0.37–0.46 (plan: 34/91 gated since 10-08, 18/39 on the epoch-1 mutants).
- Power ≈ 0.84 at +20 pt (gap matrix, discordance ≈ 0.33). An exact recomputation over the paired trinomial (one-sided,
  α 0.05) gives 0.86 at discordance 0.32, 0.80 at 0.36 and 0.76 at 0.40. At +15 pt the power is about 0.55 (discordance
  0.36), and about 95 pairs would be needed for 0.76. PL-001 is powered for an effect near +20 pt, not for +15 pt.
- Volume: about 135 claims including about 12 % infra — about 7 days at 20 claims a day with the whole gym cap, about 3.5 days
  at 40.

## Stop rule

- Stop at 60 completed pairs or at day 14 after the first attempt, whichever comes first.
- Early stop **for harm only**, checked after every completed pair: the e-value for "baseline beats candidate" over the
  discordant pairs (`ePaired`, baseline wins coded +1) reaches 20; or any canary is solved; or arm B has 3 or more
  out-of-scope or hack-flagged results more than arm A. Never an early stop for success.

## Start condition

PL-001 does not start until both current trial genomes (`g-a187f81f`, `g-d14c1156`) have settled (status no longer
`trial`), unless the operator explicitly grants PL-001 a share of the gym cap. Trials keep claim priority. Starting it —
building the runner, freezing the manifest, setting its flag in `runtime.env` with a backup, and the WIP slot and GPU
budget — is the operator's decision.

## Rollback

The runner's flag goes off. Claims then match the pre-PL-001 claims byte for byte (the same test pattern as the selector's
off/shadow test).

## Amendments

Amendments are appended below the fingerprint line, dated, with a reason. They never change the text above it.

---
PREREG_SHA256: fa136ae5946574f749bce23a190acc7632e5a6135f4d4577e311e9ea0dfb616c (sha256 of everything above this line; computed 2026-10-25 before any selector or runner code existed)
