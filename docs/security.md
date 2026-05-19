# Security Model

## Authentication

- Passwords are hashed with bcryptjs (cost factor 12)
- JWT tokens are signed with HMAC-SHA256 (HS256)
- Tokens expire after configurable duration (default: 24h)
- Generic error messages on login failure (no account enumeration)
- Password hashes are never returned through API responses
- The login endpoint is rate-limited per client IP (10 attempts / 15 minutes)

## Authorization

- Role-based access control (RBAC) with three roles: admin, operator, viewer
- Route-level authentication via `requireAuth` middleware
- Action-level authorization via `requirePermission` middleware
- Backend authorization is the source of truth — frontend role checks are UX-only

## Token Handling

- JWT tokens are stored in `localStorage` in the browser
- This is a known limitation — localStorage is accessible to XSS attacks
- **Mitigation**: Do not store sensitive data in localStorage beyond the auth token
- **Future improvement**: Move to httpOnly cookies or session-based auth when implementing OIDC/SSO

## Protected Endpoints

- All `/api/*` routes require authentication except `/api/auth/login` and `/api/auth/logout`
- The `/health` endpoint and `/api/version` are public
- Permission checks are applied per action within route handlers

## Real-Time Updates (WebSocket)

- The `/ws` WebSocket endpoint requires a valid JWT, supplied as a `token`
  query parameter (`wss://host/ws?token=<jwt>`). Browsers cannot set headers on
  WebSocket connections, so the token travels in the query string.
- Connections without a valid token for an active user are closed immediately
  with status code `1008`.
- All broadcast traffic (execution events, approvals, risk assessments) is
  therefore restricted to authenticated clients.

## Agent Execution Sandboxing

- The OpenCode executor runs only inside the working directory of the task's
  associated repository. It refuses to start without an explicit working
  directory, so an agent can never operate in the server's own process
  directory.
- A task must reference a registered repository whose path exists on disk
  before the OpenCode executor will run it.

## Repository Scanning

- `POST /api/repositories/scan` reads the filesystem path it is given. Set
  `DJIMITFLO_ALLOWED_REPO_ROOTS` (comma-separated absolute paths) to restrict
  scans to specific directories; paths outside those roots are rejected with
  `403`. When unset, scanning is unrestricted and a startup warning is logged.
- All git inspection uses argument arrays, never a shell, so
  repository-controlled filenames and refs cannot inject commands.

## Execution Gating Model

- The risk classifier and approval policies act as a **pre-flight gate**: they
  are evaluated once, before an agent is launched, against the task's metadata
  (title, description, declared risk level, execution mode).
- Once an agent is running, the individual shell commands and file writes it
  performs are governed by the underlying agent runtime's own permission model
  (OpenCode), not by Djimitflo's classifier.
- `OPENCODE_SKIP_PERMISSIONS=true` disables that runtime-level prompting, which
  removes all interactive gating — enable it only when the pre-flight policy
  decision is trusted to be sufficient.
- Per-action interception (pausing an in-flight agent for approval on each tool
  call) is not yet implemented; the `approvalCallback` hook in the executor
  interface is reserved for that future capability.

## Password Security

- bcryptjs with 12 rounds of hashing
- No plaintext password storage or logging
- No default credentials — bootstrap requires explicit email/password
- Development mode uses a warning for missing JWT_SECRET; production fails fast

## Audit Trail

- All authenticated actions record the actor's `user_id` in audit events
- Background/system actions use `user_id = 'system'`
- Audit events are immutable — no update or delete operations

## Security Override

- `SECURITY_OVERRIDE` AuditEventType records when OpenCode permission bypass is enabled
- `OPENCODE_SKIP_PERMISSIONS` defaults to `false`; requires explicit opt-in

## Known Limitations

1. **localStorage tokens**: Vulnerable to XSS. Mitigated by content security policy when deployed.
2. **No refresh tokens**: Users must re-authenticate after token expiry.
3. **Login rate limiting only**: Login is throttled per client IP (10 attempts / 15 minutes). There is no CAPTCHA or progressive backoff, and accuracy behind a reverse proxy depends on Express `trust proxy` configuration.
4. **No CSRF protection**: API uses Bearer tokens, not cookies, so CSRF is not applicable.
5. **No password reset**: Users must be recreated or password reset via environment variable.
6. **No account lockout**: Repeated failed logins are slowed by IP rate limiting only; individual accounts are never locked.

## Recommended Production Configuration

```bash
# Required
JWT_SECRET=<strong-random-secret-at-least-32-chars>

# Token expiry
JWT_EXPIRES_IN=24h

# Bootstrap admin
AUTH_BOOTSTRAP_ADMIN_EMAIL=admin@yourcompany.com
AUTH_BOOTSTRAP_ADMIN_PASSWORD=<strong-password>

# CORS — restrict to your domain
CORS_ORIGINS=https://your-domain.com
```