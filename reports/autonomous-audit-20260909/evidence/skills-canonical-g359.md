# Skills mutation route proof G359

Authenticated local HTTP against the production-equivalent skills router proves the canonical mutation surface:

- `POST /skills/:id/enable` returns explicit `503 SKILL_ACTIVATION_UNAVAILABLE` without a false toggle.
- `POST /skills/:id/disable` returns explicit `503 SKILL_ACTIVATION_UNAVAILABLE` without a false toggle.
- `POST /skills/reload` returns explicit `503 SKILL_RELOAD_UNAVAILABLE` without a false reload.
- `POST /skills/:id/assign/:agentId` persists an admitted assignment (`201`).
- `DELETE /skills/:id/assign/:agentId` removes the assignment (`200`).

The routes are operationally reachable; runtime activation/reload remains intentionally unavailable because no shared execution-engine mechanism exists.
