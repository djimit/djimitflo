# G385 local live identity recheck

The isolated audit checkout started successfully on `127.0.0.1:3001`. `/health` and `/api/version` returned 200 and database integrity passed. The gate remains BLOCKED: `/api/health/deep` returned 401 `AUTH_REQUIRED`, so authenticated provenance, matching commit/database identity and clean intended revision cannot be established without operator credentials. The server was stopped after the read-only probe.
