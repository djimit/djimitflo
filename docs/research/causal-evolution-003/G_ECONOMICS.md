# CAUSAL-EVOLUTION-003 · G · Evolutionary economics

Conventions and source keys: `A_MECHANISM.md`. Resources are reported per dimension and are **never summed into one
unit**, because €, kWh and operator minutes have unknown shares (P4 `ue`: € unknown share 0.4, kWh coverage 41.4 %).
"n" is stated everywhere it matters. Token spend is never optimised on its own, separately from outcome quality.

## 1. Answer first

| # | Conclusion | Tag |
|---|---|---|
| G-1 | **Verified retained improvements in the last 30 days: 0**, so resources per verified retained improvement are **undefined (a measured 0 numerator, not an UNKNOWN)**. | **VERIFIED** (EVO north star; P4 `learning_ledger` 0/11 closed; 0 promotions) |
| G-2 | The Darwin genome loop spent 415 trial attempts (≈ 50.5 gym wall-h) and 18 dream genomes, and got 0 promotions and a pooled effect of −0.009 [−0.036, +0.017]. Its measured marginal return is **0 per GPU-h**, with low power. | **VERIFIED** (cost, 0 promotions) / **SUPPORTED** (effect ≈ 0) |
| G-3 | The only operator with a positive effect estimate on an independent oracle is the **generic strengthen-assertions retry**: +0.317 [0.217, 0.425] held-out kill per item at ≈ 0.15 GPU-h per item. That is ≈ +2 kill-share points per GPU-h, but it is **post hoc and unregistered**, one mutant family, and size-confounded (+194 lines median). | **SUPPORTED** (exploratory); confirmation is STR-001 |
| G-4 | Better selection on existing signals is nearly free but has little to select from. The graded contest would change 2 of 16 contests, by +0.042 mean graded, and about half of that is measurement noise. The bandit's alternative policy is +0.0018 [−0.0112, 0.0144]. | **SUPPORTED** / **VERIFIED** |
| G-5 | Deterministic testing is the cheapest and safest, but at today's thresholds it adds no measured quality. Assertion-strength passes 54/54 including zero-kill tests. `test:mutation:grounded` is vacuous outside its lane. The Stryker gate in the mutation lane works by construction, and its transfer is UNKNOWN. | **VERIFIED** |
| G-6 | On current evidence the Pareto-preferred direction is **measurement repair + strengthen retry + graded selection**, not genome mutation. That ordering is **SUPPORTED** at small n and becomes **VERIFIED** only if STR-001 confirms. | **SUPPORTED** |

## 2. Total resource expenditure (30 d unless stated)

