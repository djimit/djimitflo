---
type: guide
title: DjimFlo Wiki Quickstart
description: Entry point to the DjimFlo wiki. Explains what DjimFlo is (a research-grade agent orchestration control plane with governance guardrails), how the wiki is organized, and routes you to the right page for your task.
tags: [quickstart, orientation, governance, agent-orchestration, wiki]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-25T13:29:02.244Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-e57612dc55cb1fe7d7373bd5
    resource: repo://packages/server/src/config/runtime-profile.ts
  - id: openwiki-source-922486a2b03bd894d1e9f283
    resource: repo://packages/server/src/index.ts
  - id: openwiki-source-13e7bffe2fd4d8b2a22e195d
    resource: repo://packages/server/src/routes/index.ts
  - id: openwiki-source-c83ceec2d47257f066951051
    resource: repo://packages/shared/package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "openwiki/0.5.2", at: "2026-09-25T13:29:02.244Z" }
---

# DjimFlo Wiki Quickstart

This is the entry point to the DjimFlo wiki. Find what DjimFlo is, decide what you
need to do, then follow the task-routing map to the page that covers it in depth.

## What is DjimFlo?

DjimFlo is a **research-grade agentic governance laboratory**: a TypeScript
npm-workspaces monorepo — a Node.js/Express + SQLite backend with a React
dashboard — for orchestrating AI coding agents, managing tasks across multiple
agent runtimes, and governing agent behavior with approval workflows, policy
enforcement, and audit trails. The root `package.json` describes it as a
"Codex-native agent orchestration control plane."

> **Status: research prototype.** DjimFlo is not production-ready for sensitive
> data. Adapter registration, rendered screens, and passing unit tests do not
> establish production readiness.

The spine of the system is a **single authoritative server**
(`packages/server`, published as `@djimitflo/server`). It boots from
`packages/server/src/index.ts`, which initializes the SQLite database, runs loop
and task crash recovery, wires services, mounts the API, and attaches the
WebSocket server. Behavior varies by runtime profile (`api`, `operator`,
`autonomous`) resolved from `DJIMITFLO_RUNTIME_PROFILE`.

Around this spine orbit several satellite surfaces:

- **Dashboard** (`packages/dashboard`) — React 19 + Vite frontend, served
  statically by the server in production.
- **MCP server** (`packages/mcp-server`) — exposes DjimFlo tools to Claude Code,
  Cursor, and VS Code.
- **Telegram bot** (`packages/telegram`) — mobile task creation and approval.
- **Agent catalog** (`packages/agent-catalog`) — agent import from catalog files.
- **Shared types** (`packages/shared`) — role definitions, auth, shared types.
- **Ransomware module** (`packages/ransomware-module`) — private anti-ransomware
  detection.
- **Knowledge runtime directory** (`packages/knowledge`) — runtime-generated
  knowledge storage.

## Reading discipline

The project follows an epistemic discipline you should apply when reading this
wiki. Terms mean exactly what they say:

| Term used | What it actually means |
|---|---|
| "Immutable" audit log | Append-only at the SQLite trigger level; not externally anchored |
| "Compliant" | Control evidence exists; not certified by an external auditor |
| "Sandboxed" | Docker container with isolation flags; not gVisor/Kata |
| "Policy-enforced" | ToolBroker evaluates calls; runtime enforcement is limited to pre-execution |
| "Production-grade" | Research prototype; not validated for enterprise production |

Claims in this wiki are intended to be falsifiable via the test suite. Green
tests are necessary but not sufficient for production assurance.

## How this wiki is organized

The wiki mirrors the system's architecture. Pages are grouped into domains:

- **`/openwiki/architecture/`** — structural maps: monorepo layout, runtime
  profiles, server startup composition, and the SQLite data model.
- **`/openwiki/concepts/`** — invariants and domain models: the governance
  pipeline, roles/permissions, executor adapters, loop lifecycle, and nested
  spawn/swarm trees.
- **`/openwiki/workflows/`** — end-to-end operational flows: task execution,
  approval decisions, maker–checker loops, and the autonomous improvement
  pipeline.
- **`/openwiki/operations/`** — operator runbooks: local development,
  configuration reference, backup/restore, knowledge runtime operations.
- **`/openwiki/integrations/`** — external surfaces: HTTP/WebSocket API,
  GitHub webhooks, MCP server, Telegram bot.
- **`/openwiki/testing/`** — verification strategy and assurance gates.

## Task-routing map

