# Specification — AGI Cognitive Evolution (Level-7)

## Functional Requirements

### Metacognitive (G35-G37)
- FR-01 System SHALL track per-capability confidence calibration (Platt scaling, min 3 runs)
- FR-02 System SHALL detect known unknowns (calibration_error > 0.2 or nRuns < 3)
- FR-03 System SHALL detect performance trends (improving/stable/degrading)
- FR-04 System SHALL persist calibration snapshots
- FR-05 System SHALL retrieve similar past runs (≥ 3) for new goals
- FR-06 System SHALL inject retrieved experience into maker/checker context
- FR-07 System SHALL select runtimes using calibrated confidence
- FR-08 System SHALL fall back to conservative defaults when n < 3

### Epistemic (G38-G39)
- FR-09 System SHALL verify source quality (≥ 2 sources, not all aged > 90 days)
- FR-10 System SHALL verify logical consistency (no contradicts edges)
- FR-11 System SHALL verify perspective coverage (≥ 2 types OR dissent)
- FR-12 System SHALL verify falsifiability (testable claims OR hypothesis)
- FR-13 Epistemic gates SHALL be advisory for low/medium risk, mandatory for high/critical
- FR-14 System SHALL support research-loop type with DeerFlow executor
- FR-15 Research output SHALL be written to OKF memory store
- FR-16 Research output SHALL create claim ledger entries

### Autonomy (G40-G42)
- FR-17 System SHALL distill reusable procedures from successful trajectories
- FR-18 Distilled procedures SHALL be written to OKF skills directory
- FR-19 Distilled procedures SHALL create capability candidates
- FR-20 System SHALL scan for information gaps every 6 hours
- FR-21 System SHALL publish capability_gap claims to KnowledgeBus
- FR-22 System SHALL generate autonomous goals from gaps/patterns/self-model
- FR-23 Autonomous goals SHALL never exceed 50% daemon capacity
- FR-24 Operator goals SHALL always preempt autonomous goals
- FR-25 All autonomous goals SHALL have explicit acceptance criteria

### Causal (G43-G44)
- FR-26 System SHALL build causal model from historical observations
- FR-27 System SHALL support counterfactual queries
- FR-28 Predictions SHALL include success rate, confidence, evidence count
- FR-29 System SHALL fall back to marginal probabilities when n < 5
- FR-30 System SHALL synthesize draft contracts from recurring gaps (≥ 3)
- FR-31 Draft contracts SHALL NOT route without human approval

## Non-Functional Requirements

- NFR-01 Calibration refresh < 30 seconds for 1000 runs
- NFR-02 Experience retrieval < 5 seconds (Qdrant timeout)
- NFR-03 Epistemic gate evaluation < 10 seconds per gate
- NFR-04 Curiosity scan < 60 seconds
- NFR-05 All existing 92+ tests remain green (no regression)
- NFR-06 Each new service has ≥ 15 automated tests
- NFR-07 Graceful degradation when optional services fail
- NFR-08 All migrations backward-compatible (additive only)
- NFR-09 Autonomous goals clearly labeled in dashboard
- NFR-10 All autonomous decisions logged with full provenance
