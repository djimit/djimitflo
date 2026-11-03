# EVOLUTION-001 · 7 · Maturity roadmap with decision gates

Conventions and source keys: file 1.

**Rules for every stage.**
- A stage is reached only by evidence of the stated kind. Code presence, run counts and self-reports never count.
- Invariants never move: gates, oracles, auth, deploy and secrets never evolve; no candidate changes its own evaluator;
  human merge on external repos; jev never decides fitness; acting modes and spend are the operator's (PLAN G).

## Overview

| Stage | Name | What must be true | Status 22-10 | Tag |
|---|---|---|---|---|
| 1 | Individual adaptation | a within-episode mechanism (retry, effort, feedback) improves the *same* task's outcome on an independent endpoint, controlled | **PARTIAL**: offline descriptive only (MFR-RA +0.317, unregistered); feedback form falsified (NE-013); nothing in prod | FACT |
| 2 | Inheritance | a lesson stored from earlier episodes improves *later, different* tasks, controlled, on tasks not used to make the lesson | **MISSING at L4**: memory rules L2 (0.802 vs 0.903); skill cards never validated; genomes have no prod path | FACT |
| 3 | Population | selection among variants shifts the population and raises mean fitness vs a frozen control | **PARTIAL (L1)**: bandit acts with no measured effect; 0 genome promotions ever; 16 settled trials, all no headroom or blind | FACT |
| 4 | Cumulative innovation | improvements stack across generations (a ratchet), each step validated on fresh held-out sets and retained | **MISSING** | FACT |
| 5 | Open-ended | new niches (task types, repos) with executed verifiers appear and get solved, and selected variants transfer across niches | **MISSING**: 1 task type, 1 repo; GTI UNDEFINED (EE `intelligence`) | FACT |

## Stage 1: individual adaptation

**Exit gate (all required).**
1. A pre-registered offline study is SUPPORTED on a held-out endpoint **and** a cross-family endpoint (E1 Stage B:
   R1 − R0 ≥ +0.15, CI lower > 0, Stryker CI lower > 0, baseline-red ≤ 0.05).
2. A prod shadow run of the same mechanism on ≥ 40 runs, at WIP ≤ 4, shows the same direction on graded and no rise in
   regressions, scope failures or tokens per verified beyond 20 %.

**Evidence that does not count.** Higher verified rate alone (verified does not track graded: 0.300 vs 0.286). Shown-item
kill (NE-013).

**Autonomy granted at exit.** The mechanism may run in shadow, then on a 50 % hash arm (operator flag). Nothing else changes.

**Earliest date (INFERENCE).** E1 Stage A within days. Stage B accrual ≈ 30 days → late November.

## Stage 2: inheritance

**Exit gate.**
1. One carrier has **Y on all six heredity links** (file 5): O → E → V → I → A → X.
2. X is a randomised receivers-vs-withheld comparison on tasks that did not produce the lesson.
3. The primary endpoint is attributable (maker_failure only), graded where available, with CI > 0.
4. The effect is still present 30 days later (no decay to 0), with no gate change.

**Candidate carriers, in order of readiness (INFERENCE).**
1. **A strengthened-test template gene**, if E1 holds. It would be tested as a template arm like STE-001 (randomised,
   prod). This is the stage 1 → 2 bridge: the lesson "strengthen before finishing" is stored once and applied to new
   goals.
2. Memory rules, only if the 27-10 readout reverses its current sign.
3. A promoted genome. That needs Stage 3's trial first, plus the missing injection step.

**Autonomy granted at exit.** That carrier may grow automatically under a permanent 10 % holdout (G3.2). Other carriers stay frozen
until they pass the same gate (G3.3).

## Stage 3: population

**Exit gate.**
1. ≥ 1 genome promoted by a **powered** trial: ≥ 40 deciding tasks, parent pass rate in Gate A's band [0.30, 0.55], served
   model and worker identical per pair (E0 repairs).
2. The promoted genome then reaches prod makers in shadow (`GENOME_APPLY_MODE=shadow`) and then on ≤ 10 % traffic, with
   the Y3d auto-retire rule: below the parent over 20 real outcomes → retired. It must hold its parent-relative gain on
   real outcomes.
3. Species selection has a measured effect: either a small uniform-random control arm or OPE with CI lower ≥ 0 at ESS ≥ 60
   (H13 rule, EE `ope`). Today OPE is +0.0018 [−0.0112, 0.0144].

**Evidence that does not count.** Gym pass rate without prod gates (mined proxy 0.867 vs 0.311). A promotion on epoch 0
(exposed: 261 / 140 evaluations).

**Autonomy granted at exit.** ≤ 1 promotion a day (existing), prod traffic capped at 10 % per genome, auto-retire on.

**Earliest date (INFERENCE).** The E0 readout ≈ 28–29-10 can at best deliver gate item 1, and only if the tier repair happens
first.

## Stage 4: cumulative innovation

**Exit gate.**
1. A lineage with ≥ 2 successive promotions (parent → child → grandchild), each significant on a fresh epoch.
2. The grandchild beats the grandparent on a third fresh epoch. That shows the gains stack and do not merely trade.
3. Real-outcome retention in prod for each generation.
4. A north-star numerator ≥ 1 (DECISION §6): a distinct capability gain that is new, retained and independently verified.

**Prerequisites that do not exist yet.**
- Enough fresh holdout supply for ≥ 3 epochs. Epoch 1 has 40 + 40 + 5. Each epoch is consumable (reuse limit 10).
- A lineage store: `parent_id` exists. HGM-style clade metaproductivity is PLAN D4, not built.

**Autonomy granted at exit.** Dream frequency may follow yield, within budgets. The operator still owns new task types and repos.

## Stage 5: open-ended

**Exit gate.**
1. A new niche (task type × repo) with an executed verifier reaches L3: ≥ 10 verified retained outcomes, oracle validated
   by planted items.
2. GTI becomes defined: a variant selected in niche A is tested in niche B, and the transfer ratio has a CI.
3. The system proposes candidate niches. Humans still build and approve their oracles. Oracle generation by the system
   itself stays out of scope: candidates must never write their own evaluators.

**Prerequisites.**
- Second repo: operator token.
- Finding-fix lane on: operator flag.
- S0 maker isolation (MCP / SBX). Untrusted repos need it before anything else.

## Gates that unlock *more autonomy* (independent of stage)

| Before… | Evidence required | Tag |
|---|---|---|
| any learned artefact acts in prod beyond shadow | its own controlled positive effect with CI > 0 on an attributable, graded endpoint (stage 1 or 2 gate) | FACT (charter) |
| any auto-merge widening beyond test-only | ≥ 100 settled auto-merged changes with an **executed** settlement that has produced negatives. Today 0 auto-merged PRs have settled | FACT |
| agent-written code runs outside the gym sandbox | S0 isolation built and accepted (SBX P1/P2) | FACT |
| fleet agents enter selection | signed **and value-linked** outcomes (S3 bus auth, G5.1); exit codes do not count | FACT |
| a weighted fitness scalar drives selection | each component discriminates (R has negatives; € unknown share < 0.1; A measured, not estimated) | INFERENCE |
