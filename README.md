# DjimFlo

**Self-evolving agentic operating system for serious engineering teams**

DjimFlo is a production-grade, self-evolving agentic OS that autonomously builds, tests, deploys, and improves its own code. It orchestrates expert agents, evaluates knowledge quality, and recursively enhances its own architecture.

> **Inspired by [ruflo](https://github.com/ruvnet/ruflo)** — the open-source agent orchestration framework by [ruvnet](https://github.com/ruvnet). DjimFlo extends those ideas into a full self-improving system.

## Status

| Metric | Value |
|--------|-------|
| Version | 0.6.0 |
| Tests | 1103+ |
| Services | 110 |
| Goals | 50 (Level 7-18) |
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

### Memory & Knowledge
- **Central Memory Store** — Graph-projection memory with SQLite + InMemory
- **Memory Curator** — Raw episodes to structured memories
- **Autobiographical Memory** — Persistent life story of the system
- **Cognitive Memory** — Skill library + causal edges
- **Elastic Memory** — Auto-scaling memory tiers (hot/warm/cold)
- **Continual Learning** — Experience replay without forgetting

### Self-Improvement (RSI Engine)
- **Service Refactoring Analyzer** — Decomposition proposals for large services
- **Emergent Specialization** — Dynamic agent specialization based on performance
- **Skill Evolution Gym** — Exploration suite with evaluator + leaderboard
- **Prompt Pattern Registry** — Prompt templates with before/after evaluation
- **Self-Modification** — Proposal/eval/apply/rollback lifecycle with safety gates
- **Intrinsic Motivation** — Curiosity-driven exploration goal generation
- **Metacognitive Observer** — Real-time reasoning quality monitoring

### AI/ML Techniques (Level-18)
- **Contrastive Skill Miner** — Embedding-gelijkenis voor pattern deduplicatie
- **Meta-Learning Prompt Optimizer** — MAML voor snelle prompt adaptatie
- **RLHF Memory Ranker** — Reward-gedreven memory ranking
- **GNN Causal Model** — Graph Neural Network voor cross-agent causaliteit

### Safety & Governance
- **RSI Safety Guard** — Immutable audit log, mutation budget, kill switch
- **Capability Freeze** — Security/audit code immutable by self-modification
- **Epistemic Gates** — Source quality, consistency, coverage, falsifiability
- **Adversarial Input Validation** — Input integrity, poison detection
- **Autonomy Rollback** — Snapshot + filesystem freeze
- **Operator Intervention** — Human-in-the-loop for high-risk decisions

### Multi-Agent & Federation
- **MARL** — Multi-agent reinforcement learning with reward shaping
- **Theory of Mind** — Agent intent modeling + action prediction
- **A2A Registry** — Agent cards + memory-aware handoffs
- **Federation** — Cross-instance collaboration with capability tokens

## Architecture

DjimFlo is a TypeScript monorepo with three packages:

- **`@djimitflo/shared`** — Shared types and schemas
- **`@djimitflo/server`** — Express + SQLite backend with WebSocket support
- **`@djimitflo/dashboard`** — React + Vite + Tailwind frontend

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
