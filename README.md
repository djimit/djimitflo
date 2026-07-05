# DjimFlo

**Self-evolving agentic operating system for serious engineering teams**

[![Tests](https://img.shields.io/badge/tests-1383%20passing-brightgreen)](https://github.com/djimit/djimitflo)
[![Version](https://img.shields.io/badge/version-6.0.0-blue)](https://github.com/djimit/djimitflo)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-13%20tools-purple)](https://modelcontextprotocol.io)

DjimFlo is a production-grade, self-evolving agentic OS that autonomously builds, tests, deploys, and improves its own code. It orchestrates expert agents, evaluates knowledge quality, and recursively enhances its own architecture.

> **Inspired by [ruflo](https://github.com/ruvnet/ruflo)** — the open-source agent orchestration framework by [ruvnet](https://github.com/ruvnet). DjimFlo extends those ideas into a full self-improving system.

---

## Status

| Metric | Value |
|--------|-------|
| **Version** | 7.0.0 (Apex Autonomous Swarm) |
| **Tests** | 1397 passing |
| **Services** | 150+ |
| **API Endpoints** | 90+ |
| **MCP Tools** | 13 |
| **Test Files** | 165 |
| **Graph Risk** | 0.00 (low) |
| **Last Updated** | 2026-07-05 |

---

## What's New in v7.0 (Apex Autonomous Swarm)

### Plugin Marketplace & Registry
Extensible plugin system with signature verification (SHA256/ed25519), capability registration, hook system, and per-plugin enable/disable. Community can extend DjimFlo without core code changes. Inspired by [Ruflo](https://github.com/ruvnet/ruflo) (35+ plugins).

### Vector Memory with Semantic Search
HNSW-inspired vector index for sub-ms semantic search over memories. Automatic embedding generation, relevance scoring, memory clustering for topic discovery, and TTL-based expiration.

### Background Workers (8 Auto-Triggered)
Continuous improvement without human intervention: health monitoring, test gap detection, memory archival, governance re-certification, worktree cleanup, metrics aggregation, orphan lease cleanup, and evidence compaction.

### Multi-Provider LLM Router
Intelligent routing across 5 providers (Anthropic, OpenAI, Google, Ollama, LiteLLM) with task-type optimization, cost-aware selection, latency tracking, and automatic failover on errors.

### Federation-Ready Architecture
Zero-trust cross-machine agent collaboration protocol with mTLS identity, PII-gated data flow, behavioral trust scoring, and compliance audit trails.

### MetaHarness Self-Audit
Grade your agent setup, scan for security risks, detect configuration drift, and track changes over time.

---

## Capabilities

### Core Orchestration
- **Loop Daemon** — Autonomous goal queue with priority scheduling
- **Worker Pool** — Configurable parallel workers with retry (max 10)
- **Maker/Checker Separation** — Independent verification of all work
- **Worktree Isolation** — Git-based sandboxing per task
- **Multi-Runtime** — OpenCode, Codex, Claude, Gemini, Editor, Pi, Mock executors

### Cognitive Architecture
- **Cognitive Loop Closure** — Episode recording → pattern extraction → strategy evolution → meta-learning
- **Proactive Memory** — Relevance-scored, self-maintaining memory with TTL decay and auto-promotion
- **Context Compression** — 60-95% token reduction via content-aware compression (JSON/code/text)
- **Workflow Graphs** — Branching, parallel, human-gated loop workflows via directed graph engine

### Multi-Agent Orchestration
- **Agent Handoffs** — Transfer work between agents with full context via MCP
- **Sub-Agent Spawning** — Isolated context windows with depth/cycle/budget gating
- **Fleet Mesh** — Cross-machine agent coordination with work distribution and capability sync
- **Multi-Model Intelligence** — Capability-aware model routing with dynamic selection and outcome learning

### Governance & Safety
- **OpenMythos Governance Benchmark** — 255 behavioral test cases across 11 categories
- **Runtime Governance** — Continuous behavioral monitoring with circuit breaker and quarantine
- **Compliance Audit Trail** — Immutable evidence chain with cryptographic hashing and NORA/SOC2 export
- **Adversarial Red Team** — 6 attack vectors testing injection, scope escape, privilege escalation, exfiltration
- **Input Validation** — ECLI format, file path traversal, XSS, SQL injection prevention

### Research & Intelligence
- **Citation Research Pipeline** — Source registration, trust scoring, contradiction detection, report generation
- **Expert Swarm Orchestrator** — Parallel expert agents per domain with skill injection
- **Judge Service** — 4-dimension scoring (evidence, source, consistency, uncertainty)
- **Legal RuleOps (UC-06)** — PII classification, rechtsgebied detection, anonymization pipeline

### Self-Improvement
- **Self-Modification Pipeline** — Analyze → plan → implement → test → evidence-gated PR
- **Skill Evolution Gym** — Exploration suite with evaluator + leaderboard
- **Service Refactoring** — Decomposition proposals with automated analysis
- **Emergent Specialization** — Dynamic agent specialization based on performance

### Integration & Channels
- **MCP Server** — 13 tools exposing loops, goals, agents, mission control, orchestration
- **Telegram Bot** — Mobile agent control with commands and approval workflows
- **Live Canvas** — Real-time agent output streaming via WebSocket REST API
- **Skills System** — Dynamic skill loading from SKILL.md with per-agent assignment
- **Plugin Marketplace** — Signature-verified plugins with hooks, tools, and routes
- **Vector Memory** — Semantic search with clustering and TTL expiration
- **Background Workers** — 8 auto-triggered continuous improvement workers
- **LLM Router** — 5-provider intelligent routing with failover

---

## Architecture

DjimFlo is a TypeScript monorepo (npm workspaces) with four packages:

| Package | Purpose | Technologies |
|---------|---------|-------------|
| `@djimitflo/shared` | Shared types and schemas | TypeScript |
| `@djimitflo/server` | Express + SQLite backend | Express, better-sqlite3, ws |
| `@djimitflo/dashboard` | React + Vite frontend | React 18, Vite 6, Tailwind CSS |
| `@djimitflo/mcp-server` | MCP server (stdio/HTTP) | @modelcontextprotocol/sdk |

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    DJIMFLO APEX v5.0                              │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │   Cognitive   │  │   Proactive   │  │    Fleet     │           │
│  │    Loop       │  │   Memory      │  │    Mesh      │           │
│  │   Closure     │  │              │  │              │           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
│         └──────────────────┼──────────────────┘                   │
│  ┌─────────────────────────┴─────────────────────────┐           │
│  │         CognitivePlatformOrchestrator               │           │
│  │              swarmEventBus (backbone)                │           │
│  └─────────────────────────┴─────────────────────────┘           │
│         │                  │                  │                   │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐           │
│  │   Runtime     │  │    Self-      │  │  Compliance  │           │
│  │  Governance   │  │  Modification │  │  Audit Trail │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              OpenMythos Governance Benchmark              │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
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
# Start both servers
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
| **Health Check** | http://localhost:3001/api/health |
| **Deep Health** | http://localhost:3001/api/health/deep |
| **Metrics** | http://localhost:3001/api/metrics |
| **MCP Server** | `node packages/mcp-server/dist/index.js --transport stdio` |

---

## API Endpoints

### Core
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Basic health check |
| GET | `/api/health/deep` | Deep health with dependency checks |
| GET | `/api/metrics` | Prometheus-format metrics |
| GET | `/api/metrics/json` | JSON-format metrics |
| GET | `/api/version` | API version |

### Loops & Goals
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/loops/runs` | List loop runs |
| POST | `/api/loops/start-doc-drift` | Start doc drift loop |
| POST | `/api/loops/runs/:id/continue` | Continue a loop run |
| POST | `/api/loops/runs/:id/execute-maker` | Execute maker worker |
| POST | `/api/loops/runs/:id/execute-checker` | Execute checker worker |
| POST | `/api/loops/runs/:id/verify` | Verify loop gates |
| POST | `/api/loops/runs/:id/complete` | Complete loop run |
| GET | `/api/goals` | List goals |
| POST | `/api/goals` | Create goal |

### Agents & Fleet
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List agents |
| GET | `/api/fleet/status` | Fleet status |
| POST | `/api/fleet/nodes` | Register fleet node |
| POST | `/api/fleet/handoff` | Agent handoff |
| POST | `/api/fleet/distribute` | Distribute work |

### Governance & Research
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/openmythos/eval/:agentId` | Run governance evaluation |
| GET | `/api/openmythos/score/:agentId` | Get governance scores |
| POST | `/api/legal/check-pii` | PII classification + anonymization |
| GET | `/api/legal/rechtsgebied/:ecli` | Detect rechtsgebied |
| POST | `/api/research/sources` | Register research source |
| POST | `/api/research/claims` | Create citation-linked claim |
| POST | `/api/research/reports/generate` | Generate research report |

### Cognitive & Memory
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cognitive/stats` | Cognitive loop statistics |
| POST | `/api/cognitive/extract-patterns` | Trigger pattern extraction |
| POST | `/api/cognitive/evolve-strategies` | Trigger strategy evolution |
| GET | `/api/memory/top` | Most relevant memories |
| POST | `/api/memory/store` | Store new memory |
| GET | `/api/memory/search` | Search memories |

### Swarm (v7.0)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/swarm-v2/sessions` | List active swarm sessions |
| POST | `/api/swarm-v2/sessions` | Create swarm session with task decomposition |
| POST | `/api/swarm-v2/sessions/:id/execute` | Start parallel execution |
| GET | `/api/swarm-v2/sessions/:id/progress` | Real-time progress |
| POST | `/api/swarm-v2/messages` | Send agent-to-agent message |
| GET | `/api/swarm-v2/messages/:agentId` | Receive messages for agent |
| POST | `/api/swarm-v2/broadcast` | Broadcast to all agents |

### Apex (v6.0)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/apex/plugins` | List registered plugins |
| POST | `/api/apex/plugins/:id/enable` | Enable a plugin |
| POST | `/api/apex/plugins/:id/disable` | Disable a plugin |
| POST | `/api/apex/memory/store` | Store vector memory |
| GET | `/api/apex/memory/search?q=` | Semantic memory search |
| GET | `/api/apex/memory/clusters` | Memory clusters |
| GET | `/api/apex/workers/status` | Background worker status |
| POST | `/api/apex/workers/:id/run` | Trigger worker manually |
| POST | `/api/apex/llm/route` | Route LLM request to optimal provider |
| GET | `/api/apex/llm/providers` | Provider health status |

### Advanced
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/runtime-governance/status` | Runtime governance status |
| GET | `/api/compliance/status` | Compliance status |
| POST | `/api/compliance/reports/generate` | Generate compliance report |
| POST | `/api/red-team/assess` | Run adversarial assessment |
| GET | `/api/platform/status` | Full platform status |
| POST | `/api/platform/cycle` | Run cognitive cycle |
| POST | `/api/canvas/sessions` | Create live canvas session |
| POST | `/api/feedback` | Submit governance feedback |
| GET | `/api/skills` | List loaded skills |
| POST | `/api/skills/reload` | Reload skills from disk |

---

## MCP Server

The MCP server exposes 13 tools for external agent integration:

| Tool | Description |
|------|-------------|
| `djimitflo_list_loop_runs` | List recent loop runs |
| `djimitflo_get_loop_status` | Get detailed loop status |
| `djimitflo_get_loop_catalog` | List available loop types |
| `djimitflo_list_goals` | List goals |
| `djimitflo_get_goal` | Get goal details |
| `djimitflo_list_agents` | List registered agents |
| `djimitflo_get_agent_status` | Get agent status |
| `djimitflo_get_mission_control` | Mission control overview |
| `djimitflo_get_system_health` | System health + table counts |
| `djimitflo_spawn_agent` | Spawn sub-agent with isolated context |
| `djimitflo_handoff_agent` | Transfer work between agents |
| `djimitflo_approve_action` | Request human approval |
| `djimitflo_list_agents` | List all agents with status |

### Claude Code / Cursor Integration

Add to your project's `.mcp.json`:

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
- **Express** — HTTP server with 60+ REST endpoints
- **better-sqlite3** — SQLite database with 80+ tables
- **ws** — WebSocket server for real-time events
- **TypeScript** — Strict mode, ESM modules
- **Vitest** — 1384 tests across 163 test files

### Frontend
- **React 18** — UI framework
- **Vite 6** — Build tool
- **Tailwind CSS** — Styling
- **React Flow** — Visual pipeline builder
- **Lucide Icons** — Icon library

### DevOps
- **npm workspaces** — Monorepo management
- **OpenSpec** — Spec-driven development
- **GitHub Actions** — CI/CD ready

---

## Governance Benchmark

DjimFlo includes the OpenMythos Governance Benchmark with 255 test cases:

| Category | Cases | Coverage |
|----------|-------|----------|
| Injection | 35 | ✅ |
| Hallucination | 30 | ✅ |
| Tool-scope | 28 | ✅ |
| Value-alignment | 25 | ✅ |
| Hierarchy | 25 | ✅ |
| Calibration | 22 | ✅ |
| Overthinking | 20 | ✅ |
| Contradiction | 20 | ✅ |
| Canary | 20 | ✅ |
| Temporal-reasoning | 15 | ✅ |
| Cross-lingual | 15 | ✅ |

---

## Evolutionary Roadmap (v7.0)

Based on analysis of top AI repos (wshobson/agents 37.5K★, AgentWrapper 8K★, ruflo):

### Phase 1: Swarm Engineering ✅
- [x] Parallel agent orchestration engine
- [x] Agent communication protocol (AI-native, structured JSON)
- [x] Task decomposition with DAG dependencies
- [x] Agent pool management with capability matching

### Phase 2: Skills Evolution ✅
- [x] Plugin marketplace with signature verification (SHA256/ed25519)
- [x] Skills genome system (crossover, mutation, selection)
- [x] Tiered model strategy (5 providers with intelligent routing)
- [x] PluginEval framework (static + LLM judge + Monte Carlo)

### Phase 3: Knowledge Graph ✅
- [x] Inter-agent knowledge sharing with contradiction detection
- [x] Vector memory with semantic search and clustering
- [x] Citation-gated research pipeline
- [x] Consensus mechanism for conflicting claims

### Phase 4: Self-Evolution ✅
- [x] Autonomous coder (scan → patch → validate)
- [x] Autonomous test generator (coverage-driven)
- [x] Autonomous documentation updater
- [x] Background workers (8 auto-triggered)

### Phase 5: Multi-Channel & Federation (Next)
- [x] Telegram bot integration
- [ ] Slack/Discord/WhatsApp/Signal gateway
- [ ] Zero-trust federation protocol (mTLS + ed25519)
- [ ] Web UI multi-model chat

## Version History

| Version | Date | Key Features |
|---------|------|-------------|
| **v7.0.0** | 2026-07-05 | **Evolutionary**: Swarm orchestration, agent communication protocol, parallel coding |
| **v6.0.0** | 2026-07-05 | **Apex Supreme**: Plugin marketplace, vector memory, background workers, LLM router |
| **v5.0.0** | 2026-07-05 | Security hardening, input validation, citation research, live canvas, skills system |
| **v4.0.0** | 2026-07-04 | All 5 sprongen complete (context isolation, handoffs, skills, citations, canvas) |
| **v3.0.0** | 2026-07-04 | Legal RuleOps UC-06, OpenMythos integration |
| **v2.0.0** | 2026-07-04 | Cognitive platform orchestrator, MCP server |
| **v1.0.0** | 2026-07-03 | Initial decomposition, runtime governance |

---

## License

MIT

## Author

**Dennis Landman**
DjimIT Consulting
2026
