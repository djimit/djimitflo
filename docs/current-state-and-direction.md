# Djimitflo — Current State and Direction

**Date**: 2026-06-28  
**Version**: 0.5.8  
**Scope**: Reconciliation of README drift, integration-state drift, Phase 6 implementation reality, and Phase 7 strategic direction.

---

## Executive Summary

Djimitflo is an enterprise-grade UX/UI and governance control plane for AI agent workflows. Its center of gravity has shifted from basic task orchestration toward controlled agentic execution loops with policy gates, evidence capture, worker leases, worktree isolation, checker roles, security gates, and fleet-level observability.

Phase 6 (Agentic Control Loop Fleet) is approximately 95% complete as of this document. The remaining 5% consists of validation hardening, E2E tests, and API/user documentation. The README and integration documentation contain drift that this document reconciles.

This document replaces scattered status reports with a single canonical view, ties every claim to repo evidence, and defines a concrete convoy plan for release and Phase 7 design.

---

## Current Platform Capability Map

### 1. Core Platform

| Capability | Evidence | Status |
|-----------|---------|--------|
| TypeScript monorepo (workspaces) | `package.json` workspaces, `packages/shared`, `packages/server`, `packages/dashboard` | Implemented |
| Express + SQLite backend | `packages/server/src/` — server entry, `better-sqlite3` schema | Implemented |
| React + Vite + Tailwind dashboard | `packages/dashboard/src/` — App.tsx, Vite config | Implemented |
| WebSocket event streaming | `packages/server/src/services/websocket-service.ts`, `execution-engine.ts` broadcast methods | Implemented |
| Authenticated API surface | `packages/server/src/routes/*` — all operational routes protected by `requireAuth` | Implemented |
| JWT authentication and RBAC | `packages/server/src/middleware/auth.ts`, `authorization-service.ts` | Implemented |
| Ownership-aware access | `tasks.created_by/owner_user_id/updated_by`, `repositories.added_by`, `approvals.requested_by` | Implemented |

### 2. Governance and Security

| Capability | Evidence | Status |
|-----------|---------|--------|
| Default-deny policy posture | `command-risk-classifier.ts`, `policy-decision-service.ts`, `execution-engine.ts` deny branch | Implemented |
| Risk assessment | `command-risk-classifier.ts` — deterministic LOW/MEDIUM/HIGH/CRITICAL | Implemented |
| Approval policies and human approval | `approval-service.ts`, `routes/approvals.ts` | Implemented |
| Audit trail with actor attribution | `audit-service.ts`, `execution-engine.ts` audit records | Implemented |
| Evidence chain and review packages | `evidence-service.ts`, `GET /api/evidence/*` routes | Implemented |
| Secret/metadata redaction | `routes/repositories.ts` `sanitizeRepository`, `routes/mcp.ts` `sanitizeMCPServer` (non-admin) | Implemented |
| Backup, restore, export and reporting | `backup-service.ts`, `routes/backup.ts`, `routes/exports.ts` | Implemented |

### 3. Repository and Execution Intelligence

| Capability | Evidence | Status |
|-----------|---------|--------|
| Repository scanning | `routes/repositories.ts` `POST /api/repositories/scan` | Implemented |
| Git status and stack detection | `diff-capture-service.ts`, repository health findings | Implemented |
| AGENTS.md discovery and validation | `agents-md-validator.ts`, `routes/repositories.ts` agents-md endpoints | Implemented |
| Pre/post execution git snapshots | `execution-engine.ts` `capturePreExecutionDiff` / `capturePostExecutionDiff` | Implemented |
| Diff awareness and risk-classified file changes | `diff-capture-service.ts`, `GET /api/tasks/:taskId/file-changes` | Implemented |

### 4. Phase 6 Agentic Control Loop Fleet

| Capability | Evidence | Status |
|-----------|---------|--------|
| Loop service core | `packages/server/src/services/loop-service.ts` (5,594 LOC) | Implemented |
| Goals, loop runs, worker leases, findings, events schema | `loop-service.ts` types + `migrate.ts` Phase 56 tables | Implemented |
| Goals and loops API routes | `routes/goals.ts` (114 LOC), `routes/loops.ts` (298 LOC) | Implemented |
| Gate verification (deterministic, checker, security, human) | `routes/loops.ts` error mapping, `loop-service.ts` verify logic | Implemented |
| Worker roles (planner, maker, checker, security_checker, memory_curator, governance_guard) | `loop-service.ts` line 17 | Implemented |
| Worktree-per-lease isolation | `loop-service.ts` — branch prefix `agent/loop/`, `.djimitflo/` control dir | Implemented |
| Recovery via persisted checkpoints | `loop-recovery.test.ts` — 6 tests passing | Implemented |
| GoalsLoopsPage | `packages/dashboard/src/pages/GoalsLoopsPage.tsx` (599 LOC) | Implemented |
| FleetCockpitPage | `packages/dashboard/src/pages/FleetCockpitPage.tsx` (631 LOC) | Implemented |
| Phase 6 core tests | `loop-service.test.ts` (20 passing), `loop-recovery.test.ts` (6 passing) | Implemented |

