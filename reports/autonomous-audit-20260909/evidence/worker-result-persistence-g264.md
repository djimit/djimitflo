# G264 worker-result persistence truth boundary

`BackgroundWorkerService` now writes every completed or failed worker result to the existing `worker_results` SQLite table and reloads the latest 100 results when a service instance starts. The metrics worker is named `Metrics Snapshot` and reports a read-only count rather than claiming aggregation/storage.

The focused regression ran `metrics-aggregation`, asserted `Metrics snapshot:`, observed one durable `worker_results` row, constructed a fresh service instance over the same database and verified the result was restored. Disabled workers still return explicit `WORKER_UNAVAILABLE` failures.

