# MAKER-DEPS-001 v1: amendment 3

The pre-registration is `MAKER_DEPS_001_PREREG.md`. Its sha256 is pinned in `MAKER_DEPS_001_PREREG.sha256`, so this amendment is a
separate file and the pre-registration is not edited. Amendments 1 and 2 are `MAKER_DEPS_001_AMENDMENT_1.md` and
`MAKER_DEPS_001_AMENDMENT_2.md`.

## Amendment 3 (2026-11-08): period boundary (evolve siblings off)

A period boundary is added to the analysis; verdict rules are unchanged.

- **Period boundary: 2026-11-08T00:00:02Z.** Evolve siblings were switched off in production at this instant
  (`LOOP_EVOLVE_ENABLED=false`, following the EXP-2 X1 result,
  `docs/research/intelligence-metrics/EXP-2_RESULT.md`; operator decision 2026-11-07 "siblings off").
  Until then an evolve-eligible oracle-lane goal in X1 arm `on` got sibling makers (`LOOP_EVOLVE_SPECIES`), and the fittest
  maker's patch, sometimes a sibling's, went to review. From then on no goal gets a sibling, so which maker's work reaches
  the checkers changed for both arms at once. The switch wrote no `experiment_period_boundaries` row, because
  `LOOP_EVOLVE_ENABLED` was not a declared treatment variable; it is one now (`experiment-registry.ts`
  `ORACLE_POPULATION_ENV`, with `LOOP_EVOLVE_SPECIES`), so a later change records its own boundary. The analysis reports
  goals created before and from this instant as two periods next to the registered whole-window analysis; the periods
  are never pooled silently.
- **Unchanged:** arms (parity of `sha256('maker-deps-001:' + goal_id)`), endpoints, target 141 per arm, stop_by 2026-12-16,
  the amendment 2 boundary, safety/harm stops, analysis and decision rules.
