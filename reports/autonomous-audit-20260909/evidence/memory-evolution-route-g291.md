# G291 memory-evolution route proof

- Focused `memory-evolution.test.ts`: 6 tests passed.
- Positive chain: ingest trace → schedule evaluation goal → evaluate promotion eligibility → create evaluator lease → list filtered leases; retrieval quality/cross-agent access remains covered.
- Negative boundary: malformed ingest/evolve/lease payloads and invalid role/metadata return typed `400` before mutation.
- Scope: local Express/SQLite evolution state-machine proof; no external provider or automatic promotion claim.
- `/loops` retry: 62 files, 612 passed, 2 skipped. The first attempt had one Stryker-sandbox auth race; immediate retry passed and is retained in `loops-self-check-g291-retry.log`.