| Dimension | Amount | Source | Tag |
|---|---|---|---|
| € known | ≥ €263.22 (Ollama Cloud, Claude Max, ChatGPT Pro, pro-rated). VPS € and kWh € unknown; unknown share 0.4 | P4 `ue.eur` | VERIFIED (lower bound) |
| Cloud tokens, prod maker | `maker:doc-drift-and-small-fix-loop`: 38.5 M input tokens on 100 purpose-tagged ledger rows. Purpose tagging started 10-12, so this covers about 10 days (P2 `purposes`). EVO/L3v2: opencode makers 114.7 M for 89 verified outcomes; claude + codex 24.1 M for 0 verified | P2, EVO | VERIFIED |
| Cloud tokens, lineage (60 d) | experiment stage 167.7 M (266 experiments); verified stage 79.8 M (121). So ≈ **87.9 M (52 %) went to experiments that did not verify** | P4 `lineage` | SUPPORTED (it assumes the verified subset is inside the experiment total) |
| jev | ≈ 2.40 M estimated input tokens; € UNKNOWN | JEV | VERIFIED |
| Local GPU energy | ≥ 17.25 kWh at 41.4 % sampling coverage (a lower bound; ≈ 42 kWh if unsampled time looks like sampled time, **HYPOTHESIS**) | P4 `ue` | VERIFIED (lower bound) |
| Gym wall time | 945 gym runs since 27-09: 530 non-trial ≈ 224 h, 415 trial ≈ 50.5 h (loop_run created→updated; an upper bound on GPU busy time) | P3 | VERIFIED |
| Offline experiments | MFR-001 ≤ 12.08 GPU-h, 0 tokens. STR-001 Stage A 0 GPU (sibling). EVOLUTION-001, JEV and this study: 0 GPU, read-only | MFR, EVO | VERIFIED |
| Compute depreciation | **UNKNOWN**: no hardware price or service life is recorded in the repo | — | UNKNOWN |
| Infrastructure (VPS) | **UNKNOWN** € (`vps: no_price`) | P4 `ue` | UNKNOWN |
| Operator | 104 human approvals + 50 human merges; 6 270 waiting minutes; ≈ 308 handling minutes (an estimate at 2 min/item) | P4 `ue.operator_minutes` | VERIFIED (counts) / SUPPORTED (minutes) |
| Review (model) | panel review 124 calls / 112.9 k in + 45.0 k out tokens since 10-12; Commons residents ≈ 0.46 M in + 1.25 M out tokens (P2) | P2 | VERIFIED |
| Failed experiments | NE-001…NE-013 (13 entries); MFR-001 (12.08 GPU-h); genome trials (50.5 gym-h, 0 promotions); TG-001 r2 INCONCLUSIVE (cost not re-derived here: UNKNOWN) | NE, MFR, P3 | VERIFIED / UNKNOWN |
| Regression remediation | **merged** regressions: 0 settled (22/22 survived; settlement 16/16), so post-merge remediation is ≈ 0 measured. **Pre-merge** waste: 60 regressed oracle-lane proposals (JEV §6.1) and the ≈ 87.9 M experiment tokens above | P4, JEV | VERIFIED / SUPPORTED |

## 3. Resources per unit of output

| Output unit | Count (30 d) | Resources per unit | Tag |
|---|---|---|---|
| **Verified retained improvement** (controlled gain, CI > 0, on an attributable held-out endpoint, retained) | **0** | **undefined** | VERIFIED |
| New retained capability tuple (task type × repo × executed verifier) | 0 | undefined | VERIFIED (EVO) |
| Newly validated component (not a capability gain) | 1 (security checker, SEC-F1) | — | VERIFIED |
| Surviving merged change (retention artefact, not an improvement) | 22 | ≥ €11.96; 285 waiting + ≈ 14 handling operator minutes | VERIFIED (P4 `ue`) |
| Verified change (throughput) | 120 | ≥ €2.19; opencode ≈ 1.29 M tokens per verified (L3v2) | VERIFIED |

## 4. Marginal returns by strategy (honest about n)

"Return" = change in **held-out fault detection** (graded kill on never-shown mutants), or the strategy's own registered
endpoint. Resource = GPU-h or tokens per decision unit.

| Strategy | Effect estimate | n | Resource | Return per GPU-h | Safety | Retention path | Tag |
|---|---|---|---|---|---|---|---|
| **Genome mutation** (dream + trial) | paired pass −0.009 [−0.036, +0.017]; 0 promotions; fire check off for all settled trials | 10 genomes, 320 paired obs | ≈ 50.5 gym-h + 1 cloud call/day | **0** (CI upper bound +1.7 pt pass, on saturated tasks, at ≈ 5 gym-h per trialled genome) | guard regex; gym sandbox | **none** (no prod injection) | VERIFIED (cost) / SUPPORTED (effect) |
| **Generic strengthen retry** (vs none) | +0.317 [0.217, 0.425] held-out kill | 40 items (post hoc) | ≈ 0.15 GPU-h/item; scoring CPU | **≈ +2.1 kill-share points per GPU-h** | test-only scope; sandboxed maker | merged test on `main` (the only L3 path) | SUPPORTED (exploratory) |
| Strengthen retry vs mutant feedback | +0.142 [0.033, 0.250] in favour of strengthening (registered) | 40 | same | — | — | — | VERIFIED (FALSIFIED feedback, NE-013) |
| **Deterministic assertion-strength** | 0 discrimination on graded (54/54 pass) | 57 | ms CPU | 0 measured | very safe | gate on auto-merge | VERIFIED |
| Deterministic Stryker gate (mutation lane) | mutation_score 0.888 (n 25); the gate requires a gain ≥ 10 pt by construction | 25 | CPU minutes per maker | UNKNOWN on an independent family | safe | merged test | SUPPORTED |
| **Better selection: graded contest** | +0.042 mean graded if switched; 2/16 contests differ | 16 | ≈ 0 (already computed in shadow) | very high ratio, tiny absolute gain | safe (shadow) | merged winner | SUPPORTED |
| Better selection: species bandit | OPE +0.0018 [−0.0112, 0.0144] (alternative policy) | 370 events | ≈ 0 | ≈ 0 | safe | species share | VERIFIED |
| Memory rules | registered readout 27-10 (not analysed here) | — | panel + prompt tokens | UNKNOWN | approval by LLM panel (F) | prod prompt | UNKNOWN |
| Harness change (M/H) | observational only: exports graded opencode 0.313 vs remote 0.187 (confounded) | 114 / 54 | — | UNKNOWN until HF-001 | — | config | SUPPORTED (confounded) |

