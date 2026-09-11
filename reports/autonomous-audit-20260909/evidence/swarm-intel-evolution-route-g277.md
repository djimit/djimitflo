# G277 swarm-intel plan/evolution route proof

Focused HTTP/SQLite fixture: `POST /decompose` rejects malformed goal/options, creates a two-stage plan against the migrated `execution_plans` schema, and `GET /plans` plus `GET /plans/:id` retrieve the persisted plan; missing IDs return typed 404. Two skills are registered, two successful outcomes are recorded, `POST /evolution/evolve` produces generation 2, and stats persist two outcomes and the next generation. Invalid skill IDs/traits are rejected before mutation.

Root cause fixed: older databases expose `subtasks_json` while `SwarmTaskDecomposer` wrote `tasks_json`; startup now adds/backfills the compatibility column and reads either shape. No provider, external repository, promotion, merge or deployment was used.
