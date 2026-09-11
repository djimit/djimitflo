# G261 meta-orchestration route permissions

The shared `/meta` route factory now enforces explicit evidence-read permission on `GET /stats`, `GET /tuning/:goalType`, `GET /tuning-history`, `GET /routing/:taskType`, `GET /strategy/:goalType`, and `POST /predict`. `POST /tuning/run` retains the governance-write guard. The route is mounted with production authentication middleware.

Focused Express HTTP role-permission tests passed: 2 files, 8 tests, 0 failures. The fixture uses the canonical shared role-permission map, confirms evidence reads for viewer and governance denial for every non-admin role, and confirms the admin tuning path is admitted. No unauthorized service mutation is claimed from this boundary.

`MetaOrchestrationService.runAutoTuning()` now returns `{ evaluated: 0, applied: 0 }` when a fresh database has no `cognitive_episodes` table, preventing a misleading 500 on the admitted admin path. The route test exercises this real service behavior.

The same route test sends three malformed prediction bodies; each is rejected with HTTP 400 before `predictFailure()` runs.

This closes the mount-only authorization gap; it does not certify production identity, browser execution, or provider-backed meta quality.
