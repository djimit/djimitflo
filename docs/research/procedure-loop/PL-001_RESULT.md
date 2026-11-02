# PL-001 result: a task-fit procedure for the gym repair maker

**Verdict: NOT_SUPPORTED.** With the five procedure lines, atomic@llama-router verified fewer of the 60 paired repair tasks
than without them: 24 against 28. The discordant pairs split 1 for the procedure and 5 against it. The frozen test is the
exact one-sided McNemar test for "B better than A", and it gives p = 63/64 ≈ 0.98. H-PL1 needed b > c and p < 0.05, and
neither holds. Negative-evidence entry **NE-016** is added in the same PR.

- **Protocol:** `PL-001_PROTOCOL.md`, `PREREG_SHA256 fa136ae5946574f749bce23a190acc7632e5a6135f4d4577e311e9ea0dfb616c`. The
  hash covers the text above the fingerprint line and still matches it. The protocol was frozen before any selector or
  runner code existed. The runner amendment of 2026-10-26 came before any attempt.
- **Manifest:** frozen 2026-10-27T00:14:54Z at the first claim from a capable worker (amendment 6), sha256 `1621c055…`.
- **Treatment:** procedure `ts-build-error-repair-v1`, version 1, `lines_sha256 6dddbba1…` (5 lines).
- **Species and oracle:** atomic@llama-router, gated by the production gym oracle (`prod_gates`). Both arms used the same
  runtime, step limit, timeout and gates.
- **Lifecycle:** the system set the procedure genome to status `retired` at 2026-10-30T23:13:16Z (amendment 9). The procedure
  was never `trial` or `active`, and no line reached a production maker.
- **Measurement:** read-only production queries on 2026-11-01. This document reports aggregates only.

## Primary outcome (intention to treat, 60 pairs)

Arm A is the gym goal without the procedure lines. Arm B is the same goal with the five procedure lines.

| | B verified | B not verified | total |
|---|---|---|---|
| **A verified** | 23 | 5 (c) | 28 |
| **A not verified** | 1 (b) | 31 | 32 |
| **total** | 24 | 36 | 60 |

- Gated verified success: A 28 / 60 (46.7 %), B 24 / 60 (40.0 %). The paired difference B − A is −4 / 60 ≈ −6.7 points.
- Discordant pairs: b + c = 6, with b = 1.
- Exact one-sided McNemar: p = P(X ≥ 1) for X ~ Bin(6, ½), which is 1 − 1/64 = 63/64 ≈ 0.984.
- Decision rule (Analysis section): SUPPORTED iff b > c and p < 0.05. Here b < c, so the result is **NOT_SUPPORTED**
  (60 pairs, not significant). The run stopped at the 60-pair limit, not at a day-14 limit or a harm stop.

**Sensitivity.** The registered sensitivity analysis repeats the test on the pairs with no censored arm. Dropping pairs can
only lower b and c, so b ≤ 1. Then p ≥ 1/2 for any c, and the sensitivity analysis cannot reach p < 0.05 either.

## Attempt accounting

The manifest has 75 tasks, which gives 150 arm slots.

| | arm slots |
|---|---|
| counted in the 60 pairs | 120 |
| INVALID (`task:` discard, amendment 5: task excluded for both arms) | 10 |
| never served (60 pairs were already reached) | 20 |
| **total** | **150** |

The 15-task margin covered the task discards, as the protocol planned.

## What this shows

- For this species, this task population and this procedure, appending the five static lines to the gym goal did not raise
  the gated verified rate. The point estimate points the other way, 5 losses against 1 win.
- The lifecycle rule worked as pre-registered. The runner computed the verdict and retired the procedure without operator
  action. Nothing was promoted.
- The fire check means arm B saw all five lines and arm A saw none (VOID otherwise). The null result is therefore not a
  delivery failure.

## What this does not show

- **It is not evidence that procedures never help.** n = 60 pairs, one species (atomic@llama-router), one procedure
  (`ts-build-error-repair-v1`) and one task population (TypeScript repairs in `packages/server/src/services`). The protocol
  was powered for an effect near +20 points (power ≈ 0.84), not for small effects.
- It does not show that the procedure harms. With only 6 discordant pairs, 5 against 1 is weak evidence of a negative
  effect, and the protocol makes no claim about it.
- It says nothing about other delivery forms, such as a procedure chosen per task by the selector at an operator-set `on`
  mode, or lines delivered in another position, or about other maker species, models or task kinds.
- The secondary measures (graded score, tokens, wall time, infra rate) are descriptive under the protocol and are not part of
  this record.

## Consequences

- `ts-build-error-repair-v1` stays `retired`. The procedure selector stays in shadow. No `on` mode is built on the strength
  of PL-001.
- A new attempt needs its own pre-registration: a different or revised procedure, a fresh task set disjoint from the PL-001
  manifest, and its own frozen decision rule. See NE-016's `reopen_condition`.
