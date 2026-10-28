# EVOLUTION-001 · 8 · Decision

Conventions and source keys: file 1.

**Verdict: COMPLETE for the directive's scope.** All eight documents are delivered. The open UNKNOWNs are listed in §8.
**Cumulative evolution: not shown.** No controlled evidence exists that any feedback, inheritance or selection mechanism
improved later performance (L4 = 0, loops closed 0/11).

## 1. What exists

| Class | Items | Tag |
|---|---|---|
| EXISTS | species bandit; evolve contest; genome registry + frozen holdout epochs (0 exposed, 1 fresh); dream mutation with guard + evidence citation + playbook gene; graded fitness (shadow); settlement execution (shadow); memory rules with a randomised holdout; outcome attribution; NE registry; experiment registry with stop dates; six running factor experiments | FACT |
| PARTIAL | genome lines (gym only); skill cards (playbook only); knowledge refs (1/18 genomes, 0 proposals); harness variation (S, C, W yes; T, M no clean contrast); genotype identity (`skill_content_hash` on 34 % of outcomes; no served model / worker hash on gym attempts) | FACT |
| MISSING | prod injection of a promoted genome; a discriminating acting retention signal; any validated forecaster; a second repo / task type in act; crossover; QD archive | FACT |
| SUPERSEDED | mutant-feedback retry (NE-013); line-retention survival as a learning label (by settlement execution, shadow) | FACT |

## 2. What operates (acts in prod)

- Runtime bandit at share cap 0.8.
- Evolve contest (size rule).
- Memory-rule promotion and injection (holdout 0.3).
- Auto-merge test-only plus human merge.
- Six randomised factor experiments on oracle-lane goals.
- Dream evolution (resumed 22-10 11:26Z) with two trial genomes on epoch 1 (EE flags, S1).

**FACT.**

## 3. What has a measurable effect (controlled evidence only)

| Mechanism | Effect | Level | Tag |
|---|---|---|---|
| LLM checker / security checker (verifiers) | F1 AUC 0.95; SEC-F1 AUC 0.975, 19/20 caught, 0/26 false rejects, McNemar p 0.00014 | L3 | FACT |
| Mutant-feedback retry | **negative**: Δ −0.142 [−0.250, −0.033] held-out kill (offline) | L3 offline, falsified | FACT |
| Generic strengthen retry vs no retry | +0.317 [0.217, 0.425] held-out kill, **post hoc and unregistered** (MFR-RA) | none until E1 confirms | FACT (numbers) / HYPOTHESIS (effect) |
| Any learning, inheritance or selection mechanism (bandit, genomes, memory, retrieval, examples, template, deps, siblings, checker family, requeue, skills) | none with CI excluding 0; interim reads are descriptive | L1 | FACT |

## 4. Incomplete inheritance paths (file 5)

1. **Genome lines.** Validated-learning link never passed (0 promotions). Prod application **does not exist**: injection is
   not built, so a promotion would change nothing in prod.
2. **Memory rules.** Inherited and applied, but validated by panel and human approval, not by outcome. The outcome trends
   against the rules (0.802 vs 0.903). Only 19 of 187 promoted rules are ever read.
3. **Skill cards.** 102 stored, 0 validated, consumed only by one gym-trial playbook.
4. **Knowledge.** Discovery → proposal provenance `not_linked`; 0 proposals cite knowledge.
5. **Commons / DI.** Break at evidence: 0 typed replies, 0 falsifier runs, 0/20 decision-grade forecasters.
6. **Merged tests.** The only chain at L3. "Improves later performance" is unmeasured: settlement kill share has 0
   maker-time pairs.
7. **Outcome-learning assessments.** The 12 "SUPPORTED" signals are synthetic worldlab simulations. They are generated
   artefacts and must not be counted as learning.

## 5. Where cumulative growth is plausible (INFERENCE / HYPOTHESIS)

