# G257 compliance audit append boundary

`POST /api/compliance/audit/append` now rejects missing/non-string/overlong actions, invalid resource types or lengths, unsupported outcomes and non-object evidence before the immutable audit service is called. A malformed request returns typed `VALIDATION_ERROR` and leaves the audit event count unchanged. Focused compliance/usage regression passes 2/2; type-check and lint pass.

The route-registration check remains green at 614 registrations and 608 anonymous auth probes; contract inventory is 581/351/0 with 56/56 MCP tools. Full server/workspace and `/loops` reruns are green after the change; one earlier parallel workspace run exposed a non-reproducible task-recovery 404 and is retained as UNKNOWN.
