# G171 safe mutating-route sweep

Scope: 32 additional safe-route call attempts from the mutating inventory, using empty JSON against a fresh built runtime. External provider, deployment, worker and repository-changing calls were bounded or excluded; the four parameterized PATCH/DELETE templates were also retained as explicit missing-fixture checks.

The sweep found one semantic defect: `/api/advanced/workflows/:id/nodes/:nodeId/status` returned 200 for a missing workflow/node because the service ignored SQLite `changes`. Several SEGML routes returned 200 with documented defaults (generation, tournament, literature scan and self-improvement); these are intentional parameterless operations and are not classified as errors. No other 500 was observed.

The workflow defect is closed in G172 by enforcing workflow/node existence at the service and route boundaries.
