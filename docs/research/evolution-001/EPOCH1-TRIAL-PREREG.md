# Pre-registration: epoch-1 genome trial readout (g-a187f81f, g-d14c1156)

Registered 2026-10-22 ~20:10Z, before the first mutant-holdout trial attempt (0 at registration). Operator decision
2026-10-22: use all 40 frozen mutant tasks.

## Setup (prod, verified in the container)
- Trials: `g-a187f81f` (gene strategy_lines) and `g-d14c1156` (gene playbook), parent = baseline genome; dream 2026-10-16.
- Holdout: epoch 1 (frozen 2026-10-14, manifest 37b8172e…): 40 mined tasks + 40 seeded-mutant tasks (tiers 3–6, 10 each, 40 files).
- Config: `DREAM_TRIAL_MUTANT_TIERS=3,4,5,6` (was unset → code default 2,3, which would have used only the 10 tier-3 tasks;
  runtime.env.bak-20261022T200538Z), `DREAM_TRIAL_MUTANTS=true`, `DREAM_PROMOTION_RULE=both`, `TRIAL_HEADROOM_PRECHECK=true`,
  `GYM_HOLDOUT_EPOCH=1`, Gate A eligibility = prod-gated parent evidence on the current epoch (#819).
- Species: atomic@llama-router on the workstation, hardened runner (#955/#958) from 2026-10-22 ~03:40Z.

## Decision rule (unchanged code, stated here so it cannot drift)
- Paired by task: parent vs mutant genome on the same frozen task.
- Promote only if the rule in force (`both`) passes on the 40-task mutant holdout AND the mined holdout net loss ≤ 1.
  Otherwise `retired` (or `inconclusive` when the headroom precheck / Gate A eligibility fails).
- Expected power is low (≈ 0.17–0.31 for a genome that fixes 20 % of parent failures; EVOLUTION-001-FITNESS.md). A
  non-promotion is therefore reported as INSUFFICIENT_EVIDENCE for "no effect", not as evidence of no effect.

## Known threats (reported with the readout, not corrected post hoc)
- 21 of the parent's first 35 mined-holdout attempts ran before the hardened runner; mutant-genome attempts all run after it.
  The readout reports parent results split by runner (pre / post 2026-10-22 03:40Z).
- Gym attempts do not record the served model or worker version (gap; fix needs a separate OK).
