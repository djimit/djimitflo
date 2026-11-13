# Files

- [SQLite Data Model, Migrations & Provenance](data-model.md) - Data-plane reference for the better-sqlite3 schema: path resolution, boot/boot migrations, the ColumnSpec ALTER tail, loop run/goal/worker-lease vocabularies, worker manifest evidence, the mcp_servers baseline seed, and evidence-root persistence.
- [Runtime Profiles (api / operator / autonomous)](runtime-profiles.md) - How DJIMITFLO_RUNTIME_PROFILE is resolved and exactly which background services, schedulers, and workers each of the three runtime profiles (api, operator, autonomous) enables at server startup.
- [Server Runtime & Boot Sequence](server-runtime.md) - How packages/server/src/index.ts boots the Djimitflo control plane — outbound fetch guard and database init, loop/task crash recovery, profile-gated operator/autonomous service wiring, the Express middleware stack with the raw-body webhook mount, /api route aggregation, the authenticated WebSocket server, the LoopDaemon, and SIGTERM graceful shutdown.
