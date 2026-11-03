# Operator Cockpit 3.0: evolution validation

This document separates throughput (activity, verified count) from demonstrated intelligence improvement. The full metric scorecard is in [../intelligence-metrics/INTELLIGENCE_SCORECARD.md](../intelligence-metrics/INTELLIGENCE_SCORECARD.md). This file records the 10-10 state and the cockpit's handling of it.

The cockpit labels verified versus regressed as **"throughput, not intelligence"** (#738) and links to /evolution for the scorecard.

## Conclusions (prod data, 10-10)

| Question | Evidence | Verdict |
|---|---|---|
| Validated improvement gain (VIG): candidate vs frozen baseline | 14+ dream genomes, 0 promoted; trials no_headroom/blind (parent fails ≤ 3/20 on the mined holdout); DREAM_EVOLUTION_ENABLED off since 09-10 | **INSUFFICIENT_EVIDENCE** |
| Generalisation: gym → production | atomic@llama-router 558/691 = 80.8 % gym vs 3/53 = 5.7 % production (30 d); opencode ≈ 45 % gym vs 42/124 = 33.9 % prod | **Gym success does not predict production**. Gym wins are not counted as improvement |
| Survival after settlement | merge survival: 2 settled, 2 survived (first loop PRs settle ~19-10) | **INSUFFICIENT_EVIDENCE** (n = 2). Unsettled = censored, not failure or success |
| Economic efficiency | spend 2.37 M / direct 0.91 M tokens per verified change (7 d); verified per M cloud tokens 0.378 (B3, 7 d); per kWh gated by #741 (coverage 23 % → null) | measured (spend); per kWh **INSUFFICIENT_EVIDENCE** |
| Learning effectiveness (memory) | MEMORY_HOLDOUT arms since 08-10: rules 2 V vs holdout 4 V (F3, Fisher p 0.57, n 5–6/arm ≪ 30) | **INSUFFICIENT_EVIDENCE**; trend against rules; keep running |
| Learning effectiveness (knowledge) | F4: 44/52 KB panels cite `kb:` pages, decision mix unchanged (needs_more_evidence 82 % vs 79 %) | cited, **not decision-moving** |
| Agent collaboration (reviewer value) | F1: checker accept good 18/20, defective 3/20, AUC 0.875 (1.46 M tokens); F2 cross-family arm collecting, target 93/arm, n = 1 | checker **discriminates** (one experiment); cross-family **INSUFFICIENT_EVIDENCE** |
| Effort (sibling makers) | X1 interim: siblings on 0/3 vs off 8/11 (p 0.055, n 15), target 94/arm | **INSUFFICIENT_EVIDENCE**; running |
| Forecast quality | no forecaster beats the per-source base rate (AR1/V2: 0 of 18–19 decision-grade) | **no skill** |
| Requeue recovery (phase-1 falsifier < 40 %) | 4 V / 3 R / 1 infra = 50 % of 8 resolved | above falsifier, small n |
| Safety | policy_violations rows 0 since #735 (shadow); hack detector shadow; canaries 1 served, 0 solved | no breach observed. Absence ≠ proof |

## Holdout integrity

| Epoch | Candidates | Evaluations | Reuse limit | State |
|---|---|---|---|---|
| mined epoch 0 | 11 | 261 | 10 | **past limit** (`reuse_risk`) |
| mutant epoch 0 | 12 | 140 | 10 | **past limit** |

Reuse is detected and reported (evolution-evidence `holdout_exposure`, #736). It does **not block** a promotion in code. Promotions are off only because dream evolution is off. Before trials resume, a fresh `GYM_HOLDOUT_EPOCH` is required (operator action).

## Promotion gates (in code)
- **Paired test:** exact McNemar or e-process, or under `DREAM_PROMOTION_RULE=graded` a sign-flip permutation. The bar is p < 0.05 plus a mean difference ≥ 0.05, with a mined net loss ≤ 1 (#565, #589, #709).
- **Headroom precheck:** an `inconclusive` verdict when the parent's failures leave no room for a significant win (#674).
- **Fire check:** a genome whose lines never reached the prompt is VOID (#695).
- **No self-evaluation:** a candidate may not alter its own evaluator or promotion criteria. Gates and oracles are outside the genome; the guard on dream lines enforces this.
- **Not built:** a block on promotion when the holdout is past its reuse limit (scenario 10, see TEST_EVIDENCE.md).

## Smallest experiments that resolve the open questions
1. **VIG:** freeze a fresh epoch of write_test holdout tasks (#712), turn dream evolution on for one cycle under `graded`, and read `graded_refs`.
2. **Gym → production:** run 20 paired real oracle goals for atomic vs opencode (the D6 rule). This already happens through evolve siblings; read it at n ≥ 20.
3. **Survival:** wait until ~19-10 for the first 20 merged loop PRs to settle.
