# Design

## Decisions

- Read OpenMythos category scores from `metadata.category_scores`, where the
  evaluator already persists them. `categories_json` remains the requested
  category filter.
- Persist the learning watermark inside each existing `learning_cycles`
  result. The latest cycle is the source of truth across instances.
- Read predicted confidence from the canonical worker-lease `metadata` object.
  Legacy test schemas with a `confidence` column remain readable.
- Calibration error is `null` when there are no prediction/outcome pairs.
  Outcome success rate and its Wilson 95% interval remain available.
- Start one ContinuousLearningLoop only in the autonomous runtime profile and
  register it with the existing lifecycle manager.
- At successful knowledge closure, atomically materialize one trajectory
  outcome per explicitly attributed maker lease and one cognitive episode.
- Keep self-analysis heuristic, but label candidates and expose uncapped counts.

## Non-goals

- No new scheduler, message bus, model trainer or self-modification mechanism.
- No inferred skill attribution.
- No production deployment or mutation of the workstation checkout.
