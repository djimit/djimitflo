# G200 — documentation-scan workspace-root repair

`AutonomousDocsService` now uses the shared repository-root resolver. The focused route test proves `docs/scan` and `docs/stats` discover real source gaps from the npm workspace launch context; the post-change server suite passes **2485/20** with no failures.
