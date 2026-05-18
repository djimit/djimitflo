# Deployment Guide

## Prerequisites

- Docker 20.10+ and Docker Compose v2+
- At least 512MB RAM for the container
- Persistent storage for SQLite database

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/djimit/djimitflo.git
cd djimitflo

# 2. Create environment file from template
cp .env.docker.example .env.docker

# 3. Edit .env.docker — MUST change JWT_SECRET and bootstrap password
# Generate a strong JWT secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Build and start
docker compose up -d

# 5. Check health
curl http://localhost:3001/health
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret key for JWT signing. **Must be changed for production.** Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | Email for initial admin user (created on first startup only) |
| `AUTH_BOOTSTRAP_ADMIN_PASSWORD` | Password for initial admin user |

### Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ORIGINS` | `http://localhost:3001` | Comma-separated list of allowed origins |
| `JWT_EXPIRES_IN` | `24h` | Token expiration time |
| `DB_PATH` | `/data/djimitflo.sqlite` | SQLite database file path |
| `DASHBOARD_PATH` | `/app/packages/dashboard/dist` | Path to built dashboard files |
| `NODE_ENV` | `production` | Node environment |
| `PORT` | `3001` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |

| `BACKUP_DIR` | `<DATA_DIR>/backups` or `/data/backups` in Docker | Directory for backup archives |
| `DJIMITFLO_HOST_PORT` | `3001` | Docker host port mapping (in docker-compose.yml) |

### Optional (OpenCode Execution)

OpenCode is **not installed** in the Docker image by default. To enable it:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_BIN_PATH` | — | Path to OpenCode CLI binary. Must be mounted or installed separately. |
| `OPENCODE_EXECUTION_TIMEOUT_MS` | `600000` | Execution timeout (10 minutes) |
| `OPENCODE_SKIP_PERMISSIONS` | `false` | Bypass OpenCode permission prompts |
| `OPENCODE_OUTPUT_FORMAT` | `json` | Output format for structured parsing |

## Database Persistence

SQLite data is stored at `DB_PATH` (default: `/data/djimitflo.sqlite`).

Docker Compose mounts a named volume `djimitflo-data` at `/data`. This persists across container restarts.

### Backup & Restore

Djimitflo includes admin-only backup and restore via the REST API. Backups are consistent SQLite snapshots packaged as `.tar.gz` archives.

See [docs/backup-restore.md](backup-restore.md) for full documentation.

Quick reference:

```bash
# Create backup
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/backups

# List backups
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/backups

# Validate a backup
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/backups/backup-YYYYMMDD-HHMMSS.tar.gz/validate

# Stage a restore (requires restart)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESTORE"}' \
  http://localhost:3001/api/backups/backup-YYYYMMDD-HHMMSS.tar.gz/restore
```

Backups are stored in `BACKUP_DIR` (default: `/data/backups` in Docker, `<data-dir>/backups` in development).

### Migrations

Database migrations run automatically at server startup. The server will not start if migrations fail.

## First Admin Bootstrap

On first startup, if `AUTH_BOOTSTRAP_ADMIN_EMAIL` and `AUTH_BOOTSTRAP_ADMIN_PASSWORD` are set and no users exist, an admin user is created automatically.

```bash
# Login after bootstrap
curl -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}'
```

**Security notes:**
- Use a strong password for the bootstrap admin
- Change the password after first login if possible
- Remove or secure the `.env.docker` file — it contains secrets
- Never commit `.env.docker` to version control

## Health Check

The container includes a health check that hits `/health`:

```bash
# Manual health check
curl http://localhost:3001/health
```

Expected response:
```json
{"status":"healthy","timestamp":"...","uptime":123.456}
```

Docker Compose health check runs every 30 seconds with a 5-second timeout.

## Logs

```bash
# Follow logs
docker compose logs -f

# Server logs only
docker compose logs -f djimitflo
```

## Shutdown

```bash
# Stop containers (preserves data)
docker compose down

# Stop and remove volumes (DELETES DATA)
docker compose down -v
```

## Upgrade

```bash
# Pull latest changes and rebuild
git pull
docker compose build
docker compose up -d
```

Database migrations run automatically on startup. Review release notes for breaking changes before upgrading.

## OpenCode in Docker

OpenCode is **not included** in the Docker image. The `OPENCODE_BIN_PATH` environment variable defaults to a macOS path that does not exist in Linux containers.

### Option A: Mount the binary from the host

```yaml
# In docker-compose.yml, add a volume mount:
volumes:
  - /usr/local/bin/opencode:/usr/local/bin/opencode:ro
environment:
  - OPENCODE_BIN_PATH=/usr/local/bin/opencode
```

### Option B: Install in a derived image

```dockerfile
FROM djimitflo:latest
RUN curl -fsSL https://opencode.ai/install.sh | sh
ENV OPENCODE_BIN_PATH=/usr/local/bin/opencode
```

### Option C: Use Djimitflo without OpenCode

Djimitflo works without OpenCode. Task execution will fail gracefully if no OpenCode binary is available. The mock executor is still available for testing.

## Security Notes

1. **JWT_SECRET** must be a strong random secret in production
2. **Bootstrap password** should be changed after first login
3. **CORS_ORIGINS** should be restricted to your actual domain
4. **No rate limiting** on the login endpoint — consider a reverse proxy with rate limiting in production
5. **localStorage tokens** — the frontend stores JWT tokens in localStorage (see [docs/security.md](security.md))
6. **No HTTPS** — the container runs plain HTTP. Use a reverse proxy (nginx, Caddy, Traefik) for TLS termination in production

## Manual Frontend Smoke Test

After deploying, verify the following in a browser:

1. Open `http://localhost:3001` — should redirect to `/login`
2. Login with bootstrap credentials
3. Dashboard loads with task list
4. Navigate between pages (tasks, repositories, etc.)
5. Logout clears session and redirects to `/login`
6. Open browser DevTools → Network tab → verify `Authorization: Bearer` header on API calls

## Troubleshooting

### Container won't start

```bash
# Check logs
docker compose logs djimitflo

# Common issues:
# - JWT_SECRET not set → "FATAL: JWT_SECRET is required in production"
# - Port conflict → change PORT in .env.docker
```

### Database permission errors

```bash
# Check data directory ownership
docker compose exec djimitflo ls -la /data

# Fix permissions
docker compose exec djimitflo chown -R djimitflo:djimitflo /data
```

### Dashboard not loading

If you see the API but not the dashboard:
- Check that `DASHBOARD_PATH` points to a directory containing `index.html`
- Check container logs for "Dashboard not found" message
- If running in API-only mode, the dashboard won't be served