1. **Test-quality ratchet on the existing L3 capability (most plausible).**
   - The path is already wired and acting: maker → executed gates → merge → main.
   - What it lacks is a selection signal that discriminates:
     - graded Q is computed but unread;
     - retention R does not fail.
   - If E1 confirms a strengthen step, and graded Q then becomes the contest and settlement criterion, quality could
     ratchet across merged tests.
   - That would be niche construction with selection. It is not yet agent learning.
2. **Genome trials on epoch 1.**
   - For the first time a parent has headroom: 12/35 gated mined tasks pass (0.34, inside Gate A's band).
   - Growth here is plausible only once the deciding set is repaired (40 tasks, not 10) and the evaluation contract is
     pinned (model, worker).
   - Even then, power is 0.17–0.31 at a 20 % fix rate.
3. **Not plausible on current evidence.** Commons, residents, committee and panel deliberation as growth engines (NE-003,
   NE-010, 0/20 decision-grade). Also MAP-Elites at current n.

## 6. North-star metric: new, retained, independently verified capabilities ÷ resources

**Numerator definition.** A *distinct capability* is a new (task type × repository × executed verifier) tuple that meets
all of the following:
1. ≥ 10 changes verified by an executed oracle whose verifier passed a planted-item test;
2. retained by an **executed** settlement at +14 d;
3. reproduced on held-out items.

A controlled improvement of an existing capability also counts as one gain: a mechanism with CI > 0 on an attributable,
graded, held-out endpoint (the stage 1/2 gates). Task counts, verified counts and PR counts are throughput and never
enter the numerator.

**Numerator, last 30 days.**

| Item | Count | Tag |
|---|---|---|
| New capability tuples | **0**: finding-fix is shadow with 0 proposals; second repo not live | FACT |
| Controlled improvements of an existing capability | **0** (loops closed 0/11; NE-013 negative) | FACT |
| Retained existing capability | governed test writing in djimitflo: settlement execution 16/16 pass | FACT |
| Newly independently validated component (not a capability gain; reported separately) | 1, the security checker (SEC-F1) | FACT |

**Denominator, per dimension (30 d; never summed into one unit).**

| Resource | Amount | Source | Tag |
|---|---|---|---|
| Cloud tokens, opencode makers | 114.7 M (89 verified maker outcomes) | L3v2 | FACT |
| Cloud tokens, claude + codex makers | 24.1 M for 0 verified | L3v2 | FACT |
| Cloud tokens, lineage, 60 d | experiment stage 167.7 M, verified stage 79.8 M | EE `lineage` | FACT |
| Local GPU energy | ≥ 17.2 kWh (coverage 41.3 %, so a lower bound); mean 57.9 W over 35 340 samples | EE `ue`, S1 | FACT |
| € | ≥ 263.22 known (3 subscriptions pro-rated); VPS and kWh unknown; unknown share 0.4 | EE `ue` | FACT |
| Operator | 104 human approvals, 50 human merges; 6 270 waiting min; ≈ 308 handling min (estimate) | EE `ue` | FACT |
| Throughput context (not the north star) | 120 verified; 22 surviving; NEV 0.238 survived per M cloud tokens | EE | FACT |

**Value.** 0 new capabilities per (≥ €263, ≥ 17.2 kWh, ≈ 139 M maker tokens, ≈ 6 578 operator minutes). This is a measured
0, not an UNKNOWN. The trend is undefined until the numerator moves.

## 7. The single experiment with the greatest expected information gain

**E1 · STR-001: strengthen-assertions retry vs no retry** (file 6). Stage A first, then Stage B.

**Why this one (INFERENCE).**
- **High real uncertainty.** MFR-RA shows a large post-hoc effect (+0.317) on a deterministic counterfactual. MFR itself
  proved that generator-family endpoints can be gamed. Whether the effect survives a **different mutation family**
  (Stryker) and fresh items is genuinely open, so either outcome changes the plan.
- **Leverage.** The exports lane produces 57 % of verified output, and 28/66 graded exports tests kill 0/3 mutants (S1; 26/64 in L3v2).
- **It decides the stage 1 gate and seeds the stage 2 bridge** (template gene). It is the cheapest path to a first learning
  mechanism with CI > 0 on a value endpoint.
- **Cheapest of the candidates, and collision-free.** It is offline, uses no WIP slot and does not overlap NE-013.
- **The alternatives carry less information per cost.**
  - E0 is running anyway. Its information is low even after repair (power 0.17–0.31), although the repair is mandatory.
  - E2 costs 58–116 GPU-h and does not test learning.
  - E3 needs about 48 M cloud tokens.

**Budget.**

| Stage | GPU | Cloud tokens | Other |
|---|---|---|---|
| A | 0 GPU-h | 0 | ≈ 3–6 CPU-h; days |
| B | ≈ 13.4 GPU-h (≈ 4–6 kWh) | 0 | 42 fresh items ≈ 30 days of accrual; € UNKNOWN (no kWh tariff) |

**Mandatory zero-cost prerequisite (operator flag).** Repair E0's deciding set before the first mutant-holdout attempt
(§9, BLOCKING).

## 8. Evidence required before granting more autonomy

| Autonomy step | Required evidence | Tag |
|---|---|---|
| A learned mechanism acts beyond shadow | its own pre-registered CI > 0 on an attributable, graded, held-out endpoint; shadow in prod at WIP ≤ 4 with no harm | FACT (charter) / INFERENCE |
| A genome reaches prod makers | a promotion from a **powered** trial (≥ 40 deciding tasks, Gate A band, pinned model/worker) → shadow → ≤ 10 % traffic with auto-retire | INFERENCE |
| Selection on a weighted fitness | R produces negatives; € unknown share < 0.1; A measured, not estimated | INFERENCE |
| Auto-merge beyond test-only | ≥ 100 settled auto-merged changes under an executed settlement that has produced negatives (today 0 settled auto-merges) | FACT |
| Agent code outside the gym sandbox / external repos | S0 maker isolation (SBX P1/P2; MCP rec 2) | FACT |
| Fleet agents under selection | signed and value-linked outcomes (S3, G5.1) | FACT |

**Remaining UNKNOWNs (never read as 0).**
- Served model and worker version per gym attempt.
- € per kWh and for the VPS.
- Training-seed variance in the reference paper.
- Whether merged tests catch later regressions (kill share has 0 pairs).
- Why 217 of 329 prod maker outcomes have no `skill_content_hash`.

## 9. Top findings and blocking issue

1. **BLOCKING for a valid genome readout (not for prod safety).**
   - `DREAM_TRIAL_MUTANTS=true` makes the epoch-1 mutant holdout decide.
   - That holdout froze tiers 3–6, but `DREAM_TRIAL_MUTANT_TIERS` is unset and defaults to `2,3` (`genome-registry.ts:112-114`).
     **Only 10 of 40 tasks decide.**
   - Exact power: ≤ 0.09 even if a mutant fixes half the parent's failures.
   - Also: gym attempts record no served model or worker hash, and 21/35 parent attempts predate the D9 runner change.
   - Repair: set `DREAM_TRIAL_MUTANT_TIERS=3,4,5,6` before the first mutant-holdout attempt (0 run so far), or settle both
     trials and restart. Pre-register the readout. **Operator decision.**
2. **MFR-001 is FALSIFIED** (NE-013). Its control data hold the most promising open lever: generic strengthen retry,
   +0.317 [0.217, 0.425], unregistered, which E1 confirms or refutes.
3. **No heredity chain is complete at L4.** A genome promotion would not reach prod (no injection). The only learned and
   inherited prod gene, memory rules, trends negative: 0.802 vs 0.903; readout 27-10.
4. **The acting selection signal is blind to value.** Verified tests average graded 0.300 vs 0.286 for not-verified ones.
   Graded Q is the only discriminating, independent fitness and it is read by nothing. Retention cannot fail (22/0;
   execution 16/0).
5. **The paper** (arXiv:2610.29458) establishes, for RL training only, that structured harness diversity improves
   cross-harness generalisation: +3.6 to +9.8 in-space, better black-box transfer, no CIs reported. Djimitflo has no clean
   T or M contrast and trains nothing, so the transferable part is the evaluation design: a factorial with held-out
   combinations (HF-001).
