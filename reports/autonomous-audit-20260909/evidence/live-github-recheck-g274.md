# G274 live/GitHub boundary recheck

Read-only snapshot on 2026-09-11:

- `https://djimitflo.agentical.nl/` → HTTP 200
- `/api/version` → HTTP 200, `{"version":"0.5.8","name":"Djimitflo API"}`
- `/api/health` → HTTP 401 (`AUTH_REQUIRED` boundary)
- `origin/main` → `259773b68d1d328195d72f74e176dc2d9924f215`

This proves public availability and the anonymous protection boundary only. Authenticated production behavior, deployed source identity and browser interaction remain unverified. No remote mutation was performed.
