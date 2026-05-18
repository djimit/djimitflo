# Security Risk Register

Djimitflo v0.5.8

## Risk Classification

| ID | Risk | Severity | Exploitability | Production Impact | Blocks Release? | Mitigation | Target Phase |
|---|---|---|---|---|---|---|---|
| SR-01 | 4 moderate npm audit vulnerabilities (esbuild/vite/vitest) | Medium | Low | Low | No | Vulnerabilities are in dev dependencies only, not in production runtime. `npm audit fix --force` would require Vitest 4 breaking change. | Deferred |
| SR-02 | No refresh tokens | Medium | N/A | Medium | No | Users re-authenticate after JWT expiry (default 24h). Documented limitation. | Phase 6 |
| SR-03 | No password reset | Low | N/A | Low | No | Bootstrap via environment variables. Admin can create new users via API. | Phase 6+ |
| SR-04 | No user management UI | Low | N/A | Low | No | Admin user creation via `AUTH_BOOTSTRAP_ADMIN_EMAIL/PASSWORD`. API supports user creation. | Phase 6+ |
| SR-05 | WebSocket query-string token | Medium | Medium | Medium | No | Token appears in WebSocket URL. Reverse proxies may log it. Documented: use WSS in production. | Phase 6+ |
| SR-06 | In-memory WebSocket connection map | Low | N/A | Medium | No | Single-instance deployment only. Not horizontally scalable. Redis pub/sub needed for multi-instance. | Phase 7+ |
| SR-07 | No distributed pub/sub | Low | N/A | Low | No | Single-server deployment model. WebSocket events not shared across instances. | Phase 7+ |
| SR-08 | No encrypted backups at rest | Medium | Low | Medium | No | Backup archives contain governance evidence and password hashes. Backup manifest warns of confidentiality. File-system permissions are the primary protection. | Phase 6+ |
| SR-09 | No backup retention policy | Low | N/A | Low | No | Backups accumulate indefinitely. Manual cleanup required. | Phase 6 |
| SR-10 | Docker runtime validation not performed locally | Low | N/A | Low | No | Docker build and compose validation deferred to AI workstation deployment. | Ongoing |
| SR-11 | localStorage token storage | Medium | High | Medium | No | Auth tokens stored in browser localStorage, accessible to XSS attacks. Mitigated by no inline scripts in production build (future CSP will reduce risk). | Phase 6 (CSP) |
| SR-12 | No rate limiting on non-login endpoints | Low | Low | Low | No | Login rate limiting implemented (10 attempts/IP/15min). Other endpoints not rate-limited. Reverse proxy rate limiting recommended for production. | Phase 6+ |
| SR-13 | Login rate limiting (in-memory) | Mitigated | N/A | N/A | N/A | IP-based rate limit: 10 failed attempts per IP per 15 minutes. Successful login resets counter. In-memory — not horizontally scalable. Redis-backed rate limiting recommended for production. | Ongoing |
| SR-14 | Security headers (partial) | Mitigated | N/A | N/A | N/A | X-Content-Type-Options, X-Frame-Options, Referrer-Policy, X-XSS-Protection set on all responses. CSP deferred due to Vite inline assets. | Phase 6 (CSP) |
| SR-15 | Logout is stateless and idempotent | Accepted | N/A | N/A | N/A | POST /auth/logout returns 200 with or without valid token. Server-side token revocation is not implemented. Client is responsible for clearing localStorage. Documented. | N/A |
| SR-16 | Content Security Policy not set | Medium | High | Medium | No | Vite-built dashboard uses inline styles (Tailwind) and may use inline scripts. A strict CSP would break the frontend. Deferred to Phase 6 with nonce-based CSP. | Phase 6 |

## Mitigations Implemented in Phase 5.7

1. **Login rate limiting** (SR-13): In-memory IP-based limiter on `POST /api/auth/login`. 10 attempts/IP/15 minutes. 429 response on limit exceeded.
2. **Security headers** (SR-14): X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy: strict-origin-when-cross-origin, X-XSS-Protection: 0.
3. **Policy read access gating**: `GET /api/policies` and `GET /api/policies/:id` now require `read:evidence` permission (all authenticated roles have this).
4. **Agent read access gating**: `GET /api/agents` and `GET /api/agents/:id` now require `read:evidence` permission and authentication.
5. **MCP tools/permissions read gating**: `GET /api/mcp/tools` and `GET /api/mcp/permissions` now require `read:repository` permission.
6. **Logout idempotency**: `POST /api/auth/logout` uses `optionalAuth`. Audit event recorded when token is valid. Same 200 response regardless of auth state. No token validity leaked.
7. **Login audit**: Successful logins now generate `auth.login` audit events.
8. **Documentation fixes**: Corrected JWT algorithm description, diff endpoint paths, stale references, historical banners on phase summaries.

## Release Blockers

None. All known risks are documented and have mitigations or accepted status.

## Recommended Next Phase Priorities

1. **CSP header** (SR-16): Implement nonce-based CSP that works with Vite builds
2. **Refresh tokens** (SR-02): Implement JWT refresh token rotation
3. **Encrypted backups** (SR-08): At-rest encryption for backup archives
4. **Redis-backed rate limiting** (SR-12, SR-13): Multi-instance compatible rate limiting
5. **User management UI** (SR-04): Admin interface for user CRUD