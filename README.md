# DjimFlo

**Agent orchestration control plane for AI-assisted engineering teams**

[![Tests](https://img.shields.io/badge/tests-1445%20passing-brightgreen)]()
[![Version](https://img.shields.io/badge/version-0.5.8-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6)]()
[![MCP](https://img.shields.io/badge/MCP-13%20tools-purple)]()

DjimFlo is a TypeScript monorepo backend + React dashboard for orchestrating AI coding agents, managing tasks across multiple runtimes, and governing agent behavior with approval workflows and audit trails.

---

## Status

| Metric | Value |
|--------|-------|
| **Version** | 0.5.8 |
| **Tests** | 1445 passing (128 test files) |
| **API Endpoints** | ~160 across 57 route modules |
| **MCP Tools** | 13 |
| **Database Tables** | 72 (21 base + 51 migration) |
| **Agent Runtimes** | 9 (OpenCode, Codex, Claude, Gemini, Pi, Editor, Mock, Data, Infra) |
| **Last Updated** | 2026-07-06 |

---

## What DjimFlo Does

### Task & Agent Management
- Create, assign, and track tasks across multiple AI coding agents
- Agent registry with capability tracking, status monitoring, and retirement workflows
- Multi-runtime execution engine with isolated subprocess spawning
- Real-time task output streaming via WebSocket

### Loop Execution Engine
- **Doc Drift Loop** — Scans repositories for documentation drift, TODO/FIXME markers, stale script references
- **Self-Improvement Loop** — Autonomous code improvement via maker/checker workflow
- **GitHub Issue Loop** — Processes GitHub issues through maker/checker pipeline
- Each loop creates git worktrees for isolation, dispatches maker workers, then checker workers

### Approval & Governance
- Risk-classified approval workflow (low/medium/high/critical)
- Policy-based gating with sandbox policies and instruction profiles
- Immutable compliance audit trail with cryptographic chain hashing
- OpenMythos Governance Benchmark integration (351 test cases across 11 categories)

### Multi-Channel
- **REST API** — 160+ endpoints for full platform control
- **WebSocket** — Real-time event streaming to dashboard
- **MCP Server** — 13 tools for Claude Code / Cursor / VS Code integration
- **Telegram Bot** — Mobile task creation and approval

### Dashboard
- React 18 + Vite 6 + Tailwind CSS frontend
- 48 components including React Flow pipeline builder
- Real-time agent status, task progress, and loop visualization

---

## Architecture

### Package Structure

```
djimitflo/
├── packages/
│   ├── shared/          # Shared types, schemas, role definitions
│   ├── telegram/        # Telegram bot gateway (grammy)
│   ├── agent-catalog/   # Agent import from catalog files
│   ├── server/          # Express + SQLite backend (main package)
│   ├── mcp-server/      # MCP server (stdio + HTTP transports)
│   └── dashboard/       # React + Vite frontend
```

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENTS                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ Dashboard │  │   MCP    │  │ Telegram │  │  REST    │            │
│  │  (React)  │  │  Server  │  │   Bot    │  │  Client  │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       └──────────────┴──────────────┴──────────────┘                │
│                              │                                       │
│                          WebSocket + HTTP                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                         SERVER                                       │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Express App (index.ts)                     │    │
│  │  • Auth (JWT + bcrypt)  • CORS  • Request Logger             │    │
│  │  • WebSocket Server     • Static Dashboard                   │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                              │                                       │
│  ┌──────────────────────────┴──────────────────────────────────┐    │
│  │                   Route Factories (57 modules)                │    │
│  │                                                               │    │
│  │  Core: tasks, agents, work-items, goals, loops, messages     │    │
│  │  Swarm: swarms, workers, spawns, intelligence, governance    │    │
│  │  Governance: approvals, policies, risk, compliance, audit    │    │
│  │  Evidence: evidence, discussions, research, citations        │    │
│  │  Cognitive: cognitive, memory, learning, self-improvement    │    │
│  │  Integration: openmythos, mcp, federation, telegram          │    │
│  │  Operations: health, backup, exports, usage, observability   │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                              │                                       │
│  ┌──────────────────────────┴──────────────────────────────────┐    │
│  │                    Services (114 files)                       │    │
│  │                                                               │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │    │
│  │  │ LoopService │  │ AuthService  │  │ ExecutionEngine  │    │    │
│  │  │ (loops,     │  │ (JWT, bcrypt,│  │ (9 executors,    │    │    │
│  │  │  worktrees, │  │  RBAC)       │  │  subprocess      │    │    │
│  │  │  maker/     │  │              │  │  spawning)       │    │    │
│  │  │  checker)   │  │              │  │                  │    │    │
│  │  └─────────────┘  └──────────────┘  └──────────────────┘    │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │    │
│  │  │ SwarmIntel  │  │ WorkerPool   │  │ ApprovalService  │    │    │
│  │  │ (missions,  │  │ (concurrency,│  │ (risk gating,    │    │    │
│  │  │  claims,    │  │  scheduling, │  │  policies,       │    │    │
│  │  │  panels)    │  │  drain)      │  │  sandbox)        │    │    │
│  │  └─────────────┘  └──────────────┘  └──────────────────┘    │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │    │
│  │  │ OpenMythos  │  │ Compliance   │  │ NestedSpawn      │    │    │
│  │  │ EvalService │  │ AuditService │  │ Service          │    │    │
│  │  │ (benchmark, │  │ (immutable   │  │ (depth/cycle/    │    │    │
│  │  │  LLM judge) │  │  chain hash) │  │  budget gating)  │    │    │
│  │  └─────────────┘  └──────────────┘  └──────────────────┘    │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                              │                                       │
│  ┌──────────────────────────┴──────────────────────────────────┐    │
│  │                  better-sqlite3 (72 tables)                   │    │
│  │  Base: tasks, agents, messages, work_items, goals, ...       │    │
│  │  Migration: loop_runs, worker_leases, swarm_sessions, ...    │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### Execution Engine

```
┌──────────────────────────────────────────────────────────────┐
│                     ExecutionEngine                           │
│                                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │
│  │OpenCode │ │  Codex  │ │ Claude  │ │ Gemini  │ │   Pi   │ │
│  │Executor │ │Executor │ │Executor │ │Executor │ │Executor│ │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └────────┘ │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │ Editor  │ │  Mock   │ │  Data   │ │  Infra  │            │
│  │Executor │ │Executor │ │Executor │ │Executor │            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│                                                               │
│  Features:                                                    │
│  • Subprocess spawning with env isolation                     │
│  • Timeout enforcement (configurable per runtime)             │
│  • stdout/stderr capture to evidence files                    │
│  • WebSocket streaming of execution output                    │
│  • Memory sync to UAMS/Qdrant (optional)                      │
└──────────────────────────────────────────────────────────────┘
```

### Loop Execution Flow

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Start   │───▶│ Discover │───▶│  Create  │───▶│ Dispatch │
│  Loop    │    │ Findings │    │ Worktree │  │  Maker   │
└──────────┘    └──────────┘    └──────────┘    └────┬─────┘
                                                       │
                                                       ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Close   │◀───│  Verify  │◀───│ Dispatch │◀───│  Maker   │
│  Loop    │    │  Gates   │    │ Checker  │    │ Complete │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm 9+

### Installation
```bash
git clone https://github.com/djimit/djimitflo.git
cd djimitflo
npm install
npm run build
```

### Development
```bash
# Start both server + dashboard
npm run dev

# Or individually
npm run dev:server    # http://localhost:3001
npm run dev:dashboard # http://localhost:5173
```

### Access

| Service | URL |
|---------|-----|
| **Dashboard** | http://localhost:5173 |
| **API** | http://localhost:3001/api |
| **WebSocket** | ws://localhost:3001/ws |
| **Health** | http://localhost:3001/api/health |

---

## API Overview

### Core Resources
| Resource | Endpoints |
|----------|-----------|
| **Tasks** | CRUD, execute, approve, evidence |
| **Agents** | Register, status, capabilities, retire |
| **Work Items** | CRUD, batch import, convert to goals |
| **Goals** | CRUD, batch preview/apply, risk classification |
| **Loops** | Start, continue, verify, complete, review-bundle |
| **Messages** | Send, receive, broadcast, read/unread |

### Swarm & Intelligence
| Resource | Endpoints |
|----------|-----------|
| **Swarm** | Sessions, specialist panels, claims, hypotheses |
| **Workers** | Pool plan, start, drain, stop, handoffs |
| **Missions** | Create, transition, tasks, decisions, capacity |
| **Governance** | Evaluate, runner manifests, proof runs |

### Governance & Compliance
| Resource | Endpoints |
|----------|-----------|
| **Approvals** | Request, approve, deny, pending queue |
| **Policies** | CRUD, sandbox policies, instruction profiles |
| **Risk** | Assessments, violations, evidence |
| **Compliance** | Audit trail, chain integrity, reports |
| **OpenMythos** | Eval runs, case results, scoring |

### Integration
| Resource | Endpoints |
|----------|-----------|
| **MCP** | Servers, tools, permissions |
| **Federation** | Peers, tokens, sync |
| **Telegram** | Bot config, webhook |
| **Research** | Sources, claims, reports, citations |

---

## MCP Server

13 tools exposed via stdio or HTTP transport:

| Tool | Category | Description |
|------|----------|-------------|
| `djimitflo_list_loop_runs` | Loops | List recent loop runs |
| `djimitflo_get_loop_status` | Loops | Get detailed loop status |
| `djimitflo_get_loop_catalog` | Loops | List available loop types |
| `djimitflo_list_goals` | Goals | List goals with status |
| `djimitflo_get_goal` | Goals | Get goal details |
| `djimitflo_list_agents` | Agents | List registered agents |
| `djimitflo_get_agent_status` | Agents | Get agent details |
| `djimitflo_get_mission_control` | Overview | Mission control dashboard |
| `djimitflo_get_system_health` | Overview | System health + table counts |
| `djimitflo_spawn_agent` | Orchestration | Spawn sub-agent with isolated context |
| `djimitflo_handoff_agent` | Orchestration | Transfer work between agents |
| `djimitflo_approve_action` | Orchestration | Request human approval |
| `djimitflo_list_agents` | Orchestration | List all agents with status |

### Claude Code / Cursor Integration

```json
{
  "mcpServers": {
    "djimitflo": {
      "command": "node",
      "args": ["./packages/mcp-server/dist/index.js", "--transport", "stdio"],
      "env": {
        "DJIMITFLO_DB": "./packages/server/.data/djimitflo.sqlite"
      }
    }
  }
}
```

---

## Technology Stack

### Backend
- **Express 4** — HTTP server with 160+ REST endpoints
- **better-sqlite3** — SQLite database with 72 tables
- **ws** — WebSocket server for real-time events
- **TypeScript 5** — Strict mode, ESM modules
- **Vitest** — 1445 tests across 128 test files
- **Zod** — Input validation at trust boundaries
- **bcryptjs + jsonwebtoken** — Authentication and authorization

### Frontend
- **React 18** — UI framework
- **Vite 6** — Build tool
- **Tailwind CSS** — Styling
- **React Flow** — Visual pipeline builder
- **Zustand** — State management

### DevOps
- **npm workspaces** — Monorepo management
- **Docker** — Container deployment ready

---

## OpenMythos Integration

DjimFlo integrates with the [OpenMythos](https://github.com/djimit/openmythos-benchmark) governance benchmark:

- **351 test cases** across 11 categories (injection, hallucination, tool-scope, value-alignment, hierarchy, calibration, overthinking, contradiction, canary, temporal-reasoning, cross-lingual)
- **LLM-as-Judge** scoring via Ollama (qwen2.5:14b-instruct)
- **Discrimination gate** to filter non-discriminating cases
- **Evolution bridge** for autonomous goal generation from benchmark results

---

## License

MIT

## Author

**Dennis Landman** — DjimIT Consulting — 2026
