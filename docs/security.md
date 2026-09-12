# Security Model

## Authentication

- Passwords are hashed with bcryptjs (cost factor 12)
- JWT tokens are signed with HMAC-SHA256 (HS256)
- Tokens expire after configurable duration (default: 15 minutes)
- Generic error messages on login failure (no account enumeration)
- Password hashes are never returned through API responses

## Rate Limiting

- Login endpoint (`POST /api/auth/login`) is rate-limited to 10 failed attempts per IP per 15 minutes
- Successful login resets the rate limit counter for that IP
- Rate-limited requests receive HTTP 429 with a generic message that does not disclose whether the email exists
- Rate limiting is in-memory and single-instance only — not horizontally scalable
- For multi-instance deployments, Redis-backed rate limiting is recommended

## Security Headers

All API responses include the following security headers:

| Header | Value | Purpose |
|--------|-------|---------|
| X-Content-Type-Options | nosniff | Prevents MIME type sniffing |
| X-Frame-Options | DENY | Prevents clickjacking via iframes |
| Referrer-Policy | strict-origin-when-cross-origin | Limits referrer information leakage |
| X-XSS-Protection | 0 | Disables legacy XSS filter (modern browsers don't need it) |

The existing security-header middleware sets CSP, including `frame-ancestors 'none'`, no inline scripts and no object sources. Inline styles are allowed; non-production mode also permits `unsafe-eval`. Deployment must apply this middleware to dashboard HTML, not only API responses. The September audit found that boundary missing and tracks its repair in the verification report.

## Authorization

- Role-based access control (RBAC): admin, platform_admin, approver, maker, checker, auditor and viewer
- Route-level authentication via `requireAuth` middleware
- Action-level authorization via `requirePermission` middleware
- Backend authorization is the source of truth — frontend role checks are UX-only

## Token Handling

- Short-lived access JWTs remain in browser `localStorage`; XSS can still steal them or act as the user. HttpOnly refresh cookies do not eliminate XSS risk.
- Dashboard login opts in using `X-Djimitflo-Session: browser`. The server stores only refresh-token hashes and sends `djimitflo_refresh` as an HttpOnly, SameSite=Strict cookie scoped to `/api/auth`, with rolling 30-day expiry. Secure defaults on in production; `AUTH_COOKIE_SECURE=false` is only for deliberate local HTTP use.
- `POST /api/auth/refresh` requires that browser header and cookie. Rotation and its audit record commit together. The dashboard shares one bounded 401 retry across JSON, download and streaming requests; native Web Locks coordinate supporting tabs. Without Web Locks, refresh coordination is in-tab only.
- Browser access JWTs carry a session ID. HTTP authorization and protected WebSocket delivery check its live, unexpired refresh family. Browser logout revokes the presented family (and authenticated session when a cookie is absent); organization switching retains this binding. Refresh-token replay retains the existing user-wide revocation policy.
- Headerless legacy login keeps the `{token,user}` bearer contract without a refresh cookie. Legacy sidless tokens remain valid until expiry; legacy logout records an event but cannot revoke them.
- Session revocation prevents subsequent protected access; it does not undo completed actions or cancel work already admitted. Idle sockets are checked on delivery, not by an immediate revocation timer.
- HTTP MCP in live-data mode revalidates current account, membership and session family against its existing database on GET/POST. Snapshot/standalone HTTP MCP refuses browser `sid` tokens because it cannot establish live revocation; its legacy sidless mode remains signature-only. Already accepted MCP calls are not retroactively cancelled.

## Protected Endpoints

- Login accepts credentials; browser refresh accepts its cookie plus the explicit session header, not an access bearer. Logout supports both browser-session and legacy-bearer contracts described above. Other API routes enforce their registered authentication/permission middleware; the contract inventory records coverage.
- The `/health` endpoint and `/api/version` are public
- Permission checks are applied per action within route handlers

## Password Security

- bcryptjs with 12 rounds of hashing
- No plaintext password storage or logging
- No default credentials — bootstrap requires explicit email/password
- Development mode uses a warning for missing JWT_SECRET; production fails fast

## Audit Trail

- Instrumented actions record caller identity; complete coverage of every authenticated action is not established
- Background/system actions may have no user identity and can carry agent/system attribution
- Audit events are immutable — no update or delete operations

## Security Finding Lifecycle

External scanners submit normalized findings through `POST /api/work-items/integrations/preview` or `/import` with `source: security_finding`. The `metadata.security` contract requires:

- exact target and source identity;
- scanner/tool, rule, and location;
- severity and CIA impact;
- threat statement and attack path;
- immutable evidence references.

Djimitflo derives a stable fingerprint from target/tool/rule/location, derives risk from scanner severity, and routes the item only to `security-regression-loop`. Caller-supplied risk and loop overrides are ignored.

A finding can become `done` only when its remediation, rescan, and regression references point to a completed closed security loop for the finding's own goal. That loop must contain passed maker/checker and deterministic gates; high/critical findings additionally require a passed security-checker gate, loop approval, and an authenticated `approve:task` actor. Terminal findings reopen only through a recurrent scanner import, which preserves the prior resolution history.

## WebSocket Authentication

- The dashboard sends its JWT through the `bearer.<JWT>` WebSocket subprotocol; legacy query-string tokens are still accepted by the server
- Events are scoped server-side by user role and task ownership — the frontend is not the security boundary
- Invalid, expired, or missing tokens cause the connection to be rejected with close codes 4001/4002/4003
- Tokens are validated at connection time and rechecked opportunistically during broadcasts
- Token is never logged or echoed in error messages
- Use WSS in production to prevent token exposure in proxy logs

## Security Override

- `SECURITY_OVERRIDE` AuditEventType records when OpenCode permission bypass is enabled
- `OPENCODE_SKIP_PERMISSIONS` defaults to `false`; requires explicit opt-in

## Export Security

- Exports enforce the same RBAC and ownership rules as the API — no bypass
- Task-scoped exports (404 for inaccessible tasks) follow the same "hide existence" convention
- Global audit and summary exports are admin-only to prevent cross-user data leakage
- Repository path and metadata are redacted to null for non-admin users
- File change diffs are redacted for non-admin users
- Secrets (password hashes, JWT secret, bootstrap password) are never included in exports
- CSV exports protect against formula injection by prefixing cells starting with `=`, `+`, `-`, `@` with a single quote
- All export attempts (successful and denied) are recorded in the audit trail with `export.created` and `export.denied` events

## Known Limitations

1. **localStorage tokens**: Vulnerable to XSS. Mitigated by content security policy when deployed.
2. **Refresh API not exposed**: Rotation exists in AuthService, but current login/dashboard use one access token; users must re-authenticate after expiry.
3. **Single-process login rate limiting**: Login failures are limited; counters do not survive restart or coordinate across servers.
4. **No CSRF protection**: API uses Bearer tokens, not cookies, so CSRF is not applicable.
5. **No password reset**: Users must be recreated or password reset via environment variable.
6. **No account-wide lockout**: Per-IP login throttling does not provide a durable account lockout.
7. **Legacy WebSocket query-string token**: Compatibility callers can still expose tokens in proxy logs; the dashboard uses subprotocol authentication. WSS encrypts transport but does not remove query values from logs.
8. **In-memory WebSocket map**: Socket connections are stored in server memory, not horizontally scalable. Distributed pub/sub (e.g., Redis) is future work.
9. **No dedicated WS token-expiry timer**: Expired connections are closed opportunistically during broadcast cycles.
10. **CLI tool mediation**: ToolBroker policy/tokens are tested at the service boundary, but CLI-internal tool calls do not traverse it. Task admission and optional CLI/Docker sandboxing are separate controls.
11. **External audit anchoring**: Local HTTP acceptance/retry and durable records are tested; this is not proof of WORM retention, remote hash verification or automatic retry after restart.

Current executable evidence and remaining boundaries: [verification report](../reports/autonomous-audit-20260909/VERIFICATION_REPORT.md), [runtime matrix](../reports/autonomous-audit-20260909/RUNTIME_MATRIX.md), and [gap register](../reports/autonomous-audit-20260909/GAP_REGISTER.md). These are local audit results, not production certification.

## Recommended Production Configuration

```bash
# Required
JWT_SECRET=REDACTED

# Token expiry
JWT_EXPIRES_IN=15m

# Bootstrap admin
AUTH_BOOTSTRAP_ADMIN_EMAIL=admin@yourcompany.com
AUTH_BOOTSTRAP_ADMIN_PASSWORD=REDACTED

# CORS — restrict to your domain
CORS_ORIGINS=https://your-domain.com
```
