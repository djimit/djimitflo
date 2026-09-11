# G264 worker-results table reachability

The current source-level reachability check finds both a production writer and reader for `worker_results` in `packages/server/src/services/background-worker-service.ts`:

- writer: `INSERT INTO worker_results` (line 283)
- reader: `SELECT ... FROM worker_results` during service initialization (line 310)

The table is active persistence for worker outcomes. Older generated table snapshots that classified it as scaffolding are historical and not current runtime evidence.

