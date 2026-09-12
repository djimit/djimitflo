# Live public edge recheck — G230

Date: 2026-09-11 (Europe/Amsterdam)

Read-only checks against `https://djimitflo.agentical.nl/`:

- `GET /` returned HTTP 200 from nginx/Express with the dashboard shell (550 bytes).
- `GET /api/version` returned HTTP 200 and `{"version":"0.5.8","name":"Djimitflo API"}`.
- `GET /api/health` without credentials returned HTTP 401 with `AUTH_REQUIRED` and security headers.
- The shell references the deployed JavaScript bundle; the fetched bundle was 297,945 bytes with SHA-256 `597cc075ab9d8f19a8f23eab0c829be8f7bd84505cfdfd2b8be5532da3247062`.
- A bounded marker scan found one alert-only task-create failure path and no `TODO`, `FIXME` or `coming soon` markers in the fetched bundle.

The in-app browser/computer-use surface was unavailable (`No browser is available`), and the public edge exposes no authenticated session. Therefore this is availability, asset and anonymous-auth-boundary evidence only. It does not prove authenticated route traversal, UI action semantics, persistence, WebSocket behavior or production task execution.
