# Release Validation Checklist

## Pre-Release

- [ ] All packages build: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] Version references consistent across all package.json files, README, and version helper
- [ ] `npm audit` reviewed — known vulnerabilities documented in security-risk-register.md
- [ ] No secrets committed (grep for password, secret, token in source)
- [ ] No backup artifacts or export files committed

## Authentication Smoke Test

- [ ] Start server with clean database
- [ ] Bootstrap admin with `AUTH_BOOTSTRAP_ADMIN_EMAIL` and `AUTH_BOOTSTRAP_ADMIN_PASSWORD`
- [ ] Login as admin via `POST /api/auth/login`
- [ ] Verify `POST /api/auth/logout` returns 200 with and without token
- [ ] Create operator and viewer users
- [ ] Verify login rate limiting blocks after 10 failed attempts (429 response)
- [ ] Verify security headers present on all responses (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, X-XSS-Protection)

## Authorization Smoke Test

- [ ] Admin can access all tasks
- [ ] Operator can access own tasks only (404 for others)
- [ ] Viewer can access own tasks (read-only, 404 for others)
- [ ] Observability endpoints return 403 for non-admin
- [ ] Backup endpoints return 403 for non-admin
- [ ] Export audit endpoint returns 403 for non-admin

## Export & Reporting

- [ ] `POST /api/exports/task/:taskId` returns JSON, CSV, and Markdown
- [ ] Non-admin export redacts repository path, metadata, and diff content
- [ ] Admin export includes full data
- [ ] `POST /api/exports/audit` returns 403 for non-admin
- [ ] CSV export prefixes cells starting with `=`, `+`, `-`, `@` with single quote
- [ ] Export manifest includes appVersion, generatedAt, generatedBy, scope, redactionApplied
- [ ] No password_hash, JWT_SECRET, or auth tokens in any export format

## Backup & Restore

- [ ] `POST /api/backups` creates backup (admin-only)
- [ ] `GET /api/backups` lists backups
- [ ] `POST /api/backups/:filename/validate` validates integrity
- [ ] Non-admin receives 403 on backup endpoints

## WebSocket

- [ ] WebSocket connection requires valid JWT token via query string
- [ ] Expired tokens disconnect socket with code 4003
- [ ] Invalid tokens rejected with code 4002
- [ ] No token rejected with code 4001
- [ ] Broadcast events scoped by task ownership

## Database Migration

- [ ] Phase 5.2 tables (users) created
- [ ] Phase 5.5 columns (created_by, owner_user_id, updated_by, added_by, requested_by) added
- [ ] Legacy NULL-owned rows visible only to admin

## Docker (when available)

- [ ] `docker compose config` validates without errors
- [ ] `docker build` succeeds
- [ ] Container starts and passes health check at `/health`
- [ ] JWT_SECRET validation prevents production start without it
- [ ] Dashboard served at configured port

## Known Limitations (document, do not block release)

- 4 moderate npm audit vulnerabilities in esbuild/vite/vitest chain (deferred)
- No refresh tokens (users must re-authenticate)
- No password reset (environment variable bootstrap only)
- No user management UI
- WebSocket token via query string (use WSS in production)
- In-memory WebSocket connection map (single-instance only)
- No encrypted backups at rest
- localStorage token storage (XSS risk, documented mitigation)
- No rate limiting on non-login endpoints
- CSP header deferred to future phase
- Docker validation not performed locally (no Docker on development Mac)