# BEAM-001 Phase 4: substitution matrix

There are three ways to change each role:

- **A. Model swap.** Same workflow, a different model.
- **B. Workflow simplification.** Fewer steps, calls or stages, same model.
- **C. Specialist consolidation.** Several roles become one.

**Consolidation conditions.** C is allowed only when all of these hold:

1. Each original role keeps a frozen, labelled slice, and the merged role is non-inferior on every slice (pre-registered margin).
2. Independence is preserved. The verifier is either deterministic or a model family different from the maker in the same run. The maker and the checker never become the same call.
3. No security or policy control is removed or weakened. That covers the security checker, deterministic checks, scope and diff gates, the auto-merge audit sample, signed fleet events, content safety and the human merge gate.
4. The cost reduction is measured in tokens (and in € once G0.3 has prices), not assumed.
5. There is a rollback flag and a pre-registered stop rule.

**Tags.** FACT, INFERENCE, HYPOTHESIS, UNKNOWN.

## Matrix

| Role (current model) | A: swap to Beam | B: workflow simplification | C: consolidation | Recommended |
|---|---|---|---|---|
| **opencode maker** (glm-5.2) | Plausible. API-compatible (probes 4/5/7, FACT); vendor parity on Terminal Bench (VENDOR_CLAIM); token-efficiency claim untested on our tasks; runs at `max` effort through opencode (FACT). Expected Δ verify ±10 pt, Δ tokens 0 to −30 % (HYPOTHESIS) | **Stronger case:** environment bootstrap causes most brake and timeout failures (DI-001, FACT) → MAKER-DEPS-001 (running); step caps; more share to the workstation species (0 cloud tokens) | None. The maker must stay separate from the checker | **A: INSUFFICIENT_EVIDENCE.** Run the offline paired test (A0–A3). B is in prod already |
| **LLM checker** (glm-5.2 same arm, gemma4 F2 v2 cross arm) | Possible as a **cross-family** checker (Beam ≠ GLM family). Swapping now would invalidate F2 v2 (FACT, checker-family.ts:217). Discrimination headroom is small (F1 AUC 0.95) | Bounded reviewer strategy (built, off); inline check logs (reduces `insufficient_evidence`) | **Rejected:** checker + security checker into one call fails condition 3 (security control) unless SEC-F1 and a general slice both show non-inferiority. F1 case files must be re-frozen first | **HOLD** until F2 v2 reads out; Beam only as an offline challenger |
| **Security checker** (glm-5.2) | Challenger only. SEC-F1 glm-5.2 is at 19/20 and 0/26 FR (FACT), so Beam can tie, lose, or save tokens | Fix or retire the dead manual security_checker lease (0/263, FACT). That is orchestration, not a control | **Never** merged away (independent security control) | **HOLD**. Offline SEC-F1 slice is the smallest experiment |
| **Panel review** (gemma4 + residual kimi-k3) | No value case. The panel shows no discrimination (Brier 0.33, FACT) | **Subtract:** oracle lanes already skip it. Pause or limit to non-oracle lanes; find the source of the 42 kimi-k3 calls in 7 d (UNKNOWN) | Could fold into jev prescreen only with labels (NE-001 forbids jev for approval) | **REJECT A**; B is the operator's call |
| **Refinement / reflection** (gemma4) | No. 0/57 and 1/319 verified (FACT); no verifier | **Subtract** or pause until a verifier exists | — | **REJECT** |
| **Commons residents / Frontier Experts** | No. Off or no consumer | Keep off | — | **REJECT** |
| **Workstation maker** (atomic@llama-router) | Infeasible. 501B does not fit the workstation, and the VPS must not call the workstation (FACT/INFERENCE) | — | — | **REJECT** |
| **Outage failover tier** (Claude subscription) | No. Beam is on the same Ollama account and fails together (FACT) | Calibrate the throttle; switch plan (operator) | — | **REJECT** |
| **jev, content safety, embeddings** | No. Different model class (FACT) | — | — | **REJECT** |
| **Future local maker training (G6)** | As a **teacher**: the Apache-2.0 licence and model card allow distillation (FACT; Usage Policy unread → UNKNOWN). Needs G6.1 dataset readiness (20-11) and offline LoRA. Self-distillation recipe announced (VENDOR_CLAIM) | — | — | **HOLD** until G6.1 says READY |

## What a winning swap must show (all of these)

1. Verified rate on the paired frozen slice is non-inferior to A0 at the pre-registered margin.
2. Tokens per verified are lower, with the CI excluding 0.
3. No new failure class (tool-loop, parser or Harmony artefacts) above 5 %.
4. On the checker slice, no loss of discrimination (SEC-F1 catches and false rejects).
5. The weekly-limit weight is observed on the Ollama usage page and is not worse.

**INFERENCE.** Even a full win on the maker is capped by B6. Model spend is about $0.40 list-equivalent per verified change, against operator time and flat subscriptions. A swap also does nothing for B1 (human merge) or B2 (supply), which are the binding limits.
