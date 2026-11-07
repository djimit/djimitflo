---
type: architecture-map
title: Monorepo Layout & Package Boundaries
description: Map of the DjimFlo npm-workspaces monorepo — which package owns which responsibility, the build/test orchestration order, dependency direction, infrastructure services, and which directories are shipped runtime vs. research/evidence only.
tags: [monorepo, packages, architecture, build, npm-workspaces, typescript, layout]
verified:
  - by: openwiki/0.5.2
    at: 2026-11-07T14:47:55.436Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-8451388bda3e1da2037247f2
    resource: repo://docker-entrypoint.sh
  - id: openwiki-source-bb1ebe868e35e9e500714501
    resource: repo://Dockerfile
  - id: openwiki-source-1dee02dfa6d3d3a68d454e90
    resource: repo://infra/agent-registry/docker-compose.yml
  - id: openwiki-source-685e69fba2aef31dd69ad094
    resource: repo://infra/agent-registry/main.py
  - id: openwiki-source-dcd127225ac8b78b6af1ed66
    resource: repo://infra/event-bus/docker-compose.yml
  - id: openwiki-source-424f3f754659e20c51766ecd
    resource: repo://infra/event-bus/fleet_auth.py
  - id: openwiki-source-36699642c2feadaaaf9942fb
    resource: repo://infra/event-bus/main.py
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-a9eb2ee76f884ca1c31fa7b2
    resource: repo://packages/agent-catalog/src/catalog.ts
  - id: openwiki-source-b7903f53617234e2a4249d72
    resource: repo://packages/agent-catalog/src/index.ts
  - id: openwiki-source-30d3c41149038dfbadfcda67
    resource: repo://packages/dashboard/package.json
  - id: openwiki-source-ba912540c58d3dce145e1625
    resource: repo://packages/mcp-server/package.json
  - id: openwiki-source-35ac8c9a6fc2c825c488ce71
    resource: repo://packages/mcp-server/src/index.ts
  - id: openwiki-source-0a15ba0d6722e0f1d8dcd9fa
    resource: repo://packages/ransomware-module/package.json
  - id: openwiki-source-66445e7a06414fdc395c4e4c
    resource: repo://packages/ransomware-module/src/adapters/djimitflo-adapter.ts
  - id: openwiki-source-ca67081cf1201751f0c6cff7
    resource: repo://packages/ransomware-module/src/index.ts
  - id: openwiki-source-be80b8bb0c3f3a4106e1484a
    resource: repo://packages/server/package.json
  - id: openwiki-source-cc4d0e83b132a817843c3c21
    resource: repo://packages/server/src/__tests__/knowledge-runtime-service.test.ts
  - id: openwiki-source-922486a2b03bd894d1e9f283
    resource: repo://packages/server/src/index.ts
  - id: openwiki-source-d996649a2d736937a26f9180
    resource: repo://packages/server/src/routes/catalog.ts
  - id: openwiki-source-6297fe3ac71e1c1065021cd7
    resource: repo://packages/server/src/services/agent-catalog-service.ts
  - id: openwiki-source-7a4fe59adfe07a956b8bcfcf
    resource: repo://packages/server/src/services/knowledge-runtime-service.ts
  - id: openwiki-source-110994b7571271072b8016fb
    resource: repo://packages/server/src/services/loop-discovery-service.ts
  - id: openwiki-source-c83ceec2d47257f066951051
    resource: repo://packages/shared/package.json
  - id: openwiki-source-265221f77947a8a08e9a018a
    resource: repo://packages/shared/src/index.ts
  - id: openwiki-source-d441a5558c86cce9b01f7575
    resource: repo://packages/telegram/src/index.ts
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-4917d9267ae73f4a51d0b273
    resource: repo://skills/provider-step-usage-v1-0-0/run.test.mjs
generated: { by: "openwiki/0.5.2", at: "2026-11-07T14:47:55.436Z" }
---

# Monorepo Layout & Package Boundaries

DjimFlo is an npm-workspaces TypeScript monorepo rooted at the repository root.
The root `package.json` declares `workspaces: ["packages/*"]` and pins Node
`>=22 <25` with npm `>=9`. Every built package is private and versioned
together at `0.5.8`. The README describes the system as "7 npm workspaces +
knowledge runtime directory" plus the supporting `infra/`, `scripts/`,
`docs/`, `openspec/`, and `specs/` directories.

## Shipped runtime packages

These seven directories under `packages/` are npm workspaces: they have their
own `package.json`, their own `tsc` build, their own vitest suite, and their
own `dist/` output consumed by other workspaces or the production Docker
image.

