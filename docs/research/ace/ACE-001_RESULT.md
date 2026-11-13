# ACE-001: retrieval × skill selection, result (2026-11-13)

Registration: [ACE-001_PROTOCOL.md](ACE-001_PROTOCOL.md) with Amendments 1 to 5. Registry entry: `experiment-registry.ts` `ACE-001`
(started_at 2026-10-12T00:00Z, target 50 per arm, stop_by 2026-11-15). The readout ran once. It is read-only: no flag, assignment or
data was changed. `ACE_001_MODE` is still `on` in production.

## Why the readout is due now

- The protocol says "Analysis (at 50 per arm, once)". Amendment 2 only adds a deadline: at stop_by the analysis runs if every arm
  has the target, and otherwise the experiment stops as INSUFFICIENT_EVIDENCE. It does not move the readout to stop_by.
  `ace001Evidence` follows the same rule (`readout = every arm at target || now >= stop_by`).
- Unit: the protocol counts goals ("50 per arm (200 goals)"), and the arm is assigned per goal. The evidence function counts maker
  outcomes. In the window there is exactly **one maker outcome per goal** (230 outcomes, 230 distinct goals), so the two counts are
  the same.
- **Readout instant: 2026-11-11T11:30:24.323Z.** At this moment arm 01, the last arm to fill, recorded its 50th goal. The other
  arms had passed 50 earlier: 10 on 11-03, 00 on 11-04, 11 on 11-08. The registered analysis uses the outcomes created in
  [ACE_001_ANALYSIS_SINCE, readout instant]. `ACE_001_ANALYSIS_SINCE` is not set in production, so its default
  2026-10-12T00:00:00Z applies (Amendment 1). The 6 outcomes created between the readout instant and the data pull
  (2026-11-13T10:57Z) are reported as a sensitivity analysis only.

## Data

- Prod `/data/djimitflo.sqlite`, opened `readonly: true` with `query_only`, at 2026-11-13T10:57:10Z, through the deployed image
  `84a12010`. Script: [`ACE-001_readout.mjs`](ACE-001_readout.mjs). Output: [`ACE-001_readout-20261113.json`](ACE-001_readout-20261113.json).
- Population: production maker outcomes (`loop-maker:*`, not gym) that carry `ace-001-arm:<RS>`. Excluded, as `ace001Evidence` does:
  2 outcomes from before the analysis window (`delivery_invalid`) and 3 outcomes on the Ollama outage fallback. **Analysed: 227 goals.**
- Lanes: exports 94, mutation 100, test-gap 33. Memory-holdout stratum, as recorded on the run's assignment: rules 90,
  withheld 40, and none 97. "None" means after 2026-10-27T05:52:42Z, when memory rules were off for every arm.
- **Integrity.** The stored arm equals `sha256('ace-001:' + goal id) mod 4` for all 230 goals in the window, and the assignment's
  `ace_001.arm` equals the outcome's arm for all of them. Arm sizes 62 / 50 / 58 / 57 (χ² vs equal, p 0.73). The exports lane
  is unbalanced (00 has 36 goals, the other arms 18 to 21; χ² p 0.03, one of three lanes tested). The same imbalance exists in
  the hashed population of all oracle goals created in the window (37 / 19 / 22 / 20), so it comes from the assignment itself,
  not from attrition. Lane is a registered stratum, so the primary test adjusts for it.
- **Delivery (Amendment 1).** Using the latest assignment per run in the window, retrieval was delivered on **123 of 123** treated
  runs and examples on **115 of 115**, with 0 fallbacks. The rule "pause if delivery < 0.8 after 20 treated runs" never applied.
- **Safety stop.** From 20 goals per arm on, the largest cumulative gap in regressed rate between a treated arm and control was
  **+16.8 points** (arm 10, 2026-10-23: 9/26 vs 5/28). That is below the registered 20 points, so no arm was ever stopped.

### Period boundaries

