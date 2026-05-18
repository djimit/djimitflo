# Djimitflo - Quick Start Guide

Get up and running with Djimitflo in 60 seconds.

## Prerequisites

- Node.js 18+
- npm 9+
- (Optional) Docker for containerized deployment

## Installation

```bash
cd /Users/dlandman/djimitflo
npm install
```

## First-Time Setup

### 1. Build All Packages

```bash
npm run build
```

### 2. Configure Admin Account

Set environment variables before first startup:

```bash
export AUTH_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
export AUTH_BOOTSTRAP_ADMIN_PASSWORD=your-secure-password
export JWT_SECRET=your-jwt-secret-key
```

Or copy the example env file:

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Start the Server

```bash
npm run dev
```

This starts both:
- Backend server on `http://localhost:3001`
- Frontend dashboard on `http://localhost:5173`

### 4. Login

Open `http://localhost:5173` and login with your bootstrap admin credentials.

## Docker Deployment

```bash
cp .env.docker.example .env.docker
# Edit .env.docker — set JWT_SECRET and bootstrap admin credentials
docker compose up -d
```

See [docs/deployment.md](docs/deployment.md) for full Docker instructions.

## Access

- **Dashboard**: http://localhost:5173
- **API**: http://localhost:3001/api
- **WebSocket**: ws://localhost:3001/ws
- **Health Check**: http://localhost:3001/health

## User Roles

Djimitflo uses role-based access control:

| Role | Capabilities |
|------|-------------|
| **Admin** | Full access: manage users, backups, observability, all tasks |
| **Operator** | Create/execute tasks, approve requests, scan repositories |
| **Viewer** | Read-only: view tasks, evidence, repositories (with redacted secrets) |

Tasks are ownership-scoped: operators and viewers only see their own tasks. Admins see all.

## API Usage with Authentication

All API endpoints (except `/health` and `/api/auth/login`) require a JWT token:

```bash
# Login to get a token
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}' \
  | jq -r '.token')

# Use the token for authenticated requests
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/tasks

# List repositories (path/metadata redacted for non-admin)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/repositories

# Admin-only: observability metrics
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/observability/metrics
```

## Project Structure

```
djimitflo/
├── packages/
│   ├── shared/           # TypeScript types and schemas
│   ├── server/           # Express + SQLite backend
│   └── dashboard/        # React + Vite + Tailwind frontend
├── docs/                 # Documentation
├── .data/                # SQLite database (auto-created)
└── package.json
```

### Key Files

- **Backend entry**: `packages/server/src/index.ts`
- **Frontend entry**: `packages/dashboard/src/main.tsx`
- **Auth middleware**: `packages/server/src/middleware/auth.ts`
- **Auth service**: `packages/server/src/services/auth-service.ts`
- **Authorization**: `packages/server/src/services/authorization-service.ts`
- **Database migrations**: `packages/server/src/database/migrate.ts`
- **API routes**: `packages/server/src/routes/`

## Build for Production

```bash
npm run build

# Start production server
npm run start --workspace=@djimitflo/server
```

## Troubleshooting

### Port Already in Use

```bash
lsof -ti:3001 | xargs kill -9
lsof -ti:5173 | xargs kill -9
```

### Reset Database

```bash
rm .data/djimitflo.sqlite*
npm run dev  # Server will re-initialize and bootstrap admin
```

### WebSocket Not Connecting

1. Check backend: `curl http://localhost:3001/health`
2. Verify `.env.local` or `.env` settings
3. Check browser console for auth errors (token may have expired)

## Documentation

- [README.md](README.md) — Full project overview
- [docs/authorization.md](docs/authorization.md) — RBAC and ownership model
- [docs/auth.md](docs/auth.md) — Authentication details
- [docs/security.md](docs/security.md) — Security hardening notes
- [docs/deployment.md](docs/deployment.md) — Docker deployment
- [docs/backup-restore.md](docs/backup-restore.md) — Backup and restore
- [PHASE5_SUMMARY.md](PHASE5_SUMMARY.md) — Phase 5 changelog

---

**Happy Orchestrating!**