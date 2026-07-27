# Design

## Runtime evidence

`RuntimeCommandService` parses line-delimited JSON output. Agent messages and
tool output are retained as content but cannot create blocking warnings.
Explicit warning/error events and stderr diagnostics carry `source` and
`event_type` provenance.

Maker execution records one disposition:

- `changed`: a non-empty git diff exists;
- `no_change_required`: stdout contains an explicit structured disposition and
  non-empty reason;
- `failed`: neither condition is satisfied or another gate fails.

A no-change maker cancels its unused checker lease. Verification accepts the
evidenced no-change disposition without pretending that a patch was reviewed.

## SEGML drafts

SEGML resolves failed case IDs against the exact corpus recorded by the
OpenMythos run. It refuses case generation when the original prompt,
expected behavior or rationale cannot be recovered. Generated cases stay in
`segml_generated_cases`; the direct corpus append path is removed.

The cycle may generate drafts and observations. It may not mutate the benchmark
and judge rubric in the same promotion decision. Canonical promotion continues
through the existing repeated baseline/candidate and holdout workflow.

## Calibration

Self-analysis reports the method and confidence of heuristic findings. File
length is a size signal, not complexity. Judge evaluation of maker output is a
future shadow experiment: no enforcement is introduced until outcomes prove
incremental predictive value over deterministic checks and checker verdicts.