| at (UTC) | what | source |
| --- | --- | --- |
| 2026-10-27T05:52:42Z | `LOOP_MEMORY_RULES_ENABLED=false` | Amendment 4 (registered) |
| 2026-11-05T19:58Z | maker prompt change | operator plan (EXP-2_RESULT.md), no DB row |
| 2026-11-06T13:35:44Z | `SKILL_ROUTE_MODE` null → shadow | `experiment_period_boundaries` |
| 2026-11-07T12:00:09Z | `OPENCODE_BRAKE_CACHE_READ_WEIGHT` null → 0.1 | `experiment_period_boundaries` |
| 2026-11-08T00:00:02Z | `LOOP_EVOLVE_ENABLED=false` (siblings off) | Amendment 5 (registered) |
| 2026-11-08T02:32:21Z | `MAKER_SCOPE_REPAIR` null → on | `experiment_period_boundaries` |
| 2026-11-09T00:08:31Z | `CONTENT_SAFETY_RATE_LIMIT` null → 4 | `experiment_period_boundaries` |

Amendments 4 and 5 register two boundaries. They give three periods (P1, P2, P3), which are reported next to the whole-window
analysis and never pooled silently. The other five boundaries come from the registry's A18 rows or the operator plan. They are
used only in a sensitivity analysis that stratifies by all 8 periods.

## Result

### Per arm (registered window, readout instant)

| Arm | R | S | Goals | Verified | Rate (Wilson 95 %) | Regressed | Infra failed | No change | Graded mean (n) | Tokens per run, known (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 00 control | 0 | 0 | 62 | 43 | **0.694** (0.570–0.794) | 13 | 5 | 1 | 0.454 (39) | 730 804 (51) |
| 01 | 0 | 1 | 50 | 31 | **0.620** (0.482–0.741) | 15 | 4 | 0 | 0.442 (25) | 612 757 (44) |
| 10 | 1 | 0 | 58 | 33 | **0.569** (0.441–0.688) | 16 | 9 | 0 | 0.537 (33) | 603 552 (50) |
| 11 | 1 | 1 | 57 | 32 | **0.561** (0.433–0.682) | 14 | 9 | 2 | 0.564 (30) | 690 092 (47) |

### Primary: main effects, exact permutation test stratified by lane × memory-holdout (as registered)

The primary endpoint is the goal's proposal reaching `verified`. Every analysed goal is in the denominator (ITT; vector fallbacks
would stay in their arm, and there were none). The test permutes arm labels within the 9 lane × holdout strata. For one factor,
the exact null distribution of "verified among factor-on" is the convolution of the per-stratum hypergeometrics. The two-sided p
is P(|difference| ≥ observed). A Monte Carlo check, which permutes the four arm labels within strata 100 000 times with a fixed
seed, agrees.

| Factor | on verified / goals | off verified / goals | Difference on − off (Newcombe 95 %) | Exact stratified p | MC check p |
| --- | --- | --- | --- | --- | --- |
| **R** (KB retrieval) | 65/115 = 0.565 | 74/112 = 0.661 | **−0.095** (−0.218 to +0.031) | **0.327** | 0.325 |
| **S** (similarity examples) | 63/107 = 0.589 | 76/120 = 0.633 | **−0.045** (−0.169 to +0.081) | **0.771** | 0.773 |

The CI method is not registered. The descriptive stratified estimate is the Mantel–Haenszel risk difference over the same
strata: R −0.037 (−0.155 to +0.081), S +0.034 (−0.085 to +0.153). The crude and stratified estimates differ because of the
exports imbalance: control holds the most exports goals, and exports is the lane with the highest verified rate. Every
interval includes 0.

### Secondary: logistic regression `verified ~ R + S + R:S + lane + holdout` (as registered)

| Term | OR (95 % CI) | Wald p |
| --- | --- | --- |
| R (at S = 0) | 0.74 (0.32–1.67) | 0.46 |
| S (at R = 0) | 0.88 (0.37–2.08) | 0.78 |
| R:S (exploratory at this n) | 1.20 (0.37–3.90) | 0.77 |
| lane mutation vs exports | 0.18 (0.09–0.35) | < 0.001 |
| lane test-gap vs exports | 0.72 (0.27–1.90) | 0.51 |
| holdout: rules withheld vs rules | 1.04 (0.45–2.44) | 0.92 |
| holdout: rules off (from 10-27) vs rules | 0.94 (0.48–1.84) | 0.86 |

