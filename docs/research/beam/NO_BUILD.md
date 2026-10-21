# BEAM-001: explicit no-build / no-change recommendations

BEAM-001 covered Phases 0–4 plus a Phase 5 design. It was read-only by directive. The list below says what should **not** be built or changed on the basis of this study, and why. Each item is tagged with its evidence type.

## Do not change in prod

1. **Do not register `beam:cloud` in `/srv/djimitflo/opencode.json`, and do not set `DJIMITFLO_OPENCODE_MODEL` to Beam.** No arm has been run. A prod arm would compete for the ~4 verified per day that the running experiments (ACE-001, STE-001, F2 v2, MAKER-DEPS-001, memory holdout, R2) share, and it would create a period boundary in all of them (FACT: BOTTLENECKS B8). Any Beam work goes in a throwaway container with its own opencode.json, mounted `:ro`.
2. **Do not change `CHECKER_CROSS_MODEL`.** F2 v2 (gemma4 cross arm) is running. A swap invalidates it (FACT: checker-family.ts:217, v2 salt).
3. **Do not use Beam as an outage failover tier.** It sits on the same Ollama account and the same weekly limit as glm-5.2 (FACT), so it adds no redundancy.
4. **Do not route the panel, refinement, reflection, Commons residents or Frontier Experts to Beam.** These roles have no executable verifier and no measured value (FACT: panel Brier 0.33; refinement 0/57; reflection 1/319). A better model there cannot be measured. Simplifying or pausing them is the separate operator decision.
5. **Do not touch TG-001, Gates A–D, paused discovery, or any privilege.** Out of scope by directive.

## Do not build

6. **No Beam-specific Harmony parser or adapter.** Ollama already turns Beam's modified-Harmony/XML tool syntax into OpenAI `tool_calls` and a separate reasoning field (FACT, probes 4/5/7), and our `model-json.ts` already handles reasoning output.
7. **No local Beam serving** on the workstation, Mac mini or VPS. 501B weights (NVFP4 ≈ 0.25–0.3 TB) do not fit, and the VPS must never call the workstation (FACT/INFERENCE).
8. **No reasoning-effort plumbing to opencode (`--variant`) yet.** First, Stage 0 has to show that effort control reaches Beam through opencode. The OpenAI-path `reasoning_effort` showed no token effect in probes 2/9 (n = 1 each; INFERENCE, weak).
9. **No consolidation of the checker and security checker** into one call, with Beam or any other model. It fails consolidation condition 3: an independent security control must stay (SUBSTITUTION_MATRIX).
10. **No new orchestration layer, router, registry or "model zoo" entry** for Beam. There is no caller that needs one (Ponytail rule; FACT: the runtime bandit chooses only runtimes).
11. **No distillation or self-distillation pipeline from Beam** before the G6.1 dataset readiness check (20-11) says READY. Reflection's Usage Policy also has to be read first, because the model card defers to it (UNKNOWN).
12. **No Stage 2 run** (≈ 350 M tokens) on the legacy weekly-limited Ollama plan without one of the spend conditions in EXPERIMENT_PROPOSAL §5 (FACT: the weekly limit was hit on 18-10).

## Do instead (outside BEAM-001; listed so the bottleneck ranking stays honest)

- **B2 supply:** G1.4 cap steps, the second repo (operator token), the finding-fix lane shadow → on.
- **B1 merge:** LOOP_PR_BODY_V2 plus the operator-minutes metric. Widen auto-merge only on survival n ≥ 100.
- **B3 maker failures:** let MAKER-DEPS-001 read out.
- **B6 €:** the operator fills `docs/usage-plan-limits.json` monthly_eur. Until then, no model-cost claim in € is possible.
- **B5:** the Ollama plan choice (credit plan vs legacy weekly limit) is the operator's.
