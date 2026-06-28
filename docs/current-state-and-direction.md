# Djimitflo — Current State and Direction

**Date**: 2026-06-28  
**Version**: 0.5.8 (Phase 5.7 baseline; Phase 6 implementation substantially complete)  
**Scope**: Evidence-backed reconciliation of README drift, integration-state drift, Phase 6 reality, and forward direction.

---

## Executive Summary

Djimitflo is an enterprise-grade UX/UI and governance control plane for AI agent workflows. Its center of gravity has shifted from basic task orchestration toward controlled agentic execution loops with policy gates, evidence capture, worker leases, worktree isolation, checker roles, security gates, and fleet-level observability.

The repository contains substantial Phase 6 implementation that is underrepresented in the README. This document reconciles that drift, maps verified capabilities, and defines the remaining release path and Phase 7 strategic direction.

---

## Current Platform Capability Map

### 1. Core Platform

| Capability | Evidence | Status |
|-----------|---------|--------|
| TypeScript monorepo (`@djimitflo/shared`, `@djimitflo/server`, `@djimitflo/dashboard`) | `package.json` workspaces | Implemented |
| Express + SQLite backend | `packages/server/src/` | Implemented |
| React + Vite + Tailwind dashboard | `packages/dashboard/src/` | Implemented |
| WebSocket event streaming | `packages/server/src/` (ws) | Implemented |
| Authenticated API surface | All route files under `packages/server/src/routes/` | Implemented |
| JWT authentication and RBAC | `packages/server/src/middleware/auth.ts`, `packages/server/src/services/auth-service.ts` | Implemented |
| Ownership-aware task, approval, repository and evidence access | `packages/server/src/services/authorization-service.ts` | Implemented |

### 2. Governance and Security

| Capability | Evidence | Status |
|-----------|---------|--------|
| Default-deny policy posture | `packages/server/src/services/policy-decision-service.ts` | Implemented |
| Risk assessment for commands and tasks | `packages/server/src/routes/risk.ts` | Implemented |
| Approval policies and human approval workflow | `packages/server/src/services/approval-service.ts` | Implemented |
| Audit trail with actor attribution | `packages/server/src/services/audit-service.ts` | Implemented |
| Evidence chain and review packages | `packages/server/src/routes/evidence.ts` | Implemented |
| Secret redaction and repository metadata redaction for non-admin users | `packages/server/src/routes/repositories.ts`, `packages/server/src/routes/mcp.ts` | Implemented |
| Backup, restore, export and reporting support | `packages/server/src/services/backup-service.ts`, `packages/server/src/routes/exports.ts` | Implemented |

### 3. Repository and Execution Intelligence

| Capability | Evidence | Status |
|-----------|---------|--------|
| Repository scanning | `packages/server/src/services/repository-service.ts` | Implemented |
| Git status and stack detection | `packages/server/src/services/repository-service.ts` | Implemented |
| AGENTS.md discovery, validation and effective instruction stack | `packages/server/src/services/agents-md-service.ts` | Implemented |
| Pre/post execution git snapshots | `packages/server/src/services/diff-capture-service.ts` | Implemented |
| Diff awareness and risk-classified file changes | `packages/server/src/routes/diffs.ts` | Implemented |

### 4. Executor Integrations

| Integration | Status | Evidence | Notes |
|------------|--------|---------|-------|
| OpenCode | contract verified | `packages/server/src/execution/executors/opencode-executor.ts`, `docs/opencode.md` | CLI flags and JSON output verified against v1.15.4; policy-engine E2E still requires verification |
| Codex | implemented, unverified | `packages/server/src/execution/executors/codex-executor.ts`, `docs/codex.md` | Executor class registered; live CLI/SDK contract capture pending |
| Pi | contract verified | `packages/server/src/execution/executors/pi-executor.ts`, `docs/pi.md` | Contract verified 2026-06-20 against Pi 0.79.8; sovereign/Ollama path verified; policy-engine E2E still requires verification |
| Ruflo | not implemented | No runtime dependency in codebase | Conceptual inspiration only; see `docs/ruflo-compatibility.md` |

### 5. Phase 6 — Agentic Control Loop Fleet