### Per period (Amendments 4 and 5)

| Period | n | 00 | 01 | 10 | 11 | R: on − off (Newcombe 95 %) | S: on − off (Newcombe 95 %) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 10-12 → 10-27 05:52 (memory rules on) | 130 | 23/35 | 22/30 | 23/37 | 15/28 | −0.108 (−0.264, +0.057) | −0.001 (−0.165, +0.159) |
| P2 10-27 05:52 → 11-08 00:00 (rules off, siblings on) | 65 | 11/18 | 5/13 | 6/14 | 11/20 | −0.016 (−0.245, +0.215) | −0.046 (−0.273, +0.187) |
| P3 11-08 00:00 → readout (siblings off) | 32 | 9/9 | 4/7 | 4/7 | 6/9 | −0.188 (−0.455, +0.121) | −0.188 (−0.455, +0.121) |

The memory-holdout stratum already splits at the Amendment 4 boundary. With period added as a stratum (lane × holdout × P, 12
strata): R exact p 0.309, MH RD −0.040 (−0.157, +0.077). S exact p 0.834, MH RD +0.050 (−0.071, +0.171). With all 8 periods
(19 strata, sensitivity): R p 0.275, MH RD −0.047 (−0.167, +0.072). S p 0.868, MH RD +0.061 (−0.063, +0.184). No period
shows an effect that differs from 0.

### Safety and cost (decision-rule inputs)

| Factor | Regressed on vs off | Difference (Newcombe 95 %) | Scope-gate fail on vs off | Security-checker fail on vs off | Tokens per run, known (n), on vs off |
| --- | --- | --- | --- | --- | --- |
| R | 30/115 vs 28/112 | +0.011 (−0.102, **+0.123**) | 1/115 vs 0/112 (−0.025, +0.048) | 6/115 vs 1/112 | 645 483 (97) vs 676 129 (95): **−4.5 %** |
| S | 29/107 vs 29/120 | +0.029 (−0.083, **+0.143**) | 0/107 vs 1/120 (−0.046, +0.027) | 3/107 vs 4/120 | 652 699 (91) vs 667 808 (101): **−2.3 %** |

Scope-gate fail means `auto_approved_scope` or `objective_scope` failed. Tokens follow Amendment 3 (only runs with a known
usage report). The gate set was the same in every arm, as the test pins. The security-checker fail count under R (6 vs 1,
Fisher p 0.12) is exploratory and is not a registered endpoint.

### Other secondaries

- **Graded score** (mutant-kill share, 127 of 227 runs): R on 0.550 (63) vs off 0.450 (64). This is descriptive. Graded runs are a lane-skewed
  subset (exports 81, mutation 41, test-gap 5), so the comparison is not adjusted.
- **Skill reuse** (`skill_content_hash`): 33 / 45 / 30 / 51 distinct hashes over 62 / 50 / 58 / 57 runs (00 / 01 / 10 / 11). This
  is descriptive only.
- **Retrieval-use proxy** (did a verified diff touch the subject of an injected KB page or example?): **not computed.** No recorded
  field links a diff's files to a KB page's subject, and building that link after the fact would be a post-hoc measure.

### Sensitivity (exploratory; none changes the verdict)

| Variant | R on − off | S on − off |
| --- | --- | --- |
| All data to the pull (233 goals: 6 after the readout instant) | −0.107 (−0.227, +0.018), exact p 0.247 | −0.044 (−0.167, +0.080), exact p 0.738 |
| Settled only (verified ÷ verified + regressed, 197) | 65/95 vs 74/102: −0.041 (−0.167, +0.085), p 0.65 | 63/92 vs 76/105: −0.039 (−0.165, +0.087), p 0.82 |
| ITT incl. 11 assigned runs cancelled before any outcome (counted not verified) | 65/121 vs 74/117: −0.095 (−0.216, +0.030) | 63/113 vs 76/125: −0.050 (−0.173, +0.074) |
| Incl. the 3 outage-fallback outcomes | 66/117 vs 74/113: −0.091, p 0.36 | 64/109 vs 76/121: −0.041, p 0.81 |
| Strata lane (test-gap+exports vs mutation) × holdout | p 0.315 | p 0.649 |
| Unstratified | p 0.173 | p 0.499 |