| Package | npm name | Responsibility |
|---|---|---|
| `packages/shared` | `@djimitflo/shared` | Shared types, role definitions, Zod schemas, JWT helpers. The leaf dependency — every other built workspace depends on it. |
| `packages/server` | `@djimitflo/server` | The authoritative runtime: Express + SQLite backend, loop engine, services, routes, WebSocket server. Boots from `src/index.ts`. |
| `packages/dashboard` | `@djimitflo/dashboard` | React 19 + Vite frontend. Built to `dist/` and served statically by the server in production (`DASHBOARD_PATH`). |
| `packages/mcp-server` | `@djimitflo/mcp-server` | MCP server (stdio + HTTP transports) that exposes loops, goals, agents, governance, and OKF tools to Claude Code / Cursor / VS Code. Reads the same SQLite database the server uses. |
| `packages/telegram` | `@djimitflo/telegram` | Telegram bot gateway (grammy). Dynamically imported by the server when `TELEGRAM_BOTS_CONFIG` is set in the operator runtime profile. |
| `packages/agent-catalog` | `@djimitflo/agent-catalog` | Imports agency-agents Markdown profiles, normalizes them, runs a static injection/overlap gate, stores evaluations in its own SQLite file, compiles activation artifacts. Consumed by the server via `agent-catalog-service.ts`. |
| `packages/ransomware-module` | `@djimitflo/ransomware-module` | Defensive anti-agentic-ransomware detection (JADEPUFFER IoC patterns, behavioral signals, self-narration markers, forensic capture). Loosely coupled: no other package depends on it; it integrates through its own adapter. |

### Dependency direction

Dependency flow is strictly **one way, leaf-up**:

```
@djimitflo/shared  ──►  @djimitflo/server  ──►  (authoritative runtime)
                  ╲──►  @djimitflo/dashboard
                  ╲──►  @djimitflo/mcp-server
                  ╲──►  @djimitflo/agent-catalog  ──►  consumed by server
@djimitflo/telegram  ──►  dynamically imported by server (operator profile)
@djimitflo/ransomware-module  ──►  standalone, adapter-integrated, not a
                                   dependency of any other workspace
```

`@djimitflo/shared` is the only workspace that other workspaces declare as a
runtime dependency (`"*"` version). The server additionally depends on
`@djimitflo/agent-catalog`. The ransomware module and telegram gateway declare
no intra-monorepo dependencies; they are pulled in by the server at its own
init time (`import('@djimitflo/telegram')` inside a `try` block guarded by
`operatorRuntime` and `TELEGRAM_BOTS_CONFIG`, and a `console.log` flag check
for the ransomware module).

## Runtime-generated knowledge directory

`packages/knowledge/` is **not an npm workspace**. It has no `package.json`
and no build step. It is a runtime data directory (skills, context, memory)
that the server reads and writes. The canonical OKF (Operational Knowledge
Fabric) root is `<repo>/knowledge`, configured by `OKF_BASE`; the
`packages/knowledge` location is legacy, and the knowledge runtime service
explicitly **rejects** it as canonical
(`KnowledgeRuntimeService.resolveCanonicalOkfBase` throws
`KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL`). The loop-discovery
service treats `<repo>/knowledge` as canonical and `packages/knowledge` as a
fallback only.

The Docker image pre-creates writable directories under
`/app/packages/knowledge/skills`, `…/context`, and `…/memory` so the server
can drop runtime artifacts there, but the runtime never treats that path as
the authoritative knowledge bundle.

## Python fleet infrastructure

Two Python FastAPI services live outside the npm workspace entirely, under
`infra/`:

- **`infra/event-bus/`** — Redis-backed event stream service. Exposes
  `/events/{stream}` publish/read and consumer-group management. Deployed via
  its own `docker-compose.yml` (Redis 7 sidecar + uvicorn on port 8083).
- **`infra/agent-registry/`** — Agent heartbeat, live-agent registry, and
  shared-memory service (semantic memory backed by an embedding store).
  Deployed via its own `docker-compose.yml` (uvicorn on port 8088).

Both services share the same `fleet_auth.py` middleware, which is **not** the
same auth mechanism as the main TypeScript server. It is a per-host bearer
token scheme (`Authorization: Bearer <token>`) with three modes — `off`,
`log` (default), `enforce` — where the server stores only SHA-256 hashes of
host tokens in `FLEET_TOKENS_FILE` (default `/run/fleet/tokens`). Writes are
always protected; reads that return memory contents are also protected. The
token is a fleet secret, deliberately separate from the Djimitflo fleet-event
signing key. These services are operated independently of the main control
plane; they do not consume `@djimitflo/*` packages.

## Build and test orchestration

All orchestration is driven from the root `package.json`. The order matters.

### Build order

`npm run build` runs the workspace builds **in strict sequence**:

```
shared  →  telegram  →  agent-catalog  →  mcp-server  →  ransomware-module
        →  server  →  dashboard
```

This mirrors the dependency direction: shared types must exist before anything
that imports them; the server (which imports agent-catalog and telegram) is
built after all its library dependencies; the dashboard is built last because
it is a leaf consumed only at runtime (served as static files). There is no
parallel build; the `&&` chain in the root script makes failures stop the
pipeline immediately.

### Test pipeline

`npm run test` is a longer, ordered gate:

