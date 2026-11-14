# STE-001: Simplified Technical English maker template, result (2026-11-14)

Registration: [STE-001_PROTOCOL.md](STE-001_PROTOCOL.md) with Amendments 1 to 3. Registry entry: `experiment-registry.ts` `STE-001`
(started_at 2026-10-11T00:00Z, target 100 per arm, stop_by 2026-11-14T00:00Z). The readout ran once, after stop_by. It is read-only:
no flag, assignment or data was changed. `STE_001_MODE` is still `on` in production.

## Why the readout is due now, and which rule applies

- The protocol says "Analysis once both arms reach 100". Amendment 1 adds a deadline: "At stop_by: if every arm has reached the
  target, the registered analysis runs once, as written. If not, the experiment stops at the n reached and is recorded as
  INSUFFICIENT_EVIDENCE (never 'no effect'); a new version needs a new registration."
- Arm 0 reached 100 on 2026-11-03T08:57Z. **Arm 1 did not reach 100 before stop_by.** It ended at **99** analysable outcomes (its
  99th at 2026-11-13T20:14:40Z). So the Amendment 1 branch "not every arm at target" applies.
- **Count used, and why.** The target counts what the registry counts: `ste001Evidence`, that is, production maker outcomes
  (`loop-maker:*`, not gym) that carry `ste-001-arm:<0|1>`, created in [started_at, stop_by), **without outage-fallback outcomes**
  (`runtime_fallback:ollama_outage`; operator decision 2026-10-18, `ollama-outage-fallback.ts`, which names STE-001). With its one
  fallback outcome counted, arm 1 would be at 100. The protocol text does not mention the fallback, so this is a reading. It is the
  reading that Amendment 1 itself used. Its accrual figures ("arm 0 = 33, arm 1 = 30" at 2026-10-18 22:33 UTC) are reproduced exactly
  with fallback outcomes excluded (33 / 30). With them included the figures are 35 / 31. The stop date was computed from that count.
  The stall watch also used it (`experiment:STE-001`, past stop_by, n per arm {0: 135, 1: 99}).
- Unit: the protocol says "100 per arm (200 goals)", and the arm is assigned per goal. The evidence function counts maker outcomes.
  In the window there is exactly **one maker outcome per goal** (237 outcomes, 237 goals, 237 runs), so the two counts are the same.

## Data

- Prod `/data/djimitflo.sqlite`, opened `readonly: true` with `query_only`, at 2026-11-14T00:35:22Z, through the deployed image
  `2ef75501`. Script: [`STE-001_readout.mjs`](STE-001_readout.mjs). Output: [`STE-001_readout-20261114.json`](STE-001_readout-20261114.json).
- Window: [2026-10-11T00:00Z, 2026-11-14T00:00Z). 237 outcomes. 0 are from before the window and 0 are from after stop_by. 3
  outage-fallback outcomes are excluded: arm 1 had 1 (10-18, no_change) and arm 0 had 2 (10-18, 1 verified and 1 regressed).
  **Analysed: 234** (arm 0 135, arm 1 99).
- Lanes: exports 95, mutation 106, test-gap 33.

### Integrity

- The stored arm equals parity of `sha256('ste-001:' + goal id)` for 237 of 237 goals. The assignment's `ste_001.arm` equals the
  outcome's arm for 237 of 237. The assignment's template hash is `control` (arm 0) or `49b6259fcefa` (arm 1) on every assignment
  event. That is the hash of today's `MAKER_TEMPLATE_RULES_STE`, so the STE text did not change during the window.
- **Arm imbalance.** The outcomes split 137 / 100 (χ² p 0.016). The hashed population of all oracle-lane goals created in the window
  splits 143 / 105 (p 0.016) in the same way. So the imbalance comes from the hash assignment itself, not from attrition. It is the
  reason arm 1 missed the target although the total (237) was above 200.
- ACE-001 cells (orthogonal factor, descriptive): STE 0 × ACE 00/01/10/11 = 34 / 35 / 40 / 28; STE 1 = 27 / 15 / 24 / 34.

### Delivery: did arm 1 get the STE template?

| Evidence | Arm 0 (current) | Arm 1 (STE) |
| --- | --- | --- |
| Outcome lease carries `ste_001` with the outcome's arm | 137 / 137 | 100 / 100 |
| Lease genome `template` gene | `c8483ca33a01` (= hash of `MAKER_TEMPLATE_RULES`) on 137 | `49b6259fcefa` (= hash of `MAKER_TEMPLATE_RULES_STE`) on 100 |
| Remote prompt text (`remote_maker_jobs.prompt`) | 25 / 25 contain the current rule, 0 the STE rule | 15 / 15 contain the STE rule, 0 the current rule |
| `LOOP_WORK.md` still on disk | 5 / 5 current text | 3 / 3 STE text |

