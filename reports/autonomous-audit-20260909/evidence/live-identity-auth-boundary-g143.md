# G143 — local live identity/auth boundary recheck

- The built server was started temporarily from the audit worktree and stopped after the probe; no background monitor remains.
- `GET /health`: **200**, `status=healthy`.
- `GET /api/version`: **200**, version `0.5.8`.
- `GET /api/health/deep`: **401 AUTH_REQUIRED** without an operator token.
- `assurance:live`: **BLOCKED**. The local health/version surface is reachable, but authenticated provenance and clean commit/database identity cannot be certified without authorized credentials and a clean intended revision.
- No database user or external state was created or changed.