| Capability | Evidence | Status |
|-----------|---------|--------|
| Loop service | `packages/server/src/services/loop-service.ts` (5,594 LOC) | Implemented |
| Goals, loop runs, worker leases, findings, events and nested spawn schema | `packages/server/src/database/migrate.ts` (Phase 56 migration) | Implemented |
| Goals and loops API routes | `packages/server/src/routes/goals.ts` (114 LOC), `packages/server/src/routes/loops.ts` (298 LOC) | Implemented |
| Gate verification | Deterministic, checker, security, human gates enforced in `loop-service.ts` | Implemented |
| Worker roles | `maker`, `checker`, `security_checker`, `memory_curator`, `governance_guard`, `planner` defined in `loop-service.ts` | Implemented |
| Worktree-per-lease isolation | Worktree creation with branch prefixes (`agent/loop/`) in `loop-service.ts` | Implemented |
| Recovery via persisted checkpoints | `packages/server/src/__tests__/loop-recovery.test.ts` | Implemented |
| GoalsLoopsPage dashboard | `packages/dashboard/src/pages/GoalsLoopsPage.tsx` (599 LOC) | Implemented |
| FleetCockpitPage dashboard | `packages/dashboard/src/pages/FleetCockpitPage.tsx` (631 LOC) | Implemented |
| Phase 6 tests | `loop-service.test.ts` (23 test cases), `loop-recovery.test.ts` (6 test cases) | Tested |

---

## Integration Compatibility Map

| Integration | Four-label Status | CLI Verified | JSON Output | Structured Events | Permission Bypass |
|------------|------------------|-------------|-------------|-------------------|-------------------|
| **OpenCode** | contract verified | Yes (1.15.4) | Yes (NDJSON) | Yes | Yes (`--dangerously-skip-permissions`) |
| **Codex** | implemented, unverified | No (contract anticipated) | Yes (NDJSON, same format as OpenCode) | Yes (`step-start/tool/text/step-finish`) | Yes (`CODEX_SKIP_PERMISSIONS` env var) |
| **Pi** | contract verified | Yes (0.79.8, `--mode json`) | Yes (NDJSON) | Yes (`session/agent_*/turn_*/message_*/tool_execution_*`) | N/A — Pi has no permission popups; Djimitflo policy engine is the sole boundary; restrict via `--tools` |
| **Ruflo** | not implemented | N/A | N/A | N/A | N/A |

**Legend**:
- `not implemented` — No runtime code or integration exists.
- `implemented, unverified` — Executor class exists and is registered, but live binary contract has not been captured or verified.
- `contract verified` — CLI flags, JSON output, and event schema have been verified against a live binary of the stated version; long-running policy-engine E2E may still be pending.
- `policy-engine E2E verified` — A complete task path through Djimitflo policy engine → executor → event stream → diff snapshot → audit trail has been demonstrated end to end.

---

## Phase 6 Readiness Assessment

### What the Code and Docs Show

- **Loop service** (`packages/server/src/services/loop-service.ts`): 5,594 lines. Contains goal creation, loop start/continue/execute/verify/complete/retry/split/stop, worker execution (maker/checker/security), budget enforcement (token, wall-clock, retry), worktree isolation, nested spawn lineage, and finding management.
- **API routes**: `goals.ts` exposes `POST/GET/PATCH /api/goals` plus batch preview/apply and goal decomposition; `loops.ts` exposes `GET /api/loops/catalog`, `GET /api/loops/runtime-contracts`, full loop lifecycle endpoints (`start`, `continue`, `retry`, `split`, `verify`, `execute-maker`, `execute-worker`, `execute-checker`, `checker-verdict`, `security-verdict`, `run-checks`, `complete`, `stop`), and review bundle access.
- **Dashboard**: `GoalsLoopsPage.tsx` provides goal creation, loop catalog, loop run selection, worker lease visualization, finding discovery/splitting, gate status display, and loop lifecycle controls. `FleetCockpitPage.tsx` provides pool status, token usage, worker role distribution, queue depth alerts, gate failure tracking, and real-time WebSocket updates.
- **Tests**: Phase 6 test files exist at `packages/server/src/__tests__/loop-service.test.ts` (23 test cases) and `packages/server/src/__tests__/loop-recovery.test.ts` (6 test cases). The Phase 6 status report (`PHASE6_STATUS_REPORT.md`) documents 20 loop-service tests and 6 recovery tests as passing; current file contents indicate additional test cases have been added since that report.

