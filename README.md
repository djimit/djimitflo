# DjimFlo

**Self-evolving agentic operating system for serious engineering teams**

DjimFlo is a production-grade, self-evolving agentic OS that autonomously builds, tests, deploys, and improves its own code. It orchestrates expert agents, evaluates knowledge quality, and recursively enhances its own architecture.

> **Inspired by [ruflo](https://github.com/ruvnet/ruflo)** — the open-source agent orchestration framework by [ruvnet](https://github.com/ruvnet). DjimFlo extends those ideas into a full self-improving system.

## Status

| Metric | Value |
|--------|-------|
| Version | 0.6.0 |
| Tests | 1050+ |
| Services | 96 |
| Goals | 40 (Level 7-15) |
| Last Updated | 2026-07-01 |

## Capabilities

### Core Orchestration
- **Loop Daemon** — Autonomous goal queue with priority scheduling
- **Worker Pool** — Configurable parallel workers with retry (max 10)
- **Maker/Checker Separation** — Independent verification of all work
- **Worktree Isolation** — Git-based sandboxing per task
- **Multi-Runtime** — OpenCode, Codex, Pi, Claude, Gemini, Editor, Mock executors

### Intelligence
- **Expert Swarm Orchestrator** — Parallel expert agents per domain with skill injection
- **Judge Service** — 4-dimension scoring (evidence, source, consistency, uncertainty)
- **Knowledge Adapters** — Wikipedia, arXiv, OKF, DjimitKB
- **Causal Self-Model** — Intervention logging + counterfactual reasoning
- **GOAP A\* Planner** — State-space multi-step goal planning
- **Thompson Sampling Bandit** — Optimal explore/exploit runtime selection

### Self-Improvement (RSI Engine)
- **Service Refactoring Analyzer** — Decomposition proposals for large services
- **Emergent Specialization** — Dynamic agent specialization based on performance
- **Skill Evolution** — Post-run analysis + improvement proposals
- **Control Loop Self-Modification** — Proposal/evaluate/apply/rollback lifecycle
- **Meta-Evolution** — Periodic self-evaluation + capability pruning

### Safety & Governance
- **RSI Safety Guard** — Immutable audit log, mutation budget, kill switch
- **Capability Freeze** — Security/audit code immutable by self-modification
- **Dual-Approve** — Two reviewers required for structural changes
- **Epistemic Gates** — Source quality, consistency, coverage, falsifiability

## Architecture

DjimFlo is a TypeScript monorepo with three packages:

- **`@djimitflo/shared`** — Shared types and schemas
- **`@djimitflo/server`** — Express + SQLite backend with WebSocket support
- **`@djimitflo/dashboard`** — React + Vite + Tailwind frontend

### Backend Structure

```
packages/server/src/
├── routes/          # API endpoints (swarms, agents, tasks, loops, spawns)
├── services/        # 96 business logic services
│   ├── expert-swarm-orchestrator.ts
│   ├── judge-service.ts
│   ├── worker-pool.ts
│   ├── knowledge-adapters/  # Wikipedia, arXiv, OKF, DjimitKB
│   ├── causal-inference-service.ts
│   ├── emergent-specialization-service.ts
│   ├── service-refactoring-analyzer.ts
│   ├── rsi-safety-guard.ts
│   └── ... (86 more services)
├── execution/       # Execution engine + runtime executors
├── database/        # SQLite schema + migrations
└── middleware/      # Auth, rate limiting, security headers
```

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
npm install
npm run build
```

### Development

```bash
# Start both servers
npm run dev

# Or individually
npm run dev:server    # http://localhost:3001
npm run dev:dashboard # http://localhost:5173
```

### Access

- **Dashboard**: http://localhost:5173
- **API**: http://localhost:3001/api
- **WebSocket**: ws://localhost:3001/ws
- **Health Check**: http://localhost:3001/health

## API Endpoints

### Expert Swarm
- `POST /api/swarms/expert/dispatch` — Start expert swarm
- `GET  /api/swarms/expert/history` — Swarm history
- `GET  /api/swarms/expert/sources` — Available knowledge sources
- `GET  /api/swarms/expert/updates` — OKF knowledge updates

### RSI Engine
- `POST /api/swarms/rsi/analyze` — Analyze services for refactoring
- `GET  /api/swarms/rsi/proposals` — Refactoring proposals
- `GET  /api/swarms/rsi/specializations` — Agent specializations
- `GET  /api/swarms/rsi/safety` — Safety status
- `POST /api/swarms/rsi/safety/toggle` — Kill switch

### Core
- `GET  /api/swarms/status` — System status
- `POST /api/swarms/scheduler/tick` — Trigger daemon tick
- `GET  /api/swarms/proof-runs/latest` — Latest proof run
- `POST /api/swarms/proof-runs` — Start proof run

## Technology Stack

### Backend
- **Express** — HTTP server
- **better-sqlite3** — SQLite database
- **ws** — WebSocket server
- **TypeScript** — Strict mode

### Frontend
- **React 18** — UI framework
- **Vite 6** — Build tool
- **Tailwind CSS** — Styling

## License

MIT

## Author

Dennis Landman
DjimIT Consulting
2026
