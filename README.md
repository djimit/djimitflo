# DjimFlo

**Research-grade agentic governance laboratory for AI-assisted engineering**

[![Tests](https://img.shields.io/badge/tests-344%20passing-brightgreen)]()
[![Version](https://img.shields.io/badge/version-0.5.8-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6)]()
[![Security](https://img.shields.io/badge/security-hardened-success)]()

DjimFlo is a TypeScript monorepo backend + React dashboard for orchestrating AI coding agents, managing tasks across multiple runtimes, and governing agent behavior with approval workflows, policy enforcement, and audit trails.

**Status**: Research prototype. Not production-ready for sensitive data. See [Security Status](#security-status) and [Threat Model](.swarm/THREAT-MODEL.md).

---

## Table of Contents

- [Status](#status)
- [What DjimFlo Does](#what-djimflo-does)
- [Architecture](#architecture)
- [Security Status](#security-status)
- [Getting Started](#getting-started)
- [Development](#development)
- [License](#license)

---

## Status

| Metric | Value |
|--------|-------|
| **Version** | 0.5.8 (all packages) |
| **Tests** | 344+ passing |
| **Route Modules** | 67 |
| **API Endpoints** | ~556 |
| **Database Tables** | 72+ |
| **Agent Runtimes** | 7 (OpenCode, Codex, Claude, Gemini, Pi, Editor, Mock) |
| **Packages** | 8 workspaces |
| **Node** | >= 22 |
| **TypeScript** | 6.x strict mode |
| **Last Updated** | 2026-07-22 |

---

## What DjimFlo Does

### Task & Agent Management
- Create, assign, and track tasks across multiple AI coding agents
- Agent registry with capability tracking, status monitoring, and retirement workflows
- Multi-runtime execution engine with Docker sandbox isolation
- Real-time task output streaming via WebSocket

### Loop Execution Engine
- **Doc Drift Loop** — Scans repositories for documentation drift, TODO/FIXME markers
- **Self-Improvement Loop** — Code improvement via maker/checker workflow in disposable worktrees
- **GitHub Issue Loop** — Processes GitHub issues through maker/checker pipeline
- Each loop creates git worktrees for isolation, dispatches maker workers, then checker workers

### Approval & Governance
- Risk-classified approval workflow (low/medium/high/critical) with policy enforcement
- **ToolBroker** — mandatory policy enforcement point for all mutating actions
- **Self-approval prevention** — maker cannot approve their own requests (data-layer invariant)
- **Maker-checker-approver separation** — six distinct roles with granular permissions
- Compliance audit trail with cryptographic chain hashing and append-only enforcement
- SBOM generation (CycloneDX 1.6)

### Multi-Channel
- **REST API** — 556 endpoints across 67 route modules
- **WebSocket** — Real-time event streaming to dashboard (token via subprotocol, not URL)
- **MCP Server** — Tools for Claude Code / Cursor / VS Code integration
- **Telegram Bot** — Mobile task creation and approval

### Dashboard
- React 19 + Vite 8 + Tailwind CSS frontend
- Real-time agent status, task progress, and loop visualization

---

## Architecture

### Package Structure

```
djimitflo/
├── packages/
│   ├── shared/             # Shared types, role definitions, auth
│   ├── server/             # Express + SQLite backend (main package)
│   ├── dashboard/          # React + Vite frontend
│   ├── mcp-server/         # MCP server (stdio + HTTP transports)
│   ├── telegram/           # Telegram bot gateway (grammy)
│   ├── agent-catalog/      # Agent import from catalog files
│   ├── ransomware-module/  # Anti-ransomware detection (private)
│   └── knowledge/          # Knowledge storage (runtime-generated)
├── .swarm/                 # Threat model, evidence, security docs
├── Dockerfile              # Reproducible multi-stage build
└── docker-entrypoint.sh    # Container entrypoint
```

### Security Architecture

See [Threat Model](.swarm/THREAT-MODEL.md) for full STRIDE analysis.

**Trust Boundaries**:
1. External Internet → API Server (TLS 1.3, JWT 15min, CSP)
2. API Server → Database (append-only audit triggers, hash chain)
3. Execution Sandbox (Docker: non-root, cap-drop ALL, no-new-privileges, digest-pinned)
4. LLM Providers (per-task scoped credentials, classification-aware routing)

**Security Invariants** (all tested):
- Default deny for unknown tool calls
- Self-approval forbidden at data layer
- Audit log append-only via SQLite triggers
- Docker sandbox: non-root, read-only root, network isolated
- Plugins disabled by default, signature required
- Background workers only in operator/autonomous profile

### Role Model

| Role | Permissions |
|------|------------|
| **admin** | Full access |
| **platform_admin** | Config, users, backups, tokens (no execute) |
| **approver** | Approve tasks, read-only access |
| **maker** | Create tasks, write evidence/agents/skills |
| **checker** | Read-only + write evidence |
| **auditor** | Read audit trail, evidence, repositories |
| **viewer** | Read-only |

---

## Security Status

### Implemented
- [x] Docker container isolation (non-root, cap-drop, no-new-privileges, read-only root)
- [x] Image digest pinning (`@sha256:` required)
- [x] JWT 15-minute TTL with refresh token rotation
- [x] WebSocket token via subprotocol (not URL)
- [x] CSP headers (strict, frame-ancestors none)
- [x] Self-approval prevention (data-layer invariant)
- [x] Audit log append-only (SQLite triggers)
- [x] ToolBroker policy enforcement (default deny)
- [x] Plugin signature verification (default disabled)
- [x] SBOM generation (CycloneDX)
- [x] Data classification model (4 levels)
- [x] Maker-checker-approver separation
- [x] Threat model (STRIDE)
- [x] Path traversal guards in worktree operations

### Planned (Not Yet Implemented)
- [ ] OIDC/MFA integration
- [ ] PostgreSQL for production (SQLite is dev/demo only)
- [ ] External audit anchoring (Merkle root → WORM/SIEM)
- [ ] Step-up authentication for critical actions
- [ ] Container image scanning in CI
- [ ] GitHub Actions SHA pinning
- [ ] OpenAPI contract tests in CI
- [ ] Breaking-change detection for API
- [ ] DPIA for relevant use cases
- [ ] Backup encryption at rest

---

## Getting Started

### Prerequisites
- Node.js >= 22
- npm >= 9
- Docker (for sandboxed execution)

### Installation

```bash
git clone <repo>
cd djimitflo
npm install
```

### Development

```bash
# Start server + dashboard
npm run dev

# Server only
npm run dev:server

# Dashboard only
npm run dev:dashboard
```

### Build

```bash
# Build all workspaces
npm run build

# Build and run via Docker
docker build -t djimitflo:latest .
docker run -p 3001:3001 -v djimitflo-data:/data djimitflo:latest
```

### Testing

```bash
# All tests
npm run test

# Lint
npm run lint

# Type check
npm run type-check
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | (required in prod) | JWT signing secret |
| `JWT_EXPIRES_IN` | `15m` | Access token lifetime |
| `NODE_ENV` | `development` | Environment |
| `DB_PATH` | `./data/djimitflo.sqlite` | SQLite database path |
| `DOCKER_SANDBOX_IMAGE` | `djimitflo-runner:latest` | Sandbox image (must be digest-pinned) |
| `DOCKER_SANDBOX_SKIP_DIGEST_CHECK` | `false` | Skip digest check (NOT recommended) |
| `PLUGIN_TRUST_KEYS` | (empty) | Comma-separated trusted Ed25519 public keys |

---

## Epistemic Discipline

This project uses precise terminology:

| Term | Meaning |
|------|---------|
| "Immutable" | Append-only at SQLite trigger level; not externally anchored |
| "Compliant" | Control evidence exists; not certified by external auditor |
| "Sandboxed" | Docker container with isolation flags; not gVisor/Kata |
| "Policy-enforced" | ToolBroker evaluates; runtime enforcement limited to pre-execution |
| "Production-grade" | Research prototype; not validated for enterprise production |

Claims are falsifiable via the test suite. Green tests are necessary but not sufficient for production assurance.

---

## License

MIT (root repository). Sub-packages: MIT unless noted otherwise.

The `ransomware-module` package is marked `private: true` and is licensed MIT.

---

## Author

**Dennis Landman** — DjimIT Consulting — 2026