The check uses the first rule of each template ("Change only the files that the finding names." vs "Keep the diff small and local
to the finding."). The template gene is computed from the code constants at run time. Both hashes were the same on every lease, so
neither template changed in the window. 89 other maker leases (earlier failed attempts, retries and remote leases) carry no
`ste_001` record, because the daemon writes it only on the lease that produces the outcome. Where text survives for those leases
(remote prompts), it matches the arm. **Delivery: arm 1 received the STE template, and arm 0 received today's template, on every
run where it can be checked. No crossover was found.**

### Safety stop (harm)

"If after 30 per arm the STE arm's verified rate is 25 points or more below control, switch `STE_001_MODE` off." From 30 per arm
on, the largest cumulative gap was **−16.7 points** (2026-10-18, 18/30 vs 23/30). That is below the 25-point threshold, so the harm
stop never applied.

### Period boundaries

| at (UTC) | what | source |
| --- | --- | --- |
| 2026-10-27T05:52:42Z | `LOOP_MEMORY_RULES_ENABLED=false` | Amendment 2 (registered) |
| 2026-11-05T19:58Z | maker prompt change | operator plan (EXP-2_RESULT.md), no DB row |
| 2026-11-06T13:35:44Z | `SKILL_ROUTE_MODE` null → shadow | `experiment_period_boundaries` |
| 2026-11-07T12:00:09Z | `OPENCODE_BRAKE_CACHE_READ_WEIGHT` null → 0.1 | `experiment_period_boundaries` |
| 2026-11-08T00:00:02Z | `LOOP_EVOLVE_ENABLED=false` (siblings off) | Amendment 3 (registered) |
| 2026-11-08T02:32:21Z | `MAKER_SCOPE_REPAIR` null → on | `experiment_period_boundaries` |
| 2026-11-09T00:08:31Z | `CONTENT_SAFETY_RATE_LIMIT` null → 4 | `experiment_period_boundaries` |

The two registered boundaries give three periods (P1, P2, P3). They are reported next to the whole window and are never pooled
silently. The other five are used only in a sensitivity analysis that stratifies by all 8 periods.

## Readings at the n reached (descriptive; no verdict follows from them)

Amendment 1 does not run the registered test when an arm misses the target. The numbers below are reported so the stop is not
mistaken for "no data". They are **not** the registered analysis and they decide nothing.

### Per arm

| Arm | Goals | Verified | Rate (Wilson 95 %) | Regressed | Infra failed | No change | Out of scope | Tokens per run, known (n) | Graded mean (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 current | 135 | 83 | **0.615** (0.531–0.693) | 35 | 16 | 1 | 1 (0.007) | 648 628 (112) | 0.525 (77) |
| 1 STE | 99 | 57 | **0.576** (0.477–0.668) | 24 | 16 | 2 | 0 (0.000) | 681 231 (86) | 0.456 (52) |

### Endpoints, STE − current

| Endpoint | STE | Current | Difference (Newcombe 95 %) | Two-proportion z, p | Fisher exact p |
| --- | --- | --- | --- | --- | --- |
| Primary: verified rate (ITT) | 57/99 | 83/135 | **−0.039** (−0.165 to +0.086) | z −0.60, p 0.547 | 0.590 |
| Secondary: out-of-scope share (`gate:auto_approved_scope:fail`) | 0/99 | 1/135 | −0.007 (−0.041 to +0.030) | z −0.86, p 0.391 | 1.000 |
| Regressed rate (not registered) | 24/99 | 35/135 | −0.017 (−0.126 to +0.098) | p 0.770 | 0.879 |
| Secondary: tokens per run (known only, Amendment 2) | 681 231 | 648 628 | +5.0 % | | |

The out-of-scope endpoint has 1 event in 234 outcomes, so it cannot show a difference at any n this experiment could reach.

### Per period (Amendments 2 and 3)

| Period | n | STE | Current | STE − current (Newcombe 95 %) |
| --- | --- | --- | --- | --- |
| P1 10-11 → 10-27 05:52 (memory rules on) | 126 | 34/56 | 47/70 | −0.064 (−0.228, +0.101) |
| P2 10-27 05:52 → 11-08 00:00 (rules off, siblings on) | 65 | 16/25 | 17/40 | +0.215 (−0.033, +0.426) |
| P3 11-08 00:00 → stop_by (siblings off) | 43 | 7/18 | 19/25 | −0.371 (−0.595, −0.074) |

With period as a stratum (exact stratified permutation, Mantel–Haenszel risk difference): registered periods p 0.588, RD −0.045
(−0.174, +0.084). All 8 periods: p 0.594, RD −0.031 (−0.163, +0.101). The periods disagree in sign: P2 leans toward STE and P3 against
it. P3 is the only period whose interval excludes 0. Its gap is mostly infra failures (STE 7 of 18, current 4 of 25). Settled-only
in P3 it is 7/11 vs 19/21. P3 is a small, late period, and it was not a registered endpoint on its own.

### Sensitivity (exploratory)

| Variant | STE − current | p |
| --- | --- | --- |
| Outage-fallback outcomes counted (137 / 100, the reading under which arm 1 reaches 100) | 57/100 vs 84/137: −0.043 (−0.168, +0.082) | z p 0.504, Fisher 0.507 |
| ITT incl. 11 assigned runs without an outcome (4 / 7), counted not verified | 57/106 vs 83/139: −0.059 (−0.182, +0.065) | z p 0.352 |
| Stratified by lane | MH RD −0.047 (−0.164, +0.070) | exact 0.555 |
| Stratified by ACE-001 arm | MH RD −0.038 (−0.166, +0.091) | exact 0.583 |

By lane (descriptive): exports +0.017 (34/42 vs 42/53), mutation −0.023 (16/44 vs 24/62), test-gap −0.312 (7/13 vs 17/20; one of three
lane cells, not adjusted).

**What the registered analysis would have said under the other count.** This is a counterfactual and not a verdict. If the fallback
outcomes counted, arm 1 would be at 100, and the registered test would show STE not better on the primary endpoint (−4.3 points,
p 0.50). The out-of-scope share would be 0/100 vs 1/137: lower as a point estimate, but not significantly. The falsifier needs STE
"not better on the primary endpoint **and** not lower on the out-of-scope share". If "lower" means the point estimate, that is not
met. If it means significantly lower, it is met. Adoption needs a significant primary gain or a significant out-of-scope reduction,
and is not met under either reading. So both counts lead to the same practical outcome: **no adoption**.

## Decision under the registered rules

- **Stop rule (Amendment 1).** At stop_by arm 1 was at 99 of 100. Not every arm reached the target. So the experiment **stops at the
  n reached and is recorded INSUFFICIENT_EVIDENCE**. The registered test did not run. This is not a "no effect" finding.
- **No extension.** The protocol prescribes none ("a new version needs a new registration"). stop_by is unchanged.
- **Verdict: INSUFFICIENT_EVIDENCE.** The registry records this as `STE_001_CLOSED` (`INSUFFICIENT_EVIDENCE (target 100/arm not
  reached by stop_by: arm 0 135, arm 1 99)`, decided 2026-11-14). The learning ledger reads it as INSUFFICIENT for `maker_template`.
  The `experiment:STE-001` stall clears.
- **No negative-evidence entry.** The result is neither falsified nor negative. An NE entry would claim more than the protocol allows.
- **Adoption: not met.** The STE template does not become the default. The adoption rule needs a significant primary gain or a
  significant out-of-scope reduction with no primary loss. At the n reached the primary difference is −3.9 points with p 0.55, and the
  out-of-scope share has 1 event.
- **What this says.** At 234 goals the data are compatible with anything from about −16 to +9 points on the verified rate. The
  protocol expected a small effect, below the about 20 points that 100 per arm could detect. Its own text says such a result "will most
  likely end inconclusive".

## Implied action (not taken here; operator decision)

1. **Turn `STE_001_MODE` off** (runtime.env, idle recreate). The experiment has stopped, so continuing to randomise serves no
   registered purpose. Adoption was not reached, so the default stays today's `MAKER_TEMPLATE_RULES`. With the flag off every goal
   gets the arm 0 template, which is today's template (`makerTemplateRules` returns it for any run without an STE arm).
2. Turning it off changes the maker template of about half the oracle-lane goals. That is a period boundary for the other open
   oracle-population experiments (ACE-001 until its readout closes, MAKER-DEPS-001, F2). This PR declares `STE_001_MODE` in their
   `treatment_env`, so the boot after the switch writes those boundary rows itself.
3. A follow-up STE study would need a new registration. Some input for it: the out-of-scope endpoint has almost no events (1 in 234)
   and cannot carry the hypothesis. The arm hash split this population 58 / 42. The P2/P3 sign change suggests that the effect
   depends on context changes, which a per-period design would have to plan for.

## Limitations

- The target count excludes outage-fallback outcomes. The protocol does not say this; Amendment 1's accrual figures and the registry
  do. Under the other count arm 1 is at exactly 100, but the conclusion (no adoption) is the same.
- The window spans 7 recorded context changes. The late periods are small (1 to 33 goals), so per-period estimates are imprecise.
  After 10-27 the memory rules were off for both arms. After 11-08 sibling makers were off, and `MAKER_SCOPE_REPAIR` restores
  out-of-scope `package.json` and lockfile changes. Both bear on the out-of-scope reading.
- About half of the analysed goals also carried an ACE-001 treatment (orthogonal by design). ACE-001 read out as not beneficial
  (ACE-001_RESULT.md, PR #1260). The STE contrast stratified by ACE arm matches the crude one.
- The primary endpoint is the production gate set plus checkers. There is no held-out oracle. Graded scores exist for 129 of 234 runs,
  a lane-skewed subset, and are descriptive only.
- The two-proportion test and the Fisher test agree everywhere here. The protocol names both ("or Fisher exact") without picking one.
