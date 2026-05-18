# Djimitflo

**AI agent orchestration control plane for serious engineering teams**

Djimitflo is a production-grade UX/UI control plane for managing AI agent workflows with a verified OpenCode executor integration and a Codex-oriented roadmap. It provides enterprise-grade task management, approval workflows, security policies, and comprehensive audit trails.

> **Inspired by [ruflo](https://github.com/ruvnet/ruflo)** — the open-source agent orchestration framework for Claude Code, by [ruvnet](https://github.com/ruvnet). Djimitflo builds on the ideas pioneered in ruflo, extending them with a full dashboard, governance, and enterprise control plane. Check out [ruflo on GitHub](https://github.com/ruvnet/ruflo) and [Agentics on LinkedIn](https://www.linkedin.com/company/agentics-org/posts/?feedView=all) for the broader vision of agent-native tooling.

## Features

- **Mission Control Dashboard** — Real-time monitoring of agent tasks and system health
- **Task Management** — Create, track, and manage agent execution with approval gates
- **Agent Monitoring** — Track agent status, capabilities, and performance metrics
- **Security-First** — Default-deny policies, risk assessment, and approval workflows
- **Audit Trail** — Comprehensive logging of all agent actions and decisions with actor attribution
- **Authentication & Authorization** — JWT authentication, role-based access control (admin/operator/viewer), protected routes
- **WebSocket Updates** — Real-time task and execution event streaming
- **MCP Integration** — Manage Model Context Protocol servers and tools
- **Repository Intelligence** — Git-aware scanning, stack detection, health scoring, AGENTS.md governance (Phase 4.4)
- **Diff Awareness** — Pre/post execution git snapshots, secret redaction, risk-classified file changes (Phase 4.4)

## Architecture

Djimitflo is a TypeScript monorepo with three packages:

- **`@djimitflo/shared`** — Shared types and schemas (backend + frontend)
- **`@djimitflo/server`** — Express + SQLite backend with WebSocket support
- **`@djimitflo/dashboard`** — React + Vite + Tailwind frontend

## Integration Compatibility

| Integration | Status | Details |
|-------------|--------|---------|
| **OpenCode** | Partially verified | CLI flags and JSON output verified against v1.15.4 |
| **Codex** | Not implemented | Type placeholder exists, no executor implementation |
| **Ruflo** | Conceptually mapped | No runtime dependency, conceptual inspiration only |

See [docs/integrations.md](docs/integrations.md) for full compatibility details.

## Known Limitations

- OpenCode session continuity (`--continue`, `--session`) not yet supported
- OpenCode MCP integration during execution not yet supported
- OpenCode agent selection passed through but not validated against known agents
- Codex executor requires CLI contract capture before implementation

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
# Install dependencies
npm install

# Build all packages
npm run build
```

### Development

Run the backend and frontend servers concurrently:

```bash
# Start both servers in parallel
npm run dev
```

Or run them individually:

```bash
# Start backend server (http://localhost:3001)
npm run dev:server

# Start frontend dashboard (http://localhost:5173)
npm run dev:dashboard
```

### Access

- **Dashboard**: http://localhost:5173
- **API**: http://localhost:3001/api
- **WebSocket**: ws://localhost:3001/ws
- **Health Check**: http://localhost:3001/health

### Docker Deployment

See [docs/deployment.md](docs/deployment.md) for full Docker deployment instructions.

```bash
# Quick start with Docker
cp .env.docker.example .env.docker
# Edit .env.docker — set JWT_SECRET and bootstrap admin credentials
docker compose up -d
```

## Project Structure

```
djimitflo/
├── packages/
│   ├── shared/           # Shared TypeScript types
│   │   └── src/
│   │       ├── types/    # Domain types (Task, Agent, MCP, Evidence, etc.)
│   │       └── index.ts
│   │
│   ├── server/           # Backend API server
│   │   └── src/
│   │       ├── routes/   # API endpoints
│   │       ├── database/ # SQLite schema and migrations
│   │       ├── services/ # Business logic (execution, evidence, diff capture, etc.)
│   │       ├── execution/ # Execution engine, executors, risk classification
│   │       └── middleware/
│   │
│   └── dashboard/        # Frontend React app
│       └── src/
│           ├── pages/    # Dashboard, Tasks, Repositories, Review, etc.
│           ├── components/
│           └── styles/   # Tailwind CSS
│
├── .data/                # SQLite database
├── templates/            # AGENTS.md templates
└── package.json
```

## API Endpoints

### Authentication
- `POST /api/auth/login` — Login with email and password (public)
- `GET /api/auth/me` — Get current authenticated user (requires auth)
- `POST /api/auth/logout` — Logout (stateless, public)

### Tasks
- `GET /api/tasks` — List tasks
- `GET /api/tasks/:id` — Get task by ID
- `POST /api/tasks` — Create task
- `PATCH /api/tasks/:id` — Update task
- `POST /api/tasks/:id/execute` — Execute task (with risk assessment and policy gating)
- `POST /api/tasks/:id/cancel` — Cancel running task

### Repositories (Phase 4.4)
- `GET /api/repositories` — List repositories
- `GET /api/repositories/:id` — Get repository details
- `POST /api/repositories/scan` — Scan a repository path
- `POST /api/repositories/:id/rescan` — Rescan repository
- `GET /api/repositories/:id/health` — Health findings and score
- `GET /api/repositories/:id/agents-md` — AGENTS.md files and issues
- `POST /api/repositories/:id/agents-md/validate` — Validate AGENTS.md governance
- `GET /api/repositories/:id/agents-md/effective` — Effective instruction stack

### Diffs (Phase 4.4)
- `GET /api/tasks/:taskId/diff` — Task diff with file changes and risk levels
- `GET /api/tasks/:taskId/file-changes` — File changes for a task
- `GET /api/tasks/:taskId/snapshots` — Pre/post execution git snapshots

### Evidence & Observability
- `GET /api/evidence/task/:taskId` — Execution evidence chain
- `GET /api/evidence/summary/:taskId` — Execution summary
- `GET /api/evidence/review/:taskId` — Full review package (task, summary, evidence, file changes, audit trail)
- `GET /api/observability/metrics` — System metrics
- `GET /api/observability/risk-trends` — Risk level trends
- `GET /api/observability/policy-stats` — Policy decision statistics

### Approvals & Policies
- `POST /api/approvals/:id/approve` — Approve a request
- `POST /api/approvals/:id/deny` — Deny a request
- `POST /api/policies` — Create approval policy
- `GET /api/policies` — List policies

### Agents
- `GET /api/agents` — List agents
- `GET /api/agents/:id` — Get agent by ID

### MCP
- `GET /api/mcp/servers` — List MCP servers
- `GET /api/mcp/tools` — List MCP tools

### Backups (admin only)
- `POST /api/backups` — Create backup
- `GET /api/backups` — List backups
- `GET /api/backups/:filename` — Get backup metadata
- `GET /api/backups/:filename/download` — Download backup archive
- `POST /api/backups/:filename/validate` — Validate backup integrity
- `POST /api/backups/:filename/restore` — Stage backup for restore (requires restart)

## Database Schema

Djimitflo uses SQLite with 20+ tables across 4 phases:

**Core**: `tasks`, `agents`, `execution_events`, `task_artifacts`, `mcp_servers`, `mcp_tools`, `repositories`, `audit_events`, `config`

**Phase 4.2 — Policy-aware execution**: `risk_assessments`, `policy_violations`, `approval_policies`, `approvals`

**Phase 4.3 — Evidence & observability**: `execution_evidence`, `execution_summaries`, `file_changes`

**Phase 4.4 — Repository intelligence**: `repository_scans`, `repository_health_findings`, `agents_md_files`, `agents_md_issues`, `task_repository_snapshots`

## Design System

Djimitflo uses a custom **djimit-\*** design token namespace with a dark-mode-first palette:

- Mission control aesthetic (enterprise monitoring)
- Semantic color system (status, risk, accent)
- Consistent spacing and typography
- Tailwind CSS + Radix UI primitives

## Development Roadmap

### Phase 1: Foundation (✅ COMPLETE)
- [x] Monorepo setup
- [x] Shared types package
- [x] Database schema
- [x] Express server skeleton
- [x] React dashboard shell
- [x] Mission control UI

### Phase 2: Core Functionality (✅ COMPLETE)
- [x] Task CRUD API implementation
- [x] WebSocket real-time updates
- [x] Live data integration (API → UI)
- [x] Task creation modal/form
- [x] Agent management UI
- [x] Zustand state management
- [x] Database seeding

### Phase 3: Security & Policies (✅ COMPLETE)
- [x] Task detail page with execution timeline
- [x] Execution event tracking and display
- [x] Approval workflow UI (approve/deny)
- [x] Approval request API
- [x] Risk level indicators
- [x] Tool call inspection
- [x] Audit log viewer
- [x] Policy management UI

### Phase 4: Integration & Governance (✅ COMPLETE)
- [x] OpenCode CLI executor with real command execution
- [x] Mock executor for testing
- [x] Execution engine with event streaming
- [x] Command risk classification (deterministic LOW/MEDIUM/HIGH/CRITICAL)
- [x] Policy decision service (priority-based matching)
- [x] Approval workflow with WebSocket broadcast
- [x] Evidence model (11 evidence types)
- [x] Observability API (metrics, risk trends, policy stats)
- [x] Review API and ReviewPage
- [x] Audit trail API and AuditPage
- [x] Repository intelligence (git status, stack detection, health scoring)
- [x] AGENTS.md governance (discovery, validation, effective instruction stack)
- [x] Diff awareness (pre/post git snapshots, secret redaction, risk-classified file changes)
- [x] Diff panel in ReviewPage with expandable diff viewer

### Phase 5: Integration Contract Stabilization, Auth & Deployment (In Progress)
- [x] OpenCode executor CLI flags corrected (--dir, --format json, --dangerously-skip-permissions, --agent)
- [x] Structured JSON event parsing with heuristic fallback and evidence warnings
- [x] Safety guardrail: OPENCODE_SKIP_PERMISSIONS defaults to false, audit event on bypass
- [x] Compatibility documentation (OpenCode partially verified, Codex not implemented, Ruflo conceptually mapped)
- [x] JWT authentication with bcryptjs password hashing (cost factor 12)
- [x] Role-based authorization (admin, operator, viewer) with permission-gated routes
- [x] Protected API routes — all operational routes require authentication
- [x] Audit actor attribution — authenticated user ID recorded in audit/evidence events
- [x] Frontend login flow, protected routes, role-aware sidebar
- [x] Docker deployment packaging (Dockerfile, docker-compose, entrypoint, health check)
- [x] Static serving + SPA fallback with safe Accept-header guard
- [x] Production-ready defaults (HOST=0.0.0.0, relative API base, dynamic WebSocket URL)
- [x] Multi-user ownership model (task, repository, approval ownership with visibility rules)
- [x] AuthorizationService with role-based and ownership-aware access control
- [x] Task ownership enforcement (created_by, owner_user_id, updated_by)
- [x] Approval actor attribution (decided_by, approved_by, requested_by using authenticated user IDs)
- [x] Evidence and review access scoped to underlying task ownership
- [x] Observability endpoints admin-only
- [x] Repository path/metadata redaction for non-admin users
- [x] MCP server secret redaction (env, command, args, url) for non-admin users
- [x] Legacy NULL-owned tasks visible to admin only
- [x] Backup & restore
- [ ] Export & reporting

## Technology Stack

### Backend
- **Express** — HTTP server
- **better-sqlite3** — SQLite database
- **ws** — WebSocket server
- **TypeScript** — Type safety
- **Zod** — Runtime validation

### Frontend
- **React 18** — UI framework
- **Vite 6** — Build tool
- **React Router** — Navigation
- **Tailwind CSS** — Styling
- **Radix UI** — Primitives
- **Lucide React** — Icons
- **Zustand** — State management

## Contributing

This is a personal project by Dennis Landman (DjimIT). Contributions are welcome but please open an issue first to discuss proposed changes.

## License

MIT

## Author

Dennis Landman
DjimIT Consulting
2026

---

**Status**: Phase 5.5 Complete (Multi-User Ownership Model)
**Version**: 0.5.5
**Last Updated**: May 2026