# G322 canonical skills governance evidence

The authenticated canonical `/api/skills` mount now exercises list, statistics, detail, agent projection and trigger lookup against the operator-configured skill directory. Existing enable/disable/reload calls remain explicit `503 SKILL_ACTIVATION_UNAVAILABLE` or `SKILL_RELOAD_UNAVAILABLE`; assignment remains guarded by both skill admission and agent/write permissions.

- Server: 336 files, 2,559 passed, 20 skipped, 0 failed.
- Workspace: 378 files, 2,850 passed, 20 skipped, 0 failed.
- `/loops`: 62 files, 612 passed, 2 skipped, 0 failed.
- Contract inventory: 585 routes, 516 direct, 0 critical unclassified; MCP 56/56.

No runtime activation capability is claimed where the shared execution engine has no configured activation mechanism.