---

## Integration Compatibility Map

Integration statuses use four precise labels:

- **not implemented** — no runtime code, no executor class.
- **implemented, unverified** — executor class exists and is registered, but live CLI/SDK contract is not yet verified against a real binary.
- **contract verified** — live binary contract verified (flags, JSON output, event schema), but long-running policy-engine E2E verification is still pending.
- **policy-engine E2E verified** — full end-to-end run through the Djimitflo policy engine, approval workflows, diff capture, and audit trail has been demonstrated.

| Integration | Status | Details | Evidence |
|-------------|--------|---------|---------|
| **OpenCode** | contract verified | CLI flags and NDJSON output verified against v1.15.4; permission bypass guardrails present; session continuity, MCP integration, and policy-engine E2E still unverified | `docs/integrations.md`, `docs/opencode.md`, `execution-engine.ts` registration |
| **Codex** | implemented, unverified | `CodexExecutor` exists in `executors/codex-executor.ts` and registered in `execution-engine.ts`; CLI contract anticipated but not yet verified against live binary | `docs/codex.md`, `execution-engine.ts` lines 19, 81 |
| **Pi** | contract verified | CLI contract verified 2026-06-20 against Pi 0.79.8 (`--mode json`, zero-egress Ollama smoke run); no permission bypass needed; long-running policy-engine E2E still unverified | `docs/pi.md`, `executors/pi-executor.ts`, `execution-engine.ts` lines 23, 85 |
| **Ruflo** | not implemented | Conceptual inspiration only; zero runtime code or dependency | `docs/integrations.md`, `docs/ruflo-compatibility.md` |
| **Claude** | implemented, unverified | Executor registered in `execution-engine.ts` (`ClaudeExecutor`); no CLI contract documentation found | `execution-engine.ts` line 20, 82 |
| **Gemini** | implemented, unverified | Executor registered in `execution-engine.ts` (`GeminiExecutor`); no CLI contract documentation found | `execution-engine.ts` line 21, 83 |
| **Editor** | implemented, unverified | Executor registered in `execution-engine.ts` (`EditorExecutor`); no CLI contract documentation found | `execution-engine.ts` line 22, 84 |

> **Security note**: Pi has no native permission popups and runs with launching-user permissions. Djimitflo’s policy engine is the sole boundary. Pi `bash` usage is classified as high-risk and should be containerized for sensitive repositories. `--dangerously-skip-permissions` (OpenCode) and `CODEX_SKIP_PERMISSIONS` (Codex) are guarded by Djimitflo safety defaults and audit events.

---

## Phase 6 Readiness Assessment

**Overall: ~95% complete.**

The heavy lift is done:
- Loop orchestration engine, gate verification, worker leases, and database schema are production-grade.
- Dashboard pages (`GoalsLoopsPage`, `FleetCockpitPage`) are complete and operationally usable.
- 26 core Phase 6 tests are documented as passing (`loop-service.test.ts` + `loop-recovery.test.ts`).

The remaining 5% is validation hardening, concurrency testing, and API/user documentation. No core buildout remains.

---

## Known Documentation Drift

| Drift | Location | Issue | Resolution |
|-------|---------|-------|-----------|
| README Phase framing | `README.md` | States Phase 5.7 complete, v0.5.8, Codex “Not implemented” | Phase 6 is substantially complete; Codex executor exists. Documented here as follow-up. |
| README integration table | `README.md` | Uses outdated labels (“Partially verified”, “Not implemented”, “Conceptually mapped”) | Replaced in this document with the four canonical labels. Follow-up README update bead recommended. |
| integrations.md terminology | `docs/integrations.md` | Uses mixed labels (“Partially verified”, “Implemented”) | Replaced in this document with canonical four-label system. |
| Undocumented executors | `execution-engine.ts` | Claude, Gemini, and Editor executors are registered but absent from `docs/integrations.md` | Listed above as “implemented, unverified”. Follow-up docs bead recommended. |
| PHASE5_SUMMARY.md | Root | Header says “HISTORICAL SNAPSHOT” for v0.5.5; current version is v0.5.8. Accurate as historical only. | No code change needed; preserve as historical record. |
| PHASE6_STATUS_REPORT.md | Root | Section “Not Yet Implemented” lists `GoalsLoopsPage.tsx` and `FleetCockpitPage.tsx` as missing | Both pages are now implemented. File is stale. Preserve as historical snapshot; reference this canonical doc. |
| PHASE6_DASHBOARD_COMPLETE.md | Root | Claims ~95% complete and lists remaining ~5%. Consistent with current state. | Preserve as historical snapshot; reference this canonical doc. |

