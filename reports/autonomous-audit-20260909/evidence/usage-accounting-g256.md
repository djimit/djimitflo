# G256 usage accounting semantics

The batch usage contract now keeps `task_type` separate from `provider`: producers may send an explicit provider, while legacy batches are recorded as `unknown` instead of being mislabeled with a task category. Supplied `task_id` and `agent_id` correlation fields are persisted rather than silently discarded. When `total_tokens` is omitted it is derived from prompt plus completion tokens. Empty providers and correlation fields remain rejected before SQLite.

Focused usage HTTP regression passes 2/2 (including explicit provider/task separation, legacy fallback, correlation persistence and malformed-provider rejection). Fresh full server and workspace regressions remain 2,514 passed / 20 skipped, and `/loops` remains 291 passed / 1 skipped; type-check, lint and route-registration checks pass after the change. Provider delivery and authenticated/live semantics remain unverified.
