# EXP-2: X1 evolve-sibling arm, result (2026-11-07)

Registration: [EXPERIMENT_PROTOCOL.md#exp-2](EXPERIMENT_PROTOCOL.md#exp-2) (`EFFORT_SIBLING_RANDOMISE`, operator-approved
08-10). Registry entry: `experiment-registry.ts` `X1`, started_at 2026-10-09T00:00Z, target_n 94 settled per arm,
stop_by 2026-11-06T00:00Z ("4 weeks, ~94 settled per arm"). This readout ran once, after stop_by. It is read-only: no flag,
assignment or data was changed.

## What is registered

- **Arms.** For an evolve-eligible (oracle-lane) goal, the arm is `sha256("effort-x1:" + goal id)[0] mod 2`. In arm `on` the
  goal gets evolve siblings as configured (`LOOP_EVOLVE_SPECIES=remote@workstation/atomic@llama-router`). In arm `off` it gets none.
- **Primary endpoint and test.** Verified rate over settled proposals (verified ÷ (verified + regressed)), on vs off, with a
  two-sided Fisher exact test. This is the evidence function `effortX1Evidence`. Goals with a lease on the Ollama outage
  fallback are excluded. The registry says "no effect size computed", so the risk difference and CIs below are descriptive.
- **Secondary.** Tokens per verified outcome per arm.
- **Decision.** "If siblings do not beat no-siblings on verified rate, or are non-inferior at higher cost, the effort
  controller gets 'no sibling' as default (operator)."
- **Global rules that apply.** Fixed horizon. INSUFFICIENT_EVIDENCE when n at the horizon is below the registered minimum
  (never "no effect"). Holm across concurrent primaries. CIs clustered by proposal. The 2026-10-19 amendment adds: if not
  every arm reaches the target at stop_by, the experiment stops at the n reached, and a new version needs a new registration.
  No extension is registered.
- **Periods.** The registry's treatment-env rule (A18) says analyses never pool across a period boundary. EXP-3 sets the
  pattern: use a period term or a single period, never silent pooling.

Missing from the registration: a non-inferiority margin, so the "non-inferior at higher cost" branch cannot be tested
formally. The registry also has no rule for the #947 window. Excluding that window is a sensitivity analysis here; the
registered analysis keeps it.

## Data

- Prod `/data/djimitflo.sqlite`, opened `readonly: true` with `query_only`, at 2026-11-07T20:47Z. Scripts:
  `EXP-2_readout.js` and `EXP-2_readout_energy.js`. Output: `EXP-2_readout-20261107.json`.
- Horizon: goals created in [2026-10-09T00:00Z, 2026-11-06T00:00Z). Timestamps are normalised, because `goals.created_at`
  uses SQLite's `YYYY-MM-DD HH:MM:SS` format (see "Registry display line" below). 217 goals carry an arm. 4 are excluded as
  outage fallback, leaving **213 (on 86, off 127)**. 3 arm goals were created after stop_by and are not counted.
- Arm integrity: the stored `effort_arm` equals the recomputed hash for 220 of 220 goals. There is one `effort_arm` event
  per goal and one goal per proposal, and no proposal falls in both arms. A goal-level analysis is therefore a
  proposal-level analysis, and clustering changes nothing.

### Period boundaries

