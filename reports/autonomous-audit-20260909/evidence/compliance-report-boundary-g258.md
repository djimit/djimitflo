# G258 compliance report boundary

`POST /api/compliance/reports/generate` now validates report type against `nora|soc2|iso27001` and validates optional period start/end dates before report generation. Unsupported types and malformed dates return typed `VALIDATION_ERROR` without writing a report. The existing export route and generate route now share the same documented type boundary.

Focused compliance/usage regression passes 2/2; full build, type-check and lint pass; full server/workspace and `/loops` rechecks remain green. Route registration remains 614/608 and contract coverage remains 581/351/0 with 56/56 MCP tools.
