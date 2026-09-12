# Governance read-route proof — G306

An authenticated local HTTP fixture created a mock proof run, trace span, capability token and reflection. It then read the persisted state through literal requests to `/proof-runs/latest`, `/assurance/summary`, `/assurance/capability-tokens` and `/assurance/reflections`; all projections matched the created records. Focused coverage passes 2/2 tests.

The same run exposed and fixed a test-fixture schema drift: `capability_tokens` lacked the current `token_ref`, subject, scope and approval columns required by `AgentAssuranceService`. The fixture now matches the production migration. This proves local authenticated HTTP-to-SQLite projection and fixture parity, not external identity or production certification.
