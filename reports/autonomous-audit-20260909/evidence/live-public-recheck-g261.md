# G261 live public boundary recheck

Read-only probe against `https://djimitflo.agentical.nl/` on 2026-09-11:

- `/` returned HTTP 200 with the dashboard HTML shell
- `/api/version` returned HTTP 200 with API version `0.5.8`
- `/api/health` returned HTTP 401 `AUTH_REQUIRED`
- `/api/openapi.json` returned HTTP 401 `AUTH_REQUIRED`

This confirms public availability and the protected API boundary only. It does not prove the deployed commit, authenticated dashboard semantics, provider delivery or production parity with the local checkout.
