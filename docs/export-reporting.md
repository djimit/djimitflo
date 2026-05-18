# Export & Reporting

## Overview

Djimitflo provides authorization-aware export endpoints for governance evidence, audit trails, and operational summaries. Exports enforce the same RBAC and ownership rules as the API and WebSocket layers.

## Endpoints

All export endpoints use `POST` with a JSON body specifying format and options.

### Task Export

```
POST /api/exports/task/:taskId
```

Export the full governance evidence pack for a task, including summary, evidence, file changes, and audit trail.

**Authorization:** Same as task read access — admin sees all, operator/viewer sees only their own tasks (404 for inaccessible tasks).

**Request body:**
```json
{
  "format": "json | csv | markdown",
  "includeDiffs": true,
  "includeAudit": true,
  "includeMetadata": true,
  "dateFrom": "2026-01-01T00:00:00Z",
  "dateTo": "2026-12-31T23:59:59Z"
}
```

**Response:** Binary file download with `Content-Disposition: attachment; filename="task-<taskId>.<ext>"`

### Evidence Export

```
POST /api/exports/evidence/:taskId
```

Export the evidence chain for a task (without summary or audit trail).

**Authorization:** Same as task evidence access — scoped to task ownership.

### Audit Export

```
POST /api/exports/audit
```

Export global audit events. **Admin-only** — exposes cross-user data.

**Request body:**
```json
{
  "format": "json",
  "dateFrom": "2026-01-01T00:00:00Z",
  "dateTo": "2026-12-31T23:59:59Z"
}
```

### Repository Export

```
POST /api/exports/repository/:repositoryId
```

Export repository metadata and health findings.

**Authorization:** `read:repository` permission required. Path and metadata are redacted for non-admin users.

### Summary Report

```
POST /api/exports/report/summary
```

Export operational summary (system metrics).

**Authorization:** Admin-only.

## Formats

| Format | Content-Type | Extension | Description |
|--------|-------------|-----------|-------------|
| `json` | `application/json` | `.json` | Full structured export with manifest |
| `csv` | `text/csv` | `.csv` | Tabular export with manifest header section |
| `markdown` | `text/markdown` | `.md` | Human-readable report with tables and metadata |

## Export Manifest

Every export artifact includes a manifest:

```json
{
  "exportVersion": "1.0.0",
  "appVersion": "0.5.8",
  "generatedAt": "2026-05-19T12:00:00.000Z",
  "generatedBy": "user-id",
  "generatedByRole": "admin",
  "scope": "task",
  "sourceTaskId": "abc-123",
  "filters": { "includeDiffs": true, "includeAudit": true },
  "recordCounts": { "task": 1, "evidence": 4, "fileChanges": 2 },
  "redactionApplied": false,
  "warnings": []
}
```

## Redaction

Exports follow the same redaction rules as the API:

| Field | Admin sees | Non-admin sees |
|-------|-----------|---------------|
| Task metadata (`metadata`) | Full object | Removed (if `includeMetadata: false`) or redacted |
| Repository `path` | Full path | `null` |
| Repository `metadata` | Full object | `null` |
| File change `diff` | Full diff content | `null` |
| `password_hash`, `jwt_secret` | Never exported | Never exported |
| Fields starting with `=`, `+`, `-`, `@` (CSV) | Raw value | Prefixed with `'` |

## CSV Injection Protection

CSV exports prefix dangerous cell values with a single quote (`'`) to prevent formula injection:

| Original | CSV output |
|---------|-----------|
| `=SUM(A1:A10)` | `'=SUM(A1:A10)` |
| `+cmd` | `'+cmd` |
| `-formula` | `'-formula` |
| `@reference` | `'@reference` |

## Audit Events

Exports generate audit events:

| Event | When |
|-------|------|
| `export.created` | Successful export |
| `export.denied` | Authorization failure (recorded with user ID, format, scope, reason) |

## Frontend

The ReviewPage and TaskDetailPage include an **Export** dropdown button with three format options (JSON, CSV, Markdown). The export triggers a browser file download via `fetch` with the auth token.

## Security Considerations

- No secrets (JWT tokens, password hashes, bootstrap password) are included in any export format
- Task exports for non-admin users follow the same 404 convention as the API (resource existence is hidden)
- Audit and summary exports are admin-only to prevent cross-user data leakage
- CSV injection protection prevents spreadsheet formula execution
- All export attempts are audit-logged, including denied attempts