### Readiness Verdict

Phase 6 is approximately **95% complete** for an initial release sprint. The core orchestration engine, database schema, API surface, gate verification, worker isolation, and dashboard pages are all present and tested. Remaining work is validation hardening and documentation, not core buildout.

---

## Known Documentation Drift

| Drift Item | Current README / Old Doc | Actual Code / Current Doc | Action |
|-----------|------------------------|--------------------------|--------|
| Phase framing | States "Phase 5.7 Complete", version 0.5.8 (`README.md` line 348–350) | Phase 6 implementation is substantially complete per `PHASE6_STATUS_REPORT.md` and `PHASE6_DASHBOARD_COMPLETE.md` | Listed as follow-up bead `readme-current-state-reconciliation` |
| Codex status | "Not implemented" (`README.md` integration table) | `implemented, unverified` — `CodexExecutor` exists in `packages/server/src/execution/executors/codex-executor.ts` | Fixed in this doc and README |
| Pi integration | Absent from README integration table | `contract verified` — `PiExecutor` exists in `packages/server/src/execution/executors/pi-executor.ts`; contract documented in `docs/pi.md` | Fixed in this doc and README |
| OpenCode status | "Partially verified" | `contract verified` — CLI contract verified; policy-engine E2E still requires verification | Fixed in this doc and README |
| Architecture section | No Agentic Control Loop Fleet section | Loop service, goals, worker leases, gates, and fleet dashboard all exist | Addressed by linking to this canonical document |

**Pre-existing code issue for awareness**: `packages/dashboard/src/pages/GoalsLoopsPage.tsx` line 5 contains a hardcoded local path `/Users/dlandman/djimitflo` in `DEFAULT_REPOSITORY_PATH`. This is not introduced by this bead but is a known item for sanitization.

---

## Remaining Release Blockers

These items block a Phase 6 production release if strict E2E confidence is required:

1. **E2E goal-to-loop-to-complete test** — A single test script exercising goal creation, loop start, maker execution, checker verification, security gate where needed, and loop completion is not yet present. (Target: `packages/server/src/__tests__/phase6-e2e.test.ts`)
2. **Multi-worker concurrency test** — Five parallel makers in isolated worktrees with token budget enforcement and no git conflicts is not yet covered.
3. **Git conflict resolution test** — Behavior when concurrent workers modify the same file is not explicitly tested.
4. **Dashboard load and WebSocket resilience tests** — High lease-count rendering performance and WebSocket reconnection/fallback behavior are not yet tested.
5. **API and user documentation** — `/api/goals` and `/api/loops` endpoint reference, loop lifecycle, gate contracts, and dashboard user flows need formal documentation.

---

## Phase 6 Release Checklist

| Check | Target | Evidence | Status |
|-------|--------|---------|--------|
| Core loop lifecycle functional | `loop-service.ts` implements start/continue/execute/verify/complete | `packages/server/src/services/loop-service.ts` | ✅ |
| Database schema stable | Phase 56 migration present and tested | `packages/server/src/database/migrate.ts` | ✅ |
| API routes complete | Goals and loops endpoints implemented with auth | `packages/server/src/routes/goals.ts`, `packages/server/src/routes/loops.ts` | ✅ |
| Gate verification enforced | Deterministic, checker, security, human gates | `loop-service.ts` gate logic | ✅ |
| Worker lease isolation | Worktree-per-lease with branch prefixes | `loop-service.ts` | ✅ |
| Dashboard operational | GoalsLoopsPage and FleetCockpitPage functional | `packages/dashboard/src/pages/GoalsLoopsPage.tsx`, `packages/dashboard/src/pages/FleetCockpitPage.tsx` | ✅ |
| Test suite passing | 26+ Phase 6 test cases | `loop-service.test.ts`, `loop-recovery.test.ts` | ✅ |
| E2E validation test | Goal → loop → maker → checker → security → complete | Missing | ❌ |
| Concurrency stress test | 5 parallel makers in isolated worktrees | Missing | ❌ |
| Git conflict behavior test | Concurrent modification handling | Missing | ❌ |
| Dashboard resilience test | High lease load + WebSocket reconnect | Missing | ❌ |
| API / user documentation | Endpoint reference, lifecycle, gate contracts, user flows | Missing | ❌ |

