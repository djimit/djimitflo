# G280 Apex inventory route proof

Focused HTTP/SQLite fixture: plugin listing/stats and worker status are durable read-only projections; empty vector-memory clusters/stats are returned without invoking an embedding provider; malformed memory writes/search limits are rejected; plugin enable/disable return typed 503 `PLUGIN_ACTIVATION_UNAVAILABLE` instead of pretending inventory flags activate runtime code. Provider-backed embedding/LLM execution remains unclaimed.