By lane (descriptive): exports R −0.127 (−0.296, +0.037), S +0.021. Mutation R +0.033, S +0.088. Test-gap R −0.044, S −0.378
(−0.603, −0.073; 18 vs 15 goals, one of six lane cells, not adjusted for multiplicity).

## Decision under the registered rules

- **Promotion** needs all of: main effect > 0 with permutation p < 0.05; regressed and scope-failure rates not higher than
  control (upper 95 % bound of the difference ≤ 5 points); tokens per run up ≤ 20 %; gates and security results unchanged.
  - R: effect −9.5 points, p 0.33. **Not met.** The regressed upper bound is +12.3 points, also above 5. Tokens −4.5 % would pass.
  - S: effect −4.5 points, p 0.77. **Not met.** The regressed upper bound is +14.3 points, also above 5. Tokens −2.3 % would pass.
- **Falsification**: "H rejected for that factor if the effect's 95 % CI includes 0 at n = 50/arm". This holds for R and for S,
  under every interval computed here.
- **Verdict: REJECT for both factors (FALSIFIED in the protocol's terms). Neither KB retrieval nor similarity-chosen examples
  becomes the default maker context.** The registry records this as `ACE_001_CLOSED` (`FALSIFIED (R -9.5 pts p 0.33, S -4.5 pts
  p 0.77; neither factor promoted)`, decided 2026-11-13). Negative-evidence entry: NE-018.
- **What this does not say.** It is not a harm finding: every CI for both factors includes 0, so neither factor is shown to be
  worse than control. It is also not proof of zero effect. The protocol powered the test for a main effect of about 19 to 20
  points, which is larger than the effect a small benefit would produce. The upper bounds rule out a benefit above about
  +3 points for R (crude) or +8 points (stratified). For S they rule out a benefit above about +8 points (crude) or +15 points
  (stratified). The R × S interaction was registered as exploratory and is uninformative at this n.

## Limitations

- The S contrast is "similarity examples vs production K1", and K1 delivers no examples on most runs (Amendment 1). So S
  measures "2 similar verified tests vs mostly none", not a comparison of two ways to choose examples.
- The window spans 7 recorded context changes. Two are registered periods, and the late ones leave very small periods (1 to 22
  goals). Period-stratified estimates match the whole-window ones, but late-period estimates are imprecise.
- The memory-holdout factor ended with the memory-rules switch (10-27). After that its stratum equals the period, so the
  registered `holdout` term is partly a period term.
- One outcome (arm 11, 10-19) ran on a lease with `runtime_fallback` metadata but has no fallback tag. It is kept, as
  `ace001Evidence` does.
- No independent held-out task set, by design (protocol, "Not built in this experiment"). The oracle is the production gate set.

## Implied action (not taken here; operator decision)

1. **Turn `ACE_001_MODE` off** (runtime.env, idle recreate). The verdict is in, so continuing to randomise serves no registered
   purpose. With the flag off every goal gets the control context: arm 00 equals the ACE-off context, which a test pins.
2. Turning it off is a period boundary for the other open oracle-population experiments (STE-001 until its 11-14 stop, MAKER-DEPS-001,
   F2). This PR declares `ACE_001_MODE` in their `treatment_env`, so the boot after the switch writes those boundary rows itself.
   That way the switch does not have to be added to their protocols by hand, as the siblings-off switch had to be in Amendment 5.
3. The ACE-001 code (assignment, retrieval, delivery monitoring) can stay as dead code behind the off flag, or be removed later.
   NE-018 forbids promoting either factor on the strength of ACE-001. It does not forbid the code, so it lists no forbidden code
   pattern.
