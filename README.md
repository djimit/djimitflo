# Djimitflo

**Codex-native agent orchestration control plane for serious engineering teams**

Djimitflo is a production-grade UX/UI control plane for managing AI agent workflows with OpenCode/Codex. It provides enterprise-grade task management, approval workflows, security policies, and comprehensive audit trails.

## Features

- **Mission Control Dashboard** - Real-time monitoring of agent tasks and system health
- **Task Management** - Create, track, and manage agent execution with approval gates
- **Agent Monitoring** - Track agent status, capabilities, and performance metrics
- **Security-First** - Default-deny policies, risk assessment, and approval workflows
- **Audit Trail** - Comprehensive logging of all agent actions and decisions
- **WebSocket Updates** - Real-time task and execution event streaming
- **MCP Integration** - Manage Model Context Protocol servers and tools

## Architecture

Djimitflo is a TypeScript monorepo with three packages:

- **`@djimitflo/shared`** - Shared types and schemas (backend + frontend)
- **`@djimitflo/server`** - Express + SQLite backend with WebSocket support
- **`@djimitflo/dashboard`** - React + Vite + Tailwind frontend

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

## Project Structure

```
djimitflo/
├── packages/
│   ├── shared/           # Shared TypeScript types
│   │   └── src/
│   │       ├── types/    # Domain types (Task, Agent, MCP, etc.)
│   │       └── index.ts
│   │
│   ├── server/           # Backend API server
│   │   └── src/
│   │       ├── routes/   # API endpoints
│   │       ├── database/ # SQLite schema and migrations
│   │       ├── services/ # WebSocket service
│   │       └── middleware/
│   │
│   └── dashboard/        # Frontend React app
│       └── src/
│           ├── pages/    # Dashboard, Tasks, Agents
│           ├── components/
│           └── styles/   # Tailwind CSS
│
├── .data/                # SQLite database
├── templates/            # AGENTS.md templates
└── package.json
```

## API Endpoints

### Tasks
- `GET /api/tasks` - List tasks
- `GET /api/tasks/:id` - Get task by ID
- `POST /api/tasks` - Create task
- `PATCH /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete task

### Agents
- `GET /api/agents` - List agents
- `GET /api/agents/:id` - Get agent by ID

### MCP
- `GET /api/mcp/servers` - List MCP servers
- `GET /api/mcp/tools` - List MCP tools

## Database Schema

Djimitflo uses SQLite with 14 tables:

- `tasks` - Task execution tracking
- `agents` - Agent configuration and metrics
- `execution_events` - Task execution timeline
- `task_artifacts` - Generated files, diffs, logs
- `mcp_servers` - MCP server registry
- `mcp_tools` - MCP tool permissions
- `sandbox_policies` - Security constraints
- `approval_policies` - Approval workflow rules
- `approvals` - Approval requests/decisions
- `instruction_profiles` - AGENTS.md templates
- `repositories` - Git repository tracking
- `audit_events` - Immutable audit log
- `config` - Application configuration

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
- [ ] Audit log viewer (deferred)
- [ ] Policy management UI (deferred)

### Phase 4: Integration (Planned)
- [ ] OpenCode CLI wrapper
- [ ] AGENTS.md validation
- [ ] Git repository integration
- [ ] MCP tool permission management

### Phase 5: Production Features (Planned)
- [ ] Authentication & authorization
- [ ] Multi-user support
- [ ] Backup & restore
- [ ] Export & reporting
- [ ] Docker deployment

## Technology Stack

### Backend
- **Express** - HTTP server
- **better-sqlite3** - SQLite database
- **ws** - WebSocket server
- **TypeScript** - Type safety
- **Zod** - Runtime validation

### Frontend
- **React 18** - UI framework
- **Vite 6** - Build tool
- **React Router** - Navigation
- **Tailwind CSS** - Styling
- **Radix UI** - Primitives
- **Lucide React** - Icons
- **Zustand** - State management

## Contributing

This is a personal project by Dennis Landman (DjimIT). Contributions are welcome but please open an issue first to discuss proposed changes.

## License

MIT

## Author

Dennis Landman  
DjimIT Consulting  
2026

---

**Status**: MVP Phase 3 Complete (Security & Policies)  
**Version**: 0.3.0  
**Last Updated**: May 2026
