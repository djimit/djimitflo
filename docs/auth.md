# Authentication and Authorization

## Architecture

Djimitflo uses JWT-based authentication with role-based authorization (RBAC).

### Authentication Flow

1. Client sends `POST /api/auth/login` with `{ email, password }`
2. Server validates credentials using bcryptjs (cost factor 12)
3. On success, returns `{ token: JWT, user: User }`
4. Client stores token in localStorage and sends `Authorization: Bearer <token>` header
5. Server validates JWT on protected routes via `requireAuth` middleware

### Authorization Model

Three roles with hierarchical permissions:

| Permission | admin | operator | viewer |
|-----------|-------|----------|--------|
| `read:evidence` | ✓ | ✓ | ✓ |
| `read:repository` | ✓ | ✓ | ✓ |
| `scan:repository` | ✓ | ✓ | — |
| `create:task` | ✓ | ✓ | — |
| `execute:task` | ✓ | ✓ | — |
| `approve:task` | ✓ | ✓ | — |
| `delete:task` | ✓ | — | — |
| `manage:config` | ✓ | — | — |
| `manage:users` | ✓ | — | — |
| `manage:backups` | ✓ | — | — |

### Protected Routes

**Public (no authentication required):**
- `GET /health`
- `GET /api/version`
- `POST /api/auth/login`
- `POST /api/auth/logout`

**Authenticated (any role):**
- `GET /api/auth/me`
- `GET /api/tasks`, `GET /api/tasks/:id`
- `GET /api/agents`, `GET /api/agents/:id`
- `GET /api/evidence/*`
- `GET /api/repositories`, `GET /api/repositories/:id/*`
- `GET /api/audits`, `GET /api/policies`

**Admin-only (requiring `manage:config`):**
- `GET /api/observability/*`

**Admin-only (requiring `manage:backups`):**
- `POST /api/backups`, `GET /api/backups`, `POST /api/backups/:filename/restore`

**Permission-gated:**
| Route | Required Permission |
|-------|---------------------|
| `POST /api/tasks` | `create:task` |
| `PATCH /api/tasks/:id` | `create:task` |
| `DELETE /api/tasks/:id` | `delete:task` |
| `POST /api/tasks/:id/execute` | `execute:task` |
| `POST /api/tasks/:id/cancel` | `execute:task` |
| `POST /api/approvals/:id/approve` | `approve:task` |
| `POST /api/approvals/:id/deny` | `approve:task` |
| `POST /api/repositories/scan` | `scan:repository` |
| `POST /api/repositories/:id/rescan` | `scan:repository` |
| `POST /api/policies` | `manage:config` |
| `PATCH /api/policies/:id` | `manage:config` |
| `DELETE /api/policies/:id` | `manage:config` |
| `PATCH /api/mcp/permissions/:toolId` | `manage:config` |
| `POST /api/risk/command` | `execute:task` |
| `POST /api/risk/task` | `execute:task` |

## Bootstrap Admin

Set environment variables before first startup:

```bash
AUTH_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
AUTH_BOOTSTRAP_ADMIN_PASSWORD=<your-secure-password>
AUTH_BOOTSTRAP_ADMIN_ROLE=admin  # optional, defaults to admin
```

The bootstrap process:
- Only runs if no users exist in the database
- Creates an admin user with the specified credentials
- Skips if the user already exists
- Logs a warning if credentials are missing and no users exist
- **In production**: exits if JWT_SECRET is missing or if no users exist without bootstrap credentials

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | (required in production) | Secret key for JWT signing |
| `JWT_EXPIRES_IN` | `24h` | Token expiration time |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | — | Email for initial admin user |
| `AUTH_BOOTSTRAP_ADMIN_PASSWORD` | — | Password for initial admin user |
| `AUTH_BOOTSTRAP_ADMIN_ROLE` | `admin` | Role for bootstrap user |

## JWT Payload

```json
{
  "sub": "user-uuid",
  "email": "admin@example.com",
  "role": "admin",
  "iat": 1716000000,
  "exp": 1716086400
}
```

## Audit Actor Attribution

Authenticated actions include `user_id` in audit events. Background/system actions use `user_id = 'system'`.

The `audit_events.user_id` column was already present in Phase 4.2. Starting from Phase 5.2, HTTP-initiated actions populate this field with the authenticated user's ID.

## Known Limitations

- **Token storage**: JWT tokens are stored in localStorage (see [security.md](./security.md))
- **No refresh tokens**: After token expiry, user must re-authenticate
- **No password reset**: Not yet implemented
- **No user management UI**: Admin creation is via environment variables only
- **No multi-tenancy**: Users see only their own tasks; admin sees all (see [authorization.md](./authorization.md))

## Future Roadmap

- Password reset flow
- Refresh tokens
- OIDC/SSO integration
- Organization/workspace model for team isolation
- User management UI
- WebSocket authentication and event scoping