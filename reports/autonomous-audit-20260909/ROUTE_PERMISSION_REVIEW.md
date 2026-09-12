# Route permission contract correction

The literal route scan found one undefined permission name, `write:config`, used by fifteen routes. No role owned it. These endpoints previously returned forbidden even for administrators. No role, wildcard, or promotion policy was expanded.

| Action | Existing permission now required | Actual semantics |
|---|---|---|
| Background worker run/start | `manage:config` **and** `execute:task` | Platform admin cannot execute; maker cannot schedule global maintenance. |
| Background worker stop | `manage:config` | Configuration operator can stop scheduled work without execution authority. |
| LLM performance report | `write:evidence` | Reported metrics, not an independent provider health certification; boolean/finite nonnegative fields validated. |
| Knowledge subscription | `write:claim` | Durable subscription record; no agent execution. |
| Evolution register/evolve | `write:skills` | Genome metadata only; does not write executable skill files, promote a capability or activate a model. |
| Evolution outcome | `write:evidence` | Durable reported outcome; strict boolean and nonnegative numeric validation prevents string-false becoming success. |
| Skill assign/remove | `write:skills` **and** `write:agents` | Only already admitted operator-directory skills; assignment is persisted and visible to the existing engine loader. Rejected candidates remain unassigned. |
| Skill enable/disable and reload | `manage:config`, then explicit 503 | `SKILL_ACTIVATION_UNAVAILABLE` / `SKILL_RELOAD_UNAVAILABLE`: router-local inventory flags/reload do not alter the separate execution-engine loader. No pretend activation/deactivation or mutation. |
| Plugin enable/disable | `manage:config`, then explicit 503 | `PLUGIN_ACTIVATION_UNAVAILABLE`: no shared trusted runtime activation/deactivation path; inventory flags are not enforcement. |

The permission test uses actual JWT verification and HTTP requests for all seven roles, real isolated SQLite writes, and actual temporary skill files. An admissible fixture skill is assigned through the route and read through the existing execution-engine loader; a prompt-injection candidate is rejected. Worker scheduling is stubbed, and the only executed worker operation is a local database health read. No provider execution, external request, OpenMythos promotion, signature policy change or automatic plugin activation was performed.

Evidence: [undefined names before correction](evidence/route-permissions-red.log), [passing role/permission suite](evidence/route-permissions-final.log). `route-permission-contract.test.ts` rejects future literal `requirePermission(...)` strings owned by no role. This is a static spelling contract; dynamic permission expressions and the meaning of existing permissions still require review.
