# EXP-3 — memory holdout: result (2026-10-27)

Registration: [EXPERIMENT_PROTOCOL.md#exp-3](EXPERIMENT_PROTOCOL.md#exp-3), stop condition from the 2026-10-19 amendment
(target 30 outcomes per arm, stop_by 2026-10-27T00:00Z). Both arms reached the target, so the registered analysis ran once,
as written. Nothing was looked at in between except the registry's display line.

## Data

- Window: assignment contexts created 2026-10-08T00:00Z – 2026-10-27T00:00Z, proposals settled verified or regressed.
- Read-only on `/data/djimitflo.sqlite` (script `EXP-3_readout.js`, output `EXP-3_readout-20261027.json`).
- Attribution adjustment as registered: a maker failure counts as a failure; regressions attributed to the reviewer or the
  environment are excluded (11 runs). Runs on the Ollama outage fallback are excluded (3), as in the evidence builder.
- The 2026-10-11T04:16Z – 2026-10-12T16:43Z recovery window is lost data (see RECOVERY-2026-10-12.md); it affects both arms.

## Result

| Arm | Verified | Regressed | Rate |
| --- | --- | --- | --- |
| Rules injected | 66 | 22 | 0.75 |
| Rules withheld | 34 | 8 | 0.81 |

By lane: mutation 16/31 vs 13/18, test-gap 50/57 vs 21/24.

Cochran–Mantel–Haenszel by lane: common odds ratio (rules vs withheld) **0.60**, χ² (continuity-corrected) 0.70, two-sided
p 0.40; one-sided p (rules better) 0.86.

**Unit of analysis (audit finding L-F02).** The registration counts runs. A goal-clustered sensitivity (one unit per goal,
since the arm is assigned per goal) gives the same table here: every goal in the window had exactly one settled run, and no
goal had runs in both arms. So the run-level analysis is not inflated in this window.

## Decision under the registered rules

- **Falsifier met:** at the horizon the rules arm is not above the withheld arm (0.75 vs 0.81, OR 0.60). The registration
  says: stop injecting rules and keep the simpler baseline.
- **Not a harm finding:** the harm stop needs one-sided p < 0.01 for the withheld arm; here p ≈ 0.14 (1 − 0.86), so this is not
  evidence that rules hurt.
- **Not evidence of "no effect":** at about 30–90 per arm the power for a 15-point effect is low (amendment 2026-10-19).
  The result is: no measured benefit, point estimate against rules.

Acting on the falsifier (turning `LOOP_MEMORY_RULES_ENABLED` off) changes what every maker receives and therefore adds a
period boundary to ACE-001, STE-001, MAKER-DEPS-001 and F2 v2. That is an operator decision, recorded separately.
