# MAKER-DEPS-001 v1: amendment 2

The pre-registration is `MAKER_DEPS_001_PREREG.md`. Its sha256 is pinned in `MAKER_DEPS_001_PREREG.sha256`, so this amendment is a
separate file and the pre-registration is not edited. Amendment 1 is `MAKER_DEPS_001_AMENDMENT_1.md`.

## Amendment 2 (2026-10-27): period boundary

A period boundary is added to the analysis; verdict rules are unchanged.

- **Period boundary: 2026-10-27T05:52:42Z.** Memory rules were switched off in production at this instant
  (`LOOP_MEMORY_RULES_ENABLED=false`, following the EXP-3 memory-holdout result). From then on no maker in either arm receives
  memory rules, so the maker context changed for both arms at once. The analysis reports goals created before and from this
  instant as two periods next to the registered whole-window analysis; the periods are never pooled silently.
- **Unchanged:** arms (parity of `sha256('maker-deps-001:' + goal_id)`), endpoints, target 141 per arm, stop_by 2026-12-16,
  safety/harm stops, analysis and decision rules.