---

## Remaining Release Blockers

Before Phase 6 is “release-grade”:

| Blocker | Type | Evidence |
|---------|------|---------|
| E2E goal → loop → maker → checker → security → complete test | Validation | `routes/goals.ts`, `routes/loops.ts` — endpoints exist but full lifecycle E2E not demonstrated |
| Multi-worker concurrency test (5 parallel makers in isolated worktrees) | Validation | `loop-service.ts` — worktree isolation exists, concurrency not proven |
| Git conflict resolution test | Validation | Worktree isolation exists, conflict handling not explicitly tested |
| Dashboard load test for high lease counts | Validation | `FleetCockpitPage.tsx` — 10-second refresh, no load profile captured |
| WebSocket reconnection and fallback test | Validation | `useWebSocket.ts` hook used, resilience not explicitly tested |
| API and user documentation | Documentation | `/api/goals`, `/api/loops` endpoints lack user-facing docs |

---

## Phase 6 Release Checklist

- [ ] E2E test: goal creation, loop start, maker execution, checker verification, security gate where needed, loop completion
- [ ] Multi-worker concurrency test with 5 parallel makers in isolated worktrees
- [ ] Git conflict resolution test
- [ ] Dashboard load test for high lease counts
- [ ] WebSocket reconnection and fallback test
- [ ] Document `/api/goals`, `/api/loops`, loop lifecycle, gate contracts, and dashboard user flows
- [ ] README reconciliation (see follow-up convoy)

---

## Phase 7 Strategic Direction

Phase 7 moves Djimitflo from a local dashboard into enterprise-grade control-plane territory. The following themes are decomposable into future beads.

### 1. Policy-as-Code and Compliance Mapping

- Map task risk, approvals, evidence, and audit events to NIST CSF, ISO 27001, and internal control objectives.
- Add exportable governance packs per task, loop, and release.
- Add policy simulation before execution.

### 2. Multi-Repository and Multi-Rig Orchestration

- Treat repositories as governed execution targets with capability profiles, trust levels, and execution constraints.
- Support cross-repo loop dependencies.
- Extend RBAC and audit trails across repository boundaries.

### 3. Executor Marketplace and Runtime Profiles

- Define runtime profiles: local sovereign, cloud API, high-risk sandbox, read-only review, offline mode.
- Make executor selection policy-driven, not user-preference-driven only.
- Formalize capability matrix (CLI contract, egress, permissions, tool allowlist, workdir isolation, event schema, token usage, failure modes, env vars).

### 4. Zero Trust Agent Execution

- Stronger least-privilege tool scoping.
- Per-task ephemeral worktrees.
- Optional containerized execution.
- Network egress profiles and secrets boundary enforcement.
- Signed evidence bundles.

### 5. Productization

- User management UI.
- Refresh-token lifecycle or short-lived session model.
- Deployment hardening and admin onboarding.
- Example workflows and demo loop catalog.
- Security model documentation.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Codex executor contract drift | High | Medium | Capture live contract before promoting to contract verified |
| OpenCode policy-engine E2E unverified | Medium | Medium | Add E2E test in Phase 6 final sprint |
| Pi runs with user permissions; `bash` enables escape from sandbox | Medium | High | Containerize `bash`-enabled Pi runs; enforce via policy gates |
| Claude / Gemini / Editor executors undocumented and unverified | Medium | Low | Document and categorize in executor trust-boundary bead |
| Phase 6 release without E2E coverage | Medium | High | Add E2E, concurrency, and resilience tests before release |
| No refresh tokens or password reset | Low | Medium | Productization bead for Phase 7 |
| README and docs contradict each other | High | Low | Fix README in follow-up convoy |
| Phase 6 dashboard load untested at scale | Low | Medium | Add load test before release |

---

## Recommended Next Beads (Convener Plan)

1. **phase6-e2e-validation**  
   Build E2E tests for goal → loop → maker/checker/security → close.

2. **phase6-concurrency-and-conflict-hardening**  
   Add 5-maker concurrency test and git conflict handling tests.

3. **executor-trust-boundary-matrix**  
   Formalize OpenCode, Codex, Pi, Claude, Gemini, and Editor runtime profiles, bypass controls, egress behavior, and audit events.

4. **readme-current-state-reconciliation**  
   Update README to reflect current architecture, integration state, and Phase 6 status.

5. **phase7-enterprise-control-plane-design**  
   Draft Phase 7 architecture with policy-as-code, compliance evidence, multi-repo orchestration, and Zero Trust execution profiles.