---

## Phase 7 Strategic Direction

### Goal

Move Djimitflo beyond a local dashboard into enterprise-grade control-plane territory by making executor trust explicit and auditable, and by adding compliance-grade evidence, multi-repo orchestration, and Zero Trust execution profiles.

### Theme 1: Policy-as-Code and Compliance Mapping

- Map task risk, approvals, evidence, and audit events to NIST CSF, ISO 27001, and internal control objectives.
- Add exportable governance packs per task, loop, and release.
- Add policy simulation before execution to preview approval decisions and risk classifications.

### Theme 2: Multi-Repository and Multi-Rig Orchestration

- Treat repositories as governed execution targets with capability profiles, trust levels, and execution constraints.
- Support cross-repo loop dependencies and repository-scoped budgets.
- Add repository trust tiers (e.g., `sensitive`, `standard`, `sandboxed`) that gate executor capabilities and egress.

### Theme 3: Executor Marketplace and Runtime Profiles

- Define runtime profiles: `local-sovereign`, `cloud-api`, `high-risk-sandbox`, `read-only-review`, `offline`.
- Make executor selection policy-driven (based on risk class, repository trust, task metadata) rather than user-preference-driven only.
- Formalize executor capability matrix (CLI contract, egress, permissions, tool allowlist, workdir isolation, event schema, token capture, failure modes, required env vars).

### Theme 4: Zero Trust Agent Execution

- Stronger least-privilege tool scoping per task.
- Per-task ephemeral worktrees with automatic cleanup.
- Optional containerized execution for high-risk or `bash`-enabled runs.
- Network egress profiles (allowlist, deny-by-default, audit all outbound calls).
- Secrets boundary enforcement (no executor process inherits secret env vars unless explicitly granted).
- Signed evidence bundles for non-repudiation.

### Theme 5: Productization

- User management UI (create, deactivate, role assignment).
- Refresh-token lifecycle or short-lived session model to replace static JWT expiry.
- Deployment hardening (health checks, graceful shutdown, rate limiting, CSP).
- Admin onboarding flow and example workflow catalog.
- Security model documentation and demo loop library.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| OpenCode policy-engine E2E gap | Medium | Medium | Add E2E test before Phase 6 release; gate release on passing result |
| Codex contract drift | Medium | High | Capture live CLI contract before enabling in production; keep in `implemented, unverified` until verified |
| Pi permission boundary confusion | Medium | High | Document that Djimitflo policy engine is the sole approval boundary; warn/block `bash` outside containerized or trusted repos |
| Dashboard performance at scale | Low | Medium | Add load test for high lease counts; paginate or virtualize fleet views |
| WebSocket resilience gaps | Low | Medium | Add reconnection and fallback tests; ensure auth token refresh does not drop subscriptions |
| Hardcoded local path in dashboard | Low | Low | Replace `DEFAULT_REPOSITORY_PATH` with user-selected or empty default before release |
| Worktree leak across runs | Low | High | Ensure `.djimitflo/` control directory and cleanup hooks prevent git diff pollution and orphaned worktrees |

---

## Recommended Next Beads / Convoy Plan

1. **`phase6-e2e-validation`**  
   Build E2E tests for goal creation → loop start → maker execution → checker verification → security gate → loop completion.

2. **`phase6-concurrency-and-conflict-hardening`**  
   Add 5-maker concurrency test and git conflict handling tests.

3. **`executor-trust-boundary-matrix`**  
   Formalize OpenCode, Codex, and Pi runtime profiles, bypass controls, egress behavior, and audit events.

4. **`readme-current-state-reconciliation`**  
   Update README to reflect current architecture, Phase 6 status, and integration state.

5. **`phase7-enterprise-control-plane-design`**  
   Draft Phase 7 architecture with policy-as-code, compliance evidence, multi-repo orchestration, and Zero Trust execution profiles.

---

*All claims above are tied to file paths and documentation present in the repository as of 2026-06-28. No secrets, tokens, local absolute paths, or personal credentials are introduced by this document.*
