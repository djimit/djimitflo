# Authorization & Ownership Model

## Overview

Djimitflo uses a role-based access control (RBAC) system with ownership-aware visibility rules. Every operational resource (tasks, approvals, evidence, repositories) has ownership metadata, and access is determined by the combination of the user's role and their relationship to the resource.

## Roles & Permissions

| Role | Permissions |
|------|-------------|
| **Admin** | `read:evidence`, `read:repository`, `scan:repository`, `create:task`, `execute:task`, `approve:task`, `delete:task`, `manage:config`, `manage:users`, `manage:backups` |
| **Operator** | `read:evidence`, `read:repository`, `scan:repository`, `create:task`, `execute:task`, `approve:task` |
| **Viewer** | `read:evidence`, `read:repository` |

## Ownership Model

### Task Ownership

| Column | Type | Description |
|--------|------|-------------|
| `created_by` | TEXT (nullable) | User ID who created the task |
| `owner_user_id` | TEXT (nullable) | User ID who owns the task (defaults to creator) |
| `updated_by` | TEXT (nullable) | User ID who last updated the task |

### Repository Ownership

| Column | Type | Description |
|--------|------|-------------|
| `added_by` | TEXT (nullable) | User ID who scanned/added the repository |

### Approval Ownership

| Column | Type | Description |
|--------|------|-------------|
| `requested_by` | TEXT (nullable) | User ID who caused the approval request (fallback: task owner or system) |
| `decided_by` | TEXT (nullable) | User ID who approved or denied the approval |
| `approved_by` | TEXT (nullable) | User ID who approved (set to decided_by on approval) |

## Visibility Rules

### Tasks

| Role | Visibility |
|------|------------|
| Admin | All tasks, including legacy NULL-owned tasks |
| Operator | Own tasks only (where `owner_user_id` or `created_by` matches their user ID) |
| Viewer | Own tasks only (read-only, cannot create/modify/execute) |

**Legacy NULL-owned tasks** (rows where both `created_by` and `owner_user_id` are NULL) are visible **only to admins**. Unknown ownership does not mean shared access.

### Approvals

Approvals follow the underlying task's visibility. An operator can only see, approve, or deny approvals for tasks they own. Admin can see all approvals.

### Evidence, Review, File Changes, Audit Trail

All evidence and review endpoints are scoped to the underlying task. If a user cannot read the task, they cannot access its evidence, summary, file changes, diff, or audit trail.

### Observability

All observability endpoints (`/api/observability/*`) are **admin-only**. They expose global system metrics, risk trends, policy stats, and execution activity across all users.

| Endpoint | Admin | Operator | Viewer |
|----------|-------|----------|--------|
| `GET /observability/metrics` | Yes | No (403) | No (403) |
| `GET /observability/risk-trends` | Yes | No (403) | No (403) |
| `GET /observability/policy-stats` | Yes | No (403) | No (403) |
| `GET /observability/execution-activity` | Yes | No (403) | No (403) |

### Repositories

| Endpoint | Admin | Operator | Viewer |
|----------|-------|----------|--------|
| `GET /repositories` | Full detail | Redacted (path=null, metadata=null) | Redacted |
| `GET /repositories/:id` | Full detail | Redacted | Redacted |
| `POST /repositories/scan` | Full result | Full result (+ records added_by) | 403 |
| `GET /repositories/:id/health` | Full | Full (requires scan:repository) | 403 |
| `GET /repositories/:id/agents-md` | Full | Full (requires scan:repository) | 403 |
| `GET /repositories/:id/agents-md/effective` | Full | Full (requires scan:repository) | 403 |
| `POST /repositories/:id/agents-md/validate` | Full | Full (requires scan:repository) | 403 |
| `GET /repositories/:id/file-changes` | Full | Admin-only | 403 |

Repository **redaction** for non-admin users:
- `path`: set to `null` (prevents filesystem path exposure)
- `metadata`: set to `null` (may contain sensitive configuration)

### MCP Servers

| Field | Admin sees | Non-admin sees |
|-------|-----------|---------------|
| `command` | Full command path | `null` |
| `args` | Full arguments | `[]` |
| `env` | Full environment | `{}` |
| `url` | Full URL | `null` |

MCP server secrets (environment variables containing API keys, tokens) are fully redacted for non-admin users. No partial parsing is performed.

### Backups

Backup endpoints remain **admin-only** (`manage:backups` permission). No changes from Phase 5.4.

## Error Convention

| Status Code | Meaning | Example |
|-------------|---------|---------|
| **401** | Unauthenticated | No valid JWT token |
| **403** | Authenticated but missing route-level permission | Viewer trying `POST /tasks` |
| **404** | Resource does not exist OR user cannot access it | Operator reading another operator's task |

We use **404** for resource-level access failures to avoid leaking resource existence. A user who cannot access a task receives "Task not found" rather than "Access denied."

Examples:
- `POST /tasks` without auth → 401
- `POST /tasks` as viewer → 403 (missing `create:task` permission)
- `GET /tasks/:id` for inaccessible task → 404
- `POST /tasks/:id/execute` for inaccessible task → 404
- `GET /evidence/task/:inaccessibleTaskId` → 404
- `GET /observability/metrics` as non-admin → 403

## Approval Actor Attribution

### `requested_by` Semantics

When an approval is created during task execution:
- `requested_by` = the user who initiated the execution (`req.user.sub`)
- Fallback: `task.owner_user_id || task.created_by || 'system'`

This is documented in the fallback chain: the actor who directly triggered the creation is preferred, falling back to the task owner, then the task creator, then `'system'`.

### `decided_by` and `approved_by`

When an approval is approved or denied:
- `decided_by` = `req.user.sub` (the authenticated user who made the decision)
- `approved_by` = `decided_by` on approval, `null` on denial

This replaces the previous hardcoded `'user'` value.

## Migration & Backward Compatibility

### New Columns (Phase 5.5)

All new columns are **nullable** — no data loss on upgrade:

```sql
ALTER TABLE tasks ADD COLUMN created_by TEXT;
ALTER TABLE tasks ADD COLUMN owner_user_id TEXT;
ALTER TABLE tasks ADD COLUMN updated_by TEXT;
ALTER TABLE repositories ADD COLUMN added_by TEXT;
ALTER TABLE approvals ADD COLUMN requested_by TEXT;
```

### Backward Compatibility

- Pre-5.5 backups restore correctly: new columns get NULL on restore, then migration adds them on next startup
- NULL ownership columns mean "unknown owner" — treated as admin-visible only for tasks
- Existing data is not modified — no backfill UPDATE statements
- The `decided_by` and `approved_by` columns (Phase 4.2) now receive actual user IDs instead of hardcoded `'user'`

## WebSocket Gap

**Known limitation (not addressed in Phase 5.5):**

WebSocket connections currently have no authentication. All connected clients receive all broadcast events, which may include sensitive task and execution data. This is a security gap.

Recommended next hardening step: WebSocket authentication and event scoping based on user role and task ownership.

## Future Roadmap

- **WebSocket authentication**: Authenticate WebSocket connections and scope events by user role and task ownership
- **Organization/workspace model**: Multi-tenant isolation for teams
- **Shared/global task visibility**: Configurable sharing model for operator collaboration
- **Repository ownership**: Per-user repository access controls
- **Encrypted backups**: At-rest encryption for backup archives