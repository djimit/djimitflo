# Self-improvement evidence spine

## Problem

Djimitflo has evaluation, learning, trajectory, reflection and self-model
services, but production evidence does not flow reliably between them:

- SEGML reads a test-only `category_scores` column.
- Continuous learning reprocesses runs after every process or route instance.
- Self-model calibration substitutes an invented confidence when no prediction
  was recorded.
- The autonomous profile does not start the continuous learning lifecycle.
- Self-analysis truncates findings without reporting totals and over-counts
  dependencies.

## Outcome

Use the existing services as one evidence path:

`completed run -> curated episode/reflection -> self-model snapshot`

and:

`completed OpenMythos eval -> SEGML`

No new orchestrator, event bus, dependency or autonomous mutation path is
introduced.

## Acceptance

1. SEGML runs against the canonical migrated schema.
2. A fresh ContinuousLearningLoop instance does not reprocess old runs.
3. SelfModel distinguishes observed outcomes from recorded predictions.
4. Autonomous runtime starts and stops the existing learning loop.
5. Self-analysis reports candidate totals and actual import-statement counts.
6. Focused tests, type-check and full tests pass.
