# AGI Cognitive Evolution — Level-7 (Autonomous Build)

## Why

DjimFlo at Level-6 (`12ed5cba`) is runtime-adaptive, procedural, self-curating,
self-evaluating, and self-evolving. All G1-G34 are implemented and wired.
Production proof green on the workstation.

**The remaining gaps are cognitive, not operational.** The system cannot:
- Calibrate its own confidence ("I don't know" detection)
- Retrieve relevant experience from past runs
- Produce or verify non-code knowledge work
- Generate its own investigation targets
- Distill reusable procedures from successful trajectories
- Reason causally about its actions

## Thesis

DjimFlo becomes a **generally-capable, self-improving, knowledge-work-capable,
autonomously-growing** agentic OS when 10 cognitive capabilities are added in a
single autonomous build run — no human-in-the-loop between goals.

## What Changes

### G35 Self-Model Service
Per-capability, per-runtime confidence calibration with Platt scaling. "I don't know"
detection. Trend detection with statistical significance.

### G36 Experience Retrieval
Embed loop run objectives in Qdrant. Retrieve top-5 similar past runs for context
injection into new goals.

### G37 Calibrated Runtime Selection
`selectRuntime` uses calibrated confidence instead of raw success_rate. Conservative
fallback when data is insufficient.

### G38 Epistemic Gates
source_quality, logical_consistency, perspective_coverage, falsifiability gates
alongside existing deterministic/checker/security gates.

### G39 Research Loop
New `research-loop` type with DeerFlow executor. First non-code loop type with
epistemic verification.

### G40 Skill Distillation
Extract reusable procedures from successful maker trajectories. Write to OKF.
Create capability candidates.

### G41 Curiosity Service
Periodic gap detection → capability_gap claims → autonomous investigation goals.

### G42 Goal Formation
Generate goals from patterns, information gaps, and self-model weaknesses. Max 50%
daemon capacity for autonomous goals.

### G43 Causal Inference
Observational causal model of (runtime, capability, goal_type) → outcome.
Counterfactual queries.

### G44 Adaptive Self-Modification
Meta-evolution v2 synthesizes draft loop contracts from recurring gaps. Draft →
candidate → validated lifecycle.

### G45 Ship Gate
Full production proof with all G35-G44 active. Final human validation.

## Execution Model

**ALL goals G35-G44 are built in a single autonomous run.** Each goal is a concrete
coding task with automated acceptance criteria. No human approval is required between
goals. The only human interaction is at G45 (ship gate) where the operator validates
the final production proof.

This is consistent with how Level-5 and Level-6 were built: each goal was a concrete
coding task executed sequentially by a sub-agent, with validation via automated tests.

## Guardrails

- No auto-merge, push, or deploy (existing policy).
- No unattended high-risk execution (existing policy).
- Autonomous goals capped at 50% of daemon capacity.
- Draft loop contracts cannot route live workers without human approval.
- All new services inherit existing authorization middleware.
- Each goal has ≥ 15 automated tests that must pass before proceeding.

## Non-Goals

- No claim of "consciousness" or "sentience."
- No full AGI in the academic sense.
- No multi-modal perception (deferred to Level-8).
- No cross-instance federation (deferred to Level-8).

## Success Criteria

All automated tests pass. Production proof green. The system demonstrates:
- Calibration error < 0.15 after 10+ runs
- Experience retrieval similarity > 0.9 for identical objectives
- Research loop produces synthesis with ≥ 3 cited sources, all epistemic gates pass
- ≥ 1 distilled procedure after 5 successful maker runs
- ≥ 1 autonomous goal generated per day when gaps exist
- Causal predictions > 60% accuracy after 20+ runs
