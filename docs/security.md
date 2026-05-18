# Security Model

## Authentication

- Passwords are hashed with bcryptjs (cost factor 12)
- JWT tokens are signed with RS256-equivalent HMAC-SHA256
- Tokens expire after configurable duration (default: 24h)
- Generic error messages on login failure (no account enumeration)
- Password hashes are never returned through API responses

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
3. **No rate limiting**: Login endpoint is not rate-limited. Should be added before production.
4. **No CSRF protection**: API uses Bearer tokens, not cookies, so CSRF is not applicable.
5. **No password reset**: Users must be recreated or password reset via environment variable.
6. **No account lockout**: Repeated failed login attempts are not blocked.

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