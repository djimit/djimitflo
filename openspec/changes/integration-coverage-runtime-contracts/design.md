## Approach

Use existing Express factories, temporary SQLite databases, existing executors,
and Vitest. Tests assert observable HTTP and persisted state, not method calls.

### Task boundary

Validate task enums using the shared enum values before SQLite. Validate the
executor through the already initialized execution engine. Preserve the current
API error shape and local 400 convention.

### OpenMythos boundary

Exercise the existing route factory with a temporary corpus and a deterministic
model-boundary fake. Missing on-demand configuration is service unavailability,
not an internal error.

### Coverage truth

Keep the existing numeric field for compatibility, but identify it as direct
test-file matching and report integration coverage as unknown until explicit
capability contracts exist.

### Observability

Use a request ID supplied by the caller or generated with Node's standard
library. Expected 4xx responses do not need server-error stacks.