| You want to… | Go to |
|---|---|
<!-- openwiki: broken internal link [architecture/monorepo-layout.md] file "architecture/monorepo-layout.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Understand the repo structure and which package owns what | [Monorepo Layout & Package Boundaries](architecture/monorepo-layout.md) |
| Understand the `api` / `operator` / `autonomous` runtime profiles | [Runtime Profiles](architecture/runtime-profiles.md) |
| See how the server boots, wires services, and shuts down | [Server Runtime & Startup Composition](architecture/server-runtime.md) |
| Understand the SQLite schema, migrations, and provenance | [SQLite Data Model, Migrations & Provenance](architecture/data-model.md) |
| Understand the pre-execution governance spine (risk → policy → gate → ToolBroker → approval → audit) | [Governance Pipeline](concepts/governance-pipeline.md) |
| Review security invariants, trust boundaries, and known gaps | [Governance Pipeline](concepts/governance-pipeline.md) and [Roles, JWT Sessions & WebSocket Auth](concepts/roles-and-permissions.md) |
| Understand roles, JWT sessions, RBAC, and WebSocket auth | [AuthN/AuthZ: Roles, JWT Sessions & WebSocket Auth](concepts/roles-and-permissions.md) |
| Add or understand an agent runtime / executor adapter | [Agent Runtimes & Executor Adapters](concepts/runtime-executors.md) |
| Understand loop runs, leases, worktrees, and crash recovery | [Loop Domain Model](concepts/loop-lifecycle.md) |
| Understand nested spawning, swarm trees, and spawn budgets | [Nested Spawn & Swarm Trees](concepts/nested-spawn-hierarchy.md) |
| Understand memory sync, learning, and evolution subsystems | [Knowledge Runtime & OKF Bundle Operations](operations/knowledge-runtime.md) |
<!-- openwiki: broken internal link [workflows/task-execution-lifecycle.md] file "workflows/task-execution-lifecycle.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Trace a task from API call through execution to audit | [Task Execution Lifecycle](workflows/task-execution-lifecycle.md) |
| Understand the approval lifecycle across REST / WS / dashboard / Telegram | [Approval Request & Decision Flow](workflows/approval-decision-flow.md) |
| Understand doc-drift / self-improvement / issue loops end to end | [Maker–Checker Loop Execution](workflows/maker-checker-loop.md) |
| Understand autonomous goal → daemon → earned-autonomy operation (bandit selection, evolve lanes, J5 auto-approve, auto-deploy) | [Autonomous Goal → Daemon → Earned-Autonomy Pipeline](workflows/autonomous-improvement-pipeline.md) |
| Understand swarm trees, nested spawn delegation, and the daemon's goal dispatch | [Nested Spawn & Swarm Trees](concepts/nested-spawn-hierarchy.md) and [Maker–Checker Loop Execution](workflows/maker-checker-loop.md) |
| Set up local development, build, and run tests | [Local Development, Build & Test Commands](operations/local-development.md) |
| Look up environment variables and dangerous knobs | [Configuration & Environment Variable Reference](operations/configuration-reference.md) |
| Back up, restore, or manage data retention | [Backup, Restore & Data Retention](operations/backup-restore.md) |
| Operate the OKF knowledge bundle and capability sync | [Knowledge Runtime & OKF Bundle Operations](operations/knowledge-runtime.md) |
| Explore the REST/WebSocket API surface | [HTTP/WebSocket API Surface & Route Inventory](integrations/exposed-surface.md) |
| Integrate GitHub webhooks / PR review | [GitHub Integration](integrations/github-webhooks.md) |
| Connect Claude Code / Cursor / VS Code via MCP | [MCP Server Package](integrations/mcp-server.md) |
| Set up the Telegram bot gateway or webhook route | [Telegram Bot Gateway & Webhook Route](integrations/telegram-bot.md) |
| Understand how correctness is verified and gated | [Test Strategy, Assurance Scripts & Mutation Gate](testing/test-strategy.md) |

## Where to start

- **New to the codebase?** Start with
<!-- openwiki: broken internal link [architecture/monorepo-layout.md] file "architecture/monorepo-layout.md" does not exist. Fix the href or restore the target, then delete this comment. -->
  [Monorepo Layout & Package Boundaries](architecture/monorepo-layout.md), then
  [Server Runtime & Startup Composition](architecture/server-runtime.md), then
  [Local Development](operations/local-development.md).
- **Operating a deployment?** Start with
  [Configuration & Environment Variable Reference](operations/configuration-reference.md)
  and [Backup, Restore & Data Retention](operations/backup-restore.md).
- **Making a change to execution or governance?** Read the
  [Governance Pipeline](concepts/governance-pipeline.md) and
  [Roles & Permissions](concepts/roles-and-permissions.md) first, then the
<!-- openwiki: broken internal link [workflows/task-execution-lifecycle.md] file "workflows/task-execution-lifecycle.md" does not exist. Fix the href or restore the target, then delete this comment. -->
  [Task Execution Lifecycle](workflows/task-execution-lifecycle.md).
- **Working on autonomous operation?** Read the
  [Autonomous Goal → Daemon → Earned-Autonomy Pipeline](workflows/autonomous-improvement-pipeline.md)
  alongside [Maker–Checker Loop Execution](workflows/maker-checker-loop.md).
- **Evaluating assurance?** Read the
  [Test Strategy](testing/test-strategy.md) alongside the
  [Governance Pipeline](concepts/governance-pipeline.md).