| at (UTC) | what | source |
| --- | --- | --- |
| 2026-10-22T00:00Z → 2026-10-29T17:13:27Z | remote siblings could not deliver (#947 remote-job identity). 25 of 25 on-arm sibling jobs in this window ended `cancelled` (19 `lease_not_active;late_result`, 3 `work_timeout`, 3 `queue_timeout`), and 0 siblings won | operator plan; confirmed in `remote_maker_jobs` |
| 2026-10-27T05:52:42Z | `LOOP_MEMORY_RULES_ENABLED=false` (EXP-3 action); X1 declares it in `treatment_env` | EXP-3_RESULT.md |
| 2026-11-05T19:58Z | maker prompt change | operator plan |
| 2026-11-06T13:35:44Z | `SKILL_ROUTE_MODE` null → shadow | `experiment_period_boundaries` (after stop_by) |
| 2026-11-07T12:00:09Z | `OPENCODE_BRAKE_CACHE_READ_WEIGHT` null → 0.1 | `experiment_period_boundaries` (after stop_by) |

The DB has only these two boundary rows for X1, both after stop_by, because recording started with #1091. The registry
comments also name treatment-env changes that wrote no row. They fall in P3: `LOOP_BANDIT_MAX_SHARE` 0.8 → 0.1 (10-30
09:42), the value gate plus its LANES setting (10-31), the content-safety model (10-31) and its ignored categories (11-02).
P3 is too small to split any further.

## Result

### Registered analysis, whole window (as written)

| Arm | Goals | Verified | Regressed | Settled | Rate (Wilson 95 %) |
| --- | --- | --- | --- | --- | --- |
| on (siblings) | 86 | 56 | 23 | **79** | **0.709** (0.601–0.797) |
| off (no sibling) | 127 | 74 | 35 | **109** | **0.679** (0.586–0.759) |

**Two-sided Fisher exact p = 0.75.** The risk difference on − off is +0.030 (Newcombe 95 % CI −0.105 to +0.158). Holm can
only raise p, so the conclusion does not change. Not settled and excluded from the denominator, as in the evidence function:
on 7 infra_failed, off 15 infra_failed and 3 no_change. ITT (verified ÷ goals, descriptive): 0.651 vs 0.583, Fisher p 0.39.

By lane (descriptive): test-gap 40/48 (0.833) vs 51/61 (0.836), p 1.0. Mutation 16/31 (0.516) vs 23/48 (0.479), p 0.82.

### Per period

| Period | on verified/settled | off verified/settled | RD (Newcombe 95 %) | Fisher p |
| --- | --- | --- | --- | --- |
| P1 10-09 → 10-22 (pre-#947) | 32/43 = 0.744 | 47/63 = 0.746 | −0.002 (−0.174, 0.158) | 1.00 |
| P2a 10-22 → 10-27 05:52 (#947, memory rules on) | 10/13 = 0.769 | 10/18 = 0.556 | +0.214 (−0.123, 0.478) | 0.28 |
| P2b 10-27 05:52 → 10-29 17:13 (#947, memory rules off) | 8/10 = 0.800 | 6/8 = 0.750 | +0.050 (−0.308, 0.420) | 1.00 |
| P3 10-29 17:13 → 11-05 19:58 (post-fix) | 6/13 = 0.462 | 11/19 = 0.579 | −0.117 (−0.415, 0.211) | 0.72 |
| P4 11-05 19:58 → 11-06 00:00 (new maker prompt) | 0/0 | 0/1 | n/a | n/a |

**Pooled with a period term (Mantel–Haenszel over the 5 periods):** OR 1.10, risk difference +0.019 (95 % CI −0.111 to
+0.150), CMH χ² (continuity-corrected) 0.015, p 0.90. With lane × period strata: OR 1.00, RD −0.001 (−0.120, +0.118), p 0.87.

### Sensitivity: #947 window excluded

During P2 the on arm received no working sibling, so in practice it was a second off arm. With P2 removed:

- Whole: on 38/56 = 0.679 vs off 58/83 = 0.699, RD −0.020 (Newcombe −0.178 to +0.130), Fisher p 0.85.
- Period term (P1, P3, P4): MH OR 0.87, RD −0.029 (−0.182 to +0.124), p 0.86.

The sign flips from +3 points to −2 to −3 points. Neither estimate is distinguishable from 0. The upper CI bounds rule out a benefit above
about 16 points (whole window) or 13 points (#947 excluded).

### Sibling delivery (on arm)

| Period | on goals | sibling completed / failed | sibling won selection |
| --- | --- | --- | --- |
| P1 | 48 | 32 / 16 | 29 |
| P2 (#947) | 25 | 0 / 25 | 0 |
| P3 | 13 | 6 / 7 | 4 |

### Cost per arm (secondary)

All leases (maker, sibling, checkers) on the goals' runs, whole window:

| | on | off |
| --- | --- | --- |
| reported tokens (all cloud) | 61.0 M | 86.9 M |
| tokens per goal | 0.71 M | 0.68 M |
| **tokens per verified** | **1.09 M** | **1.17 M** |
| sibling tokens | not reported (the remote host returns no counts) | 0 |
| sibling GPU energy | 1.36 kWh gross (1.09 kWh above a 40 W idle baseline) over 35 jobs, 7.8 h claimed → finished, measurable from 10-22 only | 0 |

With P2 excluded, tokens per verified are 1.16 M (on) vs 1.13 M (off). Siblings run on the workstation, so their cloud-token
cost is 0 by construction. Their cost is local GPU energy plus wall-clock: about 12 min of remote work per job (claimed → finished),
plus queue time. Energy before 10-22 cannot be attributed, because those sibling leases have no `remote_maker_jobs` row (the job↔lease
link came with #947). The gross figure comes from `host_power_samples` over each job's claimed → finished window and is not
exclusive: gym and other work share the GPU.

### Integrity flags

- **Sample-ratio mismatch.** 86 on vs 127 off (binomial vs 0.5, p = 0.006). The imbalance already exists in the evolve-eligible
  population before assignment (92 vs 135 goals, p = 0.005), while all goals in the window balance (704 vs 717 by hash).
  Checked and ruled out: stored arm ≠ hash (0 of 220), deleted goals, orphaned runs, `effort_arm` events without a goal, and
  proposals with more than one goal. No mechanism was found. Goal ids are random UUIDs, so chance remains possible but
  unlikely. The arms are still assigned by hash and compared within the same eligible population. The SRM is reported here
  but does not change the verdict.
- **Power.** At 79 / 109 settled, power is 0.78 for 0.6 vs 0.4 and 0.27 for 0.55 vs 0.45 (two-sided α 0.05). A small sibling
  benefit is not ruled out.

### Registry display line differs from this readout

The registry's live line (`experimentsReport` at 20:47Z) shows on 77 vs off 100 settled, Fisher p 0.33. It differs from the
registered horizon for two reasons. (a) It counts from started_at with no end, so goals created after stop_by are included.
(b) `effortX1Evidence` compares `g.created_at >= since` as strings. A SQLite `2026-10-09 08:07:36` sorts below
`2026-10-09T00:00:00.000Z`, so every goal created on the start day is dropped. The registered analysis
above uses normalised timestamps and the stop_by end. The same string compare appears wherever an ISO `since` is compared with
`goals.created_at`, which is a code fix outside this docs PR.

## Decision under the registered rules

- **Verdict: INSUFFICIENT_EVIDENCE** (in SUPPORTED / REJECTED / INCONCLUSIVE terms, INCONCLUSIVE). The on arm reached 79 of
  the registered ~94 settled at stop_by. Under the global rule and the 2026-10-19 amendment, the experiment stops at the n it
  reached and is recorded as INSUFFICIENT_EVIDENCE, never "no effect". The point estimate is +3 points (whole window,
  p 0.75) or −2 points (#947 excluded, p 0.85). No interpretation shows a sibling benefit.
- **No extension.** The protocol registers none. A continuation is a new version with a new registration. Accrual would allow
  one (on arm 2.4 per day over the last 14 days, so roughly 6 more days to reach 94 in a clean period), but only the operator
  can register it.
- **Decision rule.** "If siblings do not beat no-siblings on verified rate … the effort controller gets 'no sibling' as default
  (operator)." Siblings did not beat no-siblings in any period or analysis. The registered decision therefore points to
  **no sibling as the default**. Like EXP-3, that is a retain-the-simpler-baseline rule. It does not claim that siblings have
  no effect. The cost branch cannot be tested without a margin, and it is not needed: the first branch already holds.

## Implied action at stop_by (not taken; operator decision)

1. Stop X1. Past stop_by, every new eligible goal still gets randomised (3 since 11-06), and the stall watch reports X1 as
   `experiment_overdue`.
2. Make "no sibling" the default for oracle-lane goals. Setting only `EFFORT_SIBLING_RANDOMISE=false` would do the opposite:
   it restores siblings on every goal. The registered default corresponds to `LOOP_EVOLVE_ENABLED=false` (or an empty
   `LOOP_EVOLVE_SPECIES`), applied in the same idle recreate.
3. Siblings change which maker's patch goes to review for the shared oracle-goal population. So the change is a period
   boundary for ACE-001, STE-001, MAKER-DEPS-001 and F2 v2, which run on that population. `LOOP_EVOLVE_ENABLED` is not in
   their `treatment_env`, so the operator records the instant, as was done for the EXP-3 memory-rules switch.
4. Record the close in the registry (proposed in the PR, not made here, because it waits on the operator decision):
   `X1_CLOSED: ExperimentClose = { verdict: 'INSUFFICIENT_EVIDENCE (no sibling benefit at 79/109 settled)', decided_on:
   '<operator date>', source: 'docs/research/intelligence-metrics/EXP-2_RESULT.md#decision-under-the-registered-rules' }`,
   with `closed: X1_CLOSED` and `verdict: X1_CLOSED.verdict` on the X1 entry, plus a registry test that X1 is no longer
   overdue.
