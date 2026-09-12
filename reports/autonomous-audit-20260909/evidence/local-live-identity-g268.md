# G268 local live identity

An isolated local server was started from the current build on `127.0.0.1:3131` with a temporary SQLite database, then stopped cleanly.

- `GET /health` → 200, `status: healthy`.
- `GET /api/version` → 200, version `0.5.8`.
- SQLite `PRAGMA integrity_check` → `ok`.
- `GET /api/health/deep` → 401 `AUTH_REQUIRED`.
- Identity gate → `BLOCKED`, because the dirty audit worktree cannot claim a clean deployed commit and protected provenance was not authenticated.

The temporary database was removed after the probe. This proves local startup and database integrity, not production identity or authenticated deployment parity.
