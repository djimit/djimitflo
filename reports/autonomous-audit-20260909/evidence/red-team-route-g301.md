# Red-team assessment route proof — G301

The authenticated local HTTP fixture runs the complete deterministic red-team assessment, persists the report, and reads it back through `/red-team/latest` and bounded `/red-team/history`. All 12 configured attack vectors are blocked by the supplied governance fixture (`blocked=12`, `missed=0`, `overallScore=1`). Focused route coverage passes 3/3, including malformed history limits from the existing pagination test.

This proves local red-team orchestration and persistence only; it does not certify production controls, real provider behavior or an external security assessment.
