# G157 — message and audit pagination boundaries

The agent-message list route previously used `Number(limit) || 50`, so zero, negative, fractional and non-numeric values silently became a different query. The audit-log viewer likewise coerced `limit` and `offset` with `||`, allowing malformed windows.

Both routes now fail closed with structured `400 VALIDATION_ERROR`: message limits are integers 1–500; audit-log limits are 1–10,000 and offsets are 0–1,000,000. Focused regressions pass: messages and approval/audit HTTP suites together report 12/12 tests. Build, type-check, lint and the full workspace regression remain green.