1. **Shell/self-test scripts** — `scripts/deploy-vps.selftest.sh`,
   `scripts/wiki-delta-emitter.selftest.sh`,
2. **Node script tests** (run directly with `node`, not vitest) —
   `live-identity-evidence.test.mjs`, `integration-probes.test.mjs`,
   `gen-agent-docs.mjs --check` and `gen-agent-docs.test.mjs`,
   `gym-worker.mjs --selfcheck` and `gym-worker.test.mjs`,
   `kb-sync.test.mjs`, `mutation-gain.test.mjs`,
   `skills/oracle-gate.test.mjs`, `skills/oracle-gate-replay.test.mjs`,
   `ci-workflows.test.mjs`, `host-scripts-dry-run.test.mjs`,
3. **Prerequisite builds** — `shared` and `agent-catalog` are built again so
   the vitest suites that follow have `dist/` available,
4. **Workspace vitest suites** — `npm run test --workspaces --if-present`
   (each workspace runs `vitest run --passWithNoTests`),
5. **Skill package tests** — `npm run test:skill-packages`, which runs
   `node --test skills/*/*.test.mjs` (Node's built-in test runner, not vitest)
   over the `skills/` directory (currently `skills/provider-step-usage-v1-0-0/run.test.mjs`).

`test:changed` is the narrower loop: it builds `shared` + `agent-catalog`,
then runs vitest with `--changed` under the server, shared, agent-catalog,
and mcp-server workspaces.

`type-check` builds `shared`, `agent-catalog`, `mcp-server`, and
`ransomware-module` first (so their `dist/index.d.ts` exists), then runs
`tsc --noEmit` across all workspaces.

## Research, evidence, and governance directories

Not everything in the repository is shipped runtime. The following are
research, evidence, or governance artifacts that the production image does
**not** execute:

| Directory | Role |
|---|---|
| `docs/` | Hand-written architecture docs, ADRs (`docs/adr/`), design notes, runbooks, security model. Some files are consumed at runtime by path (e.g. `docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml`, `docs/usage-plan-limits.json`), but the directory itself is documentation, not code. |
| `docs/research/` | Research protocols, experiment write-ups (TG-001, ACE, eco, Leviathan, etc.), recovery notes, and the negative-evidence registry. Evidence only. |
| `reports/` | Audit reports, gap registers, runtime-admission readiness, mutation reports. Historical baseline and evidence; not shipped runtime. |
| `openspec/` | Capability specs and change proposals. Finished work is archived under `openspec/changes/archive/`; active proposals live beside it. The core invariants spec (`openspec/specs/core-invariants/spec.md`) is the protected change-gate contract. |
| `specs/` | Speckit-style feature specs (`001-agent-catalog-page`, etc.) plus `bounded-contexts/` and a `constitution.md`. Design-time artifacts. |
| `benchmarks/` | Benchmark harnesses (`djimflo-self-benchmark.ts`, `realistic-test-suite.ts`). Not part of the built image. |
| `conversation_history/`, `tla/`, `.codex/`, `.opencode/` | Session logs, TLA+ specifications, and tool configs. Not runtime. |

## Dockerfile layout

The production image is a two-stage Dockerfile (`FROM node:22-bookworm-slim`
in both stages):

1. **Builder** — copies every workspace's `package.json` + `tsconfig.json`
   first (layer caching), runs `npm ci`, then copies workspace `src/` trees
   and runs `npm run build`.
2. **Runner** — installs production deps only (`npm ci --omit=dev`), copies
   `dist/` output from the builder stage for `shared`, `server`, `dashboard`,
   `telegram`, `agent-catalog`, and `mcp-server` (plus the agent-catalog
   `src/schema` files, which are read at runtime), installs pinned global
   agent CLIs and the `gh` CLI, creates the `djimitflo` user and the writable
   knowledge/report directories, and starts via `docker-entrypoint.sh` →
   `node packages/server/dist/index.js`.

The runner stage deliberately does **not** copy `ransomware-module/dist` or
any test/config from research directories; the module is a build-time-only
workspace in the image's eyes. Full Dockerfile details, env vars, and the
deploy receipt flow belong to
`openwiki/operations/local-development.md` and
`openwiki/operations/configuration-reference.md`.

## Extension points

- **New runtime package**: create under `packages/`, add its `package.json`
  with the `@djimitflo/` scope, add it to the root build chain in dependency
  order, add it to the `test:changed` workspace list if it should be exercised
  by the narrow loop, and add its `dist/` copy step to both Dockerfile stages.
- **New skill package**: add a directory under `skills/<name>/` with a
  `run.test.mjs`; it is picked up automatically by `test:skill-packages`
  (`node --test skills/*/*.test.mjs`).
- **New fleet service**: place it under `infra/<name>/` with its own
  `Dockerfile` and `docker-compose.yml`; reuse `fleet_auth.py` for host-token
  auth — do not wire it into the npm workspace graph.
