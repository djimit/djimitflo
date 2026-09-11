# G267 live public boundary

Read-only probe on 2026-09-11:

- `GET https://djimitflo.agentical.nl/` → 200, Express/nginx shell.
- `GET /api/version` → 200, `{"version":"0.5.8","name":"Djimitflo API"}`.
- `GET /api/health` → 401 `AUTH_REQUIRED`.
- `GET /api/openapi.json` → 401 `AUTH_REQUIRED`.
- `/robots.txt` → 404.

This proves public availability and the protected boundary only. No authenticated production semantics or deployed commit identity is inferred.