**Reading.**
- On every axis where a number exists, genome mutation has the worst measured return. It costs ≈ 5 gym-hours per
  trialled genome (50.5 h over the 10 genomes that ran attempts, parent attempts included), has produced nothing, and has
  no retention path.
- The strengthen retry is the only operator with a large positive estimate on an independent oracle. Its weaknesses are
  known: post hoc, one family, size. They are exactly what STR-001 tests.
- Graded selection is almost free and should stay in shadow until k is raised (B §6). Its upside is capped by
  between-sibling variance: in 12 of 16 contests every sibling scored the same.

## 5. Pareto analysis (quality × cost × latency × safety × retention)

Levels are ordinal from the table above. "?" means UNKNOWN.

| Strategy | Quality (held-out) | Cost | Latency added to a goal | Safety | Retention | On the Pareto front? |
|---|---|---|---|---|---|---|
| A. no change (status quo) | baseline | 0 | 0 | baseline | merged tests | yes (trivially, at 0 cost) |
| B. measurement repair (k ≥ 9, two families, `skipped` for no-op checks, settlement pairing) | indirect (better selection later) | CPU only | +≈ 6 min scoring per maker (4× the 120 s kill budget) | safe | — | **yes**: it enables every other row |
| C. strengthen retry, shadow | **high** (if confirmed) | ≈ 0.15 GPU-h/item | +1 maker run (≤ 15 min) | safe (test-only) | merged tests | **yes**, pending STR-001 |
| D. graded contest, act | low-medium | ≈ 0 | 0 | safe | merged winner | yes, but dominated by B + D together |
| E. deterministic checks only | ≈ 0 measured | ≈ 0 | ≈ 0 | safest | — | yes on cost and safety; no quality |
| F. genome mutation (current) | ≈ 0 measured | ≈ 5 gym-h/genome | days per trial | guard-dependent | **none** | **no**: dominated by A on cost with equal measured quality |
| G. genome mutation with prod inheritance | ? | F + injection | +prompt lines | ? (unvalidated lines in prod) | prod prompt | **not admissible** until D's gates pass |

**Pareto set (SUPPORTED):** {A, B, C, D, E}. F is dominated, and G is not admissible. B is the precondition that makes the
quality axis measurable at all.

## 6. Recommendation (economics only)

1. Do not spend further GPU on dream genome trials beyond the registered E0 readout until AA-001 and INH-000 show that
   the channel can carry signal. It is ≈ 40 GPU-h, cheaper than another epoch of trials. **SUPPORTED.**
2. Spend the next GPU on STR-001 Stage B (≈ 16 GPU-h). It is the only operator with a positive estimate. **SUPPORTED.**
3. Measurement repair (B) costs no GPU and raises the value of every later experiment. **SUPPORTED.**
4. Price the unknowns: kWh tariff, VPS €, jev list price, hardware depreciation. Until then every € per outcome is a
   lower bound. **VERIFIED** gap.
