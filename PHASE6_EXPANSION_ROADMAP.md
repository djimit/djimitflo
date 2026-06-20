# Djimitflo Strategic Expansion Plan: Post-Phase 5 (v0.5.8)

> Comprehensive analysis of the 8 OpenSpec proposals with recommended sequencing, dependencies, and implementation strategy

Based on analysis of Djimitflo v0.5.8 (Phase 5 complete) and the eight OpenSpec expansion proposals in `/openspec/changes/`.

---

## Executive Summary

Djimitflo has graduated from a single-user development tool to a production-grade, multi-user AI agent orchestration control plane (Phase 5: Auth, RBAC, Docker, Backup, Multi-user Ownership).

The eight OpenSpec expansions represent a unified vision for transforming Djimitflo into a comprehensive **agentic swarm orchestration and governance platform** with three strategic vectors:

1. **Execution Excellence** — Control loops, fleet management, and runtime contracts
2. **Intelligence Layer** — Capability registry, specialist reasoning, and claim ledger
3. **Governance & Proof** — Enforced policies, evidence provenance, and operational proof

### Critical Path (7–9 months, 4–6 engineers)

```
Phase 6: Goal/Loop/Fleet (2–3 mo) → Foundation
    ↓
Phase 8: Fleet & Scale (1–2 mo) → Observability
    ↓
Phase 7: Swarm Intelligence (2–3 mo) → Kernel
    ↓
Phase 11: Enforcement Kernel (2 mo) → Governance
    ↓
Phase 12: Proof Runner (1 mo) → Validation
    ↓
Phase 9: Commit & Smoke (1 mo) → Testing
    ↓
Phase 10: Telegram Swarm (optional, 1 mo)
Phase 13: Nested Spawns (optional, 1 mo)
```

---

## Phase 6: Agentic Control Loop Fleet (L0–L3 Foundation)

**Status**: Mostly implemented | **Complexity**: HIGH | **Impact**: TRANSFORMATIONAL

### What It Enables
- Formal goal/loop/lease execution model with measurable acceptance criteria
- Fleet orchestration for multiple Codex/OpenCode workers in parallel
- Closed-loop verification with deterministic gates and checker validation
- First working loop: `doc-drift-and-small-fix-loop` (low-risk, high-value)

### Key Components
| Component | Status |
|-----------|--------|
| Loop Contract (goal, trigger, actions_allowed, verification, state, escalation) | Implemented |
| Goal Lifecycle (create → decompose → assign → monitor → close) | Implemented |
| Loop Lifecycle (start → step → run → verify → update-state → next) | Implemented |
| Fleet Model (maker/checker/security/memory/governance roles) | Implemented |
| Worktree Isolation (agent/loop/ branch prefixes; `.djimitflo/` control) | Implemented |
| Budget Model (token, wall-clock, concurrency, retry) | Implemented |
| Verification Gates (tests, lint, typecheck, security scan, reviewer) | Implemented |
| Memory Persistence (OKF/Markdown for state, decisions, lessons) | Implemented |
| Dashboard (Goals/Loops page, Fleet Cockpit) | Implemented |

### New Database Tables
```sql
goals (id, owner_user_id, objective, constraints, acceptance_criteria, risk_class, budget, status, created_at)
loop_runs (id, goal_id, status, trigger_type, stop_condition_met, state, created_at)
worker_leases (id, loop_run_id, role, runtime, status, worktree_path, token_budget, token_used, created_at)
loop_gates (id, loop_run_id, gate_type, status, evidence_refs, created_at)
```

### Critical Implementation Notes
- Maker output cannot bypass checker verdicts or deterministic gates
- Control artifacts in `.djimitflo/` prevent source diff pollution
- Loop state persisted to OKF/disk; resumable on server restart
- First loop must be low-risk, measurable, never auto-merge
- Real runtime evidence only (token usage, warnings, timeouts from actual Codex/OpenCode)

### Estimated Effort
- **Lines of Code**: 8k–12k
- **New Services**: 8–10 classes
- **Tests**: 80+ test cases
- **Duration**: 8–12 weeks

### Success Criteria
- ✓ Goal without acceptance criteria rejected
- ✓ 5 concurrent makers in separate worktrees, no git conflicts
- ✓ Checker verdict enforced; maker cannot bypass
- ✓ Dashboard shows full loop lifecycle
- ✓ `doc-drift-and-small-fix-loop` completes without merge

---

## Phase 7: Next-Level Swarm Skills & Specialists (G14 Intelligence Layer)

**Status**: Design complete, minimal implementation | **Complexity**: VERY HIGH | **Impact**: TRANSFORMATIONAL

### What It Enables
- Capability registry with typed contracts and eval scoring
- Specialist councils for multi-disciplinary analysis (math, physics, security, product, etc.)
- Hypothesis workbench for questions → validated backlog items
- Evidence graph and claim ledger to track operational truth vs. claims
- Capacity Governor V2 with queue classes and fair-share scheduling

### Key Components
| Component | Status |
|-----------|--------|
| Capability Registry (skills, specialists, runtimes; draft→candidate→validated→deprecated→disabled) | Design |
| Specialist Profiles (mathematician, physicist, security reviewer, architect, strategist, etc.) | Design |
| Hypothesis Workbench (question → evidence plan → panel → consensus+dissent → backlog) | Design |
| Evidence Graph (immutable nodes/edges: supports, refines, contradicts, sources) | Design |
| Claim Ledger (typed claims: proposed → supported → resolved; contradiction explicit) | Design |
| Capacity Governor V2 (queue classes: research, doc_fix, test_repair, security, memory, policy) | Design |
| Mission Control Dashboard (registry, planned work, prepared leases, blocked reasons) | Design |

### New Database Tables
```sql
swarm_capabilities (id, kind, owner, version, status, risk_ceiling, allowed_actions, forbidden_actions, created_at)
specialist_profiles (id, name, domain, owner, version, max_autonomy_level, created_at)
specialist_panels (id, question, evidence_plan, risk_class, status, consensus_findings, dissent_preserved, created_at)
swarm_claims (id, subject_ref, predicate, object, status, evidence_refs, supports_refs, contradicts_refs, created_at)
evidence_graph_nodes (id, kind, ref_id, properties, created_at)
evidence_graph_edges (id, source_node_id, target_node_id, relationship, created_at)
queue_classes (id, name, priority, weight, max_concurrency, token_budget, wall_clock_budget_ms, created_at)
capacity_scheduler_decisions (id, lease_id, decision, blocked_reason, cpu_load, memory_pct, created_at)
```

### Critical Implementation Notes
- Only `validated` capabilities can route live workers
- Claim contradiction is explicit in graph edges; no auto-inference
- No auto-learning of policy/security rules without human approval
- Hypothesis workbench bounded by discovery budget
- Fair-share scheduler prevents research from starving fixes

### Estimated Effort
- **Lines of Code**: 12k–16k
- **New Services**: 10–12 classes
- **Tests**: 100+ test cases
- **Duration**: 8–12 weeks

### Success Criteria
- ✓ Draft/candidate capabilities block live worker routing
- ✓ Panel records support/oppose/uncertainty; dissent preserved
- ✓ Claim contradictions explicit; no false negatives
- ✓ Capacity Governor explains blocked/queued/eligible/running decisions
- ✓ Hypothesis workbench creates backlog without spawning workers

---

## Phase 8: Real Worker Fleet Functionality & Scale (G16 Proof)

**Status**: Mostly implemented | **Complexity**: HIGH | **Impact**: OPERATIONAL

### What It Enables
- Runtime contract validation before execution (prevent CLI drift)
- Low-context worker profile for small bounded tasks
- Checker worker execution bridge (read-only, independent)
- Auto-verify loop closure (deterministic → checker → security → ready_for_human_merge)
- Fleet Cockpit showing pool status, queue depth, tokens, warnings

### Key Components
| Component | Status |
|-----------|--------|
| Runtime Contract Harness (probe Codex/OpenCode flags before execution) | Implemented |
| Low-Context Worker Profile (minimal tools, conservative token ceiling) | Implemented |
| Checker Worker Bridge (read-only, independent, separate worktree) | Implemented |
| Control Artifact Isolation (`.djimitflo/` directory, ignored in git) | Implemented |
| Runtime Warning Parser (plugin errors, skill budget, unavailable tools) | Implemented |
| Auto-Verify Closure (deterministic → checker → security → ready_for_merge) | Implemented |
| Fleet Cockpit Dashboard (pool topology, queue, tokens, warnings, next actions) | Implemented |
| Goals Batch Model (`goals.batch.json` with ordered goals and dependencies) | Implemented |

### New Database Tables
```sql
runtime_contracts (id, runtime, version, command, cwdFlag, jsonFlag, lastProbedAt, status, created_at)
runtime_warnings (id, lease_id, warning_type, severity, message, raw_output, created_at)
fleet_pool_status (materialized view: runtime, available, prepared, queued, running, completed, failed, created_at)
```

### Critical Implementation Notes
- Drifted contract blocks execution with actionable error
- Checker assigned to different worktree; never same lease as maker
- Real runtime usage from JSONL; tokens per successful worker visible
- Prepared leases ≠ active workers (Fleet Cockpit labels accurately)
- Batch `/goals` registers intent; execution flows through gates

### Estimated Effort
- **Lines of Code**: 4k–6k
- **New Services**: 3–4 classes
- **Tests**: 40+ test cases
- **Duration**: 4–6 weeks

### Success Criteria
- ✓ Drifted contract blocks worker with actionable error
- ✓ Fleet pool status shows prepared/running/completed/failed counts
- ✓ Token usage parsed from runtime; tokens per worker visible
- ✓ Fleet Cockpit renders with actual data (no mocking)
- ✓ Goals batch dry-run emits ordered goals

---

## Phase 9: Commit, Workstation Smoke & Policy Runner (G17 Integration)

**Status**: Design complete | **Complexity**: MEDIUM | **Impact**: OPERATIONAL

### What It Enables
- Selective commit gate (freeze validated work without local drift)
- Workstation live smoke checks (health, API, contracts, swarm status)
- Real Codex/OpenCode smoke tests (temp DB/repo, bounded budget, no merge)
- Policy-gated worker pool runner (controlled multi-worker execution)

### Key Components
| Component | Status |
|-----------|--------|
| Selective Commit Gate (freeze loop/fleet scope; exclude env, build outputs) | Design |
| Workstation Live Smoke (health, `/api/loops/runtime-contracts`, Fleet Cockpit) | Design |
| Real Smoke Tests (temp DB/repo, bounded timeout, explicit token budget, artifacts verified) | Design |
| Policy-Gated Runner (select next lease, check contract/capacity/risk, enforce budgets) | Design |

### Critical Implementation Notes
- Use `git add` for explicit paths only; never `git add -A`
- Smoke is non-destructive (temp DB/repo, rollback removes only smoke records)
- No merge/push/deploy in smoke (gates pass, human approval required for release)
- Policy runner is synchronous (each worker sequentially, backpressure on failure)
- `.data/`, `.env.local`, build artifacts excluded from commit

### Estimated Effort
- **Lines of Code**: 2k–3k
- **New Services**: 2–3 classes
- **Tests**: 30+ test cases
- **Duration**: 4 weeks

### Success Criteria
- ✓ Selective commit freezes scope; local env untouched
- ✓ Workstation smoke: health + contracts + swarm status all green
- ✓ Real smoke completes with artifacts + gates + no merge
- ✓ Policy runner selects workers by contract/capacity/risk/approval

---

## Phase 10: Djimitflo Telegram Swarm (Integration Channel)

**Status**: Partially implemented | **Complexity**: MEDIUM | **Impact**: OPERATIONAL

### What It Enables
- Multi-workstation coordination via Telegram bot network
- Distributed memory system (UAMS + Qdrant) for cross-machine knowledge sharing
- Agent heartbeat protocol for health monitoring
- Skills distribution pipeline
- Training data export (JSONL)

### Key Components
| Component | Status |
|-----------|--------|
| Telegram Gateway (6 bots; per-machine config; command routing) | Partial |
| Agent Heartbeat (`/api/agents/:id/heartbeat`; last_seen, machine_ip) | Partial |
| Swarm Memory (UAMS+Qdrant: embed, store, semantic search) | Partial |
| Context Injection (top-3 Qdrant results as context before dispatch) | Partial |
| Skills Distribution (`POST /api/agents/:id/skills`; push via Telegram) | Design |
| Training Data Export (`/api/exports/training` → JSONL) | Design |

### New Database Tables
```sql
agents (add: telegram_bot_id, machine_ip, agent_type, last_seen, heartbeat_status, capabilities_version)
bot_conversations (id, bot_id, chat_id, user_id, status, context_refs, created_at)
skill_sync_events (id, agent_id, skill_id, event_type, error_message, retry_count, created_at)
training_data_feedback (id, task_id, agent_id, feedback_type, confidence, reason, exported_at, created_at)
```

### Critical Implementation Notes
- No shared state; each workstation independent; Telegram is messaging bus only
- Heartbeat protocol; stale detection (> 5 min) marks unreachable
- UAMS/Qdrant contain no secrets; all checksums verified
- Context injection bounded (top-3 only, confidence threshold)
- Skills distribution opt-in (operator approval before push)
- Training export includes audit trail (task_id, agent_id, source, timestamp)

### Estimated Effort
- **Lines of Code**: 6k–8k
- **New Services**: 4–5 classes
- **Tests**: 40+ test cases
- **Duration**: 4–6 weeks

### Success Criteria
- ✓ Heartbeat protocol detects stale agents (> 5 min)
- ✓ Memory sync stores/retrieves without leaking secrets
- ✓ Context injection uses top-3 results with confidence threshold
- ✓ Skills pushed only via operator approval
- ✓ Training export includes full audit trail

---

## Phase 11: G15 Enforced Swarm Intelligence (Governance Layer)

**Status**: Design complete | **Complexity**: VERY HIGH | **Impact**: TRANSFORMATIONAL

### What It Enables
- Central enforcement kernel for all allow/block decisions
- Capability routing (workers selected only through validated capabilities)
- Governance enforcement across loop completion, worker start, memory promotion
- Evidence provenance with resolvable refs (no spoofed governance)
- Runner manifests as append-only audit trail
- Typed claim relationships with explicit contradictions

### Key Components
| Component | Status |
|-----------|--------|
| Enforcement Kernel (central service for allow/block decisions) | Design |
| Capability Routing (worker selection via validated capabilities only) | Design |
| Governance Enforcement (policy verdicts required for loop/worker/memory actions) | Design |
| Evidence Provenance (all refs resolvable; content-addressable) | Design |
| Runner Manifests (auto-written, append-only audit trail) | Design |
| Typed Claims (explicit subject/predicate/object; no inference) | Design |
| OKF Skills Sync (auto-sync → candidates; eval-backed promotion) | Design |
| Mission Control Drill (drill from metric → backing evidence) | Design |

### New Database Tables
```sql
governance_verdicts (id, target_ref, verdict, policy_version, capability_refs, evidence_refs, blocked_reasons, decided_by, expires_at, created_at)
runner_manifests (id, loop_id, lease_id, action, manifest_data, written_at, wrote_by, created_at)
okf_skill_candidates (id, skill_id, okf_source_path, auto_synced_from, status, eval_refs, rebuild_dry_run, created_at)
mission_control_evidence_drill (id, starting_metric, drill_path, evidence_chain, operator_id, drill_timestamp, created_at)
```

### Critical Implementation Notes
- All verdicts required; system cannot proceed without decision
- Capability routing mandatory; worker selection fails if capability missing/invalid
- Evidence refs immutable; changes require new governance decision
- Runner manifests service-owned (not operator-writable)
- Typed claims prevent confusion; contradictions explicit in graph
- OKF sync automatic but gated by eval threshold
- Mission Control read-only operational surface

### Estimated Effort
- **Lines of Code**: 10k–14k
- **New Services**: 6–8 classes
- **Tests**: 80+ test cases
- **Duration**: 8 weeks

### Success Criteria
- ✓ All verdicts include policy/capability/governance/evidence refs
- ✓ Worker selection fails if capability not validated
- ✓ Runner manifests auto-written for all actions (append-only)
- ✓ Mission Control drill shows complete evidence chain
- ✓ OKF sync auto-creates candidates; eval gates promotion

---

## Phase 12: G16 No-Theater Swarm Proof (Proof-Producing Slice)

**Status**: Design complete | **Complexity**: HIGH | **Impact**: OPERATIONAL

### What It Enables
- Contract probing for Codex/OpenCode before execution
- Low-context worker profile validation
- OKF path allowlist enforcement
- Accelerated proof runs auto-generating visible operational state
- Rollback safety (scoped deletion by proof_run_id)
- Mission Control proof cards showing live operational state

### Key Components
| Component | Status |
|-----------|--------|
| Codex/OpenCode CLI Drift Fix (use current flags; test-backed contract) | Design |
| OpenCode MCP Health (status without credential persistence) | Design |
| Runtime Contract Probing (centralized probe table; `/api/loops/runtime-contracts`) | Design |
| OKF Path Allowlist (restrict writes to `.djimitflo/okf/` only) | Design |
| Scoped Permissions (proof-run service uses proof_run_id for all records) | Design |
| Unspoofable Refs (governance refs include version/timestamp; content hash) | Design |
| Live Proof Runner (auto-create: 1 capability, 1 panel, 3 reviews, 3 claims, 1 goal, 1 loop, 2 leases) | Design |
| Rollback Safety (`DELETE FROM ... WHERE proof_run_id = ?`) | Design |

### New Database Tables
```sql
proof_runs (id, created_by, status, config, error_message, created_at, completed_at)
proof_run_artifacts (id, proof_run_id, artifact_type, artifact_id, created_at)
```

### Critical Implementation Notes
- Proof time-boxed (max 5 min); kills stuck workers
- Mock workers only for proof (real Codex/OpenCode execution separate)
- Rollback surgical (proof_run_id scoped; production/audit untouched)
- Evidence real (proof auto-generates legit database records)
- No credential persistence (MCP health checks return status only)
- Codex contract tested via real local binary if available
- Mission Control cards show actual row counts (no optimistic UI)

### Estimated Effort
- **Lines of Code**: 3k–5k
- **New Services**: 2–3 classes
- **Tests**: 50+ test cases (including contract drift scenarios)
- **Duration**: 4 weeks

### Success Criteria
- ✓ Proof auto-generates nonzero capabilities/goals/leases/manifests
- ✓ Rollback deletes only proof_run_id-scoped records
- ✓ Codex/OpenCode contract probed before proof; status in dashboard
- ✓ OKF path allowlist enforced; escapes rejected in tests
- ✓ Mission Control proof cards show live counts, runtime evidence

---

## Phase 13: Nested Swarm Control Loop L1–L4 (Self-Spawning Agents)

**Status**: Mostly implemented (L1–L3 working; L4 MVP deferred) | **Complexity**: MEDIUM | **Impact**: OPERATIONAL

### What It Enables
- Spawned runtime children use HTTP `/api/swarms/spawns` to spawn sub-agents
- Per-depth token/wall-clock budget ceiling within tree-wide hard bound
- Token-or-user auth (L3): spawn tokens allow POST /spawns but not /spawns/root
- L4 MVP skill injection: validated capabilities serialized as read-only JSON env metadata
- Extended loop runtimes (claude, gemini, editor/cline)
- Flaky `createWorktree` hardened with bounded retry

### Key Components
| Component | Status |
|-----------|--------|
| HTTP Control Loop (child reads DJIMITFLO_CONTROL_URL, DJIMITFLO_SPAWN_TOKEN, lease identity) | Implemented |
| Per-Depth Budget (token/wall ceiling per depth within tree-wide bounds) | Implemented |
| Token-or-User Auth (requireAuthOrSpawnToken: JWT OR scoped spawn token) | Implemented |
| L4 Skill Injection (capabilities serialized to JSON env; read-only metadata) | Implemented |
| New Runtimes (claude, gemini, editor support; contract probes, pools) | Implemented |
| Worktree Flake Hardening (retry on git lock; exponential backoff) | Implemented |

### New Database Tables
```sql
sub_agent_spawns (id, parent_lease_id, child_lease_id, depth, spawn_token_hash, tree_root_id, tree_path, child_budget_token, child_budget_used_token, child_budget_wall_ms, child_budget_used_wall_ms, http_response_code, spawn_status, created_at)
worktree_lock_retries (id, worktree_id, retry_attempt, error_message, retry_at, created_at)
```

### Critical Implementation Notes
- Spawn failure non-fatal (child timeout/error doesn't block parent)
- Spawn token scoped (tree_id, depth, lease_id; no reuse/escalation)
- Budget transparency (child knows per-depth limit in env)
- Worktree contention managed by bounded retry + exponential backoff
- Capability manifest metadata-only (grants no new authority)
- New runtimes follow same spawn boundary/auth/budget/capability checks

### Estimated Effort
- **Lines of Code**: 2k–4k
- **New Services**: 2–3 classes
- **Tests**: 40+ test cases
- **Duration**: 4 weeks

### Success Criteria
- ✓ Mock root spawns child over HTTP; child spawns grandchild; depth < 3 succeeds, depth >= 3 blocked
- ✓ Spawn token limits child to POST /spawns but not /spawns/root
- ✓ Per-depth budget enforced within tree-wide bound
- ✓ Capability manifest injected as read-only env
- ✓ claude/gemini/editor runtimes build correct headless commands

---

## Dependency Map & Critical Path

```
Phase 5 (Complete) ✅
├─ Auth & Ownership (foundation)
├─ Docker Deployment
├─ Backup & Restore
└─ Export & Reporting
    │
    ├──→ Phase 6 (Goal/Loop/Fleet) 2–3 mo
    │   └──→ Phase 8 (Fleet & Scale) 1–2 mo [parallel with Phase 7]
    │       └──→ Phase 9 (Commit & Smoke) 1 mo [depends on Phases 6–8–11]
    │
    ├──→ Phase 7 (Swarm Intelligence) 2–3 mo [after Phase 6]
    │   └──→ Phase 11 (Enforcement Kernel) 2 mo
    │       └──→ Phase 12 (Proof Runner) 1 mo
    │
    └──→ Phase 10 (Telegram Swarm) 1 mo [optional, depends on Phase 6]
    └──→ Phase 13 (Nested Spawns) 1 mo [optional, depends on Phase 6]
```

### Critical Path (Must-Do)
1. Phase 6: Goal/Loop/Fleet foundation
2. Phase 8: Fleet observability
3. Phase 7: Swarm intelligence
4. Phase 11: Enforcement kernel
5. Phase 12: Proof validation

**Parallel track possible after Phase 6**: Phase 9, Phase 10, Phase 13 can be designed/tested while Phase 7 is in progress.

---

## Complexity & Effort Summary

| Phase | LOC Est. | Tables | Services | Tests | Risk | Duration |
|-------|----------|--------|----------|-------|------|----------|
| **6** | 8–12k | 5 | 8–10 | 80+ | HIGH | 8–12 wk |
| **7** | 12–16k | 6 | 10–12 | 100+ | VERY HIGH | 8–12 wk |
| **8** | 4–6k | 2 | 3–4 | 40+ | MEDIUM | 4–6 wk |
| **9** | 2–3k | 0 | 2–3 | 30+ | LOW | 4 wk |
| **10** | 6–8k | 3 | 4–5 | 40+ | MEDIUM | 4–6 wk |
| **11** | 10–14k | 3 | 6–8 | 80+ | VERY HIGH | 8 wk |
| **12** | 3–5k | 1 | 2–3 | 50+ | MEDIUM | 4 wk |
| **13** | 2–4k | 2 | 2–3 | 40+ | MEDIUM | 4 wk |
| **TOTAL** | 47–68k | 22 | 36–48 | 460+ | — | 7–9 mo |

---

## Team Organization

### Foundation Squad (Phases 6–8, 2–3 months)
- 2–3 engineers: Loop/fleet orchestration, worktree management, runtime contracts
- 1 QA engineer: Smoke testing, contract validation
- 1 DevOps engineer: Workstation setup, Docker hardening

### Intelligence Squad (Phases 7–11, 3 months)
- 2–3 engineers: Capability registry, specialist panels, enforcement kernel
- 1 graph specialist: Evidence graph, claim ledger, contradiction detection
- 1 DevOps: OKF path validation, runtime probing

### Integration Squad (Phases 9–10–13, 2–3 months)
- 1–2 engineers: Smoke tests, Telegram gateway, nested spawns
- 1 QA: End-to-end validation

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Phase 6 fleet concurrency flakes | Spin up 5 parallel makers; verify no git conflicts |
| Phase 7 claim contradiction logic errors | Test explicit graph; verify no false negatives |
| Phase 11 enforcement kernel becomes bottleneck | Stateless service design; cache hot paths if needed |
| Phase 8 runtime contract drifts | Re-probe before each smoke; cached only 1 hour |
| Nested spawn runaway depth | `depth < depth_budget` enforced; non-cooperative killed at ceiling |

**Fallback Plans**:
- Fleet concurrency fails → Sequential maker (slower, safer)
- Evidence graph too complex → Flat claim table (lose reasoning, keep execution)
- Enforcement too slow → Async audit, execution unblocked
- Telegram unreliable → Keep Djimitflo instances independent

---

## Testing Strategy

**Unit Tests (70%+)**: Loop state machine, budget model, routing logic, contradiction detection, enforcement decisions
**Integration Tests (60%+)**: End-to-end goal → loop → worker; multi-worker concurrency; proof create → rollback
**Smoke Tests (Full)**: Workstation health, real Codex/OpenCode with temp DB, Telegram heartbeat, nested spawn tree
**Load Tests (60%+)**: 10–20 concurrent loops, enforcement kernel latency, queue fairness under mixed workload

---

## Monitoring & Observability

**Key Metrics**:
- Loop run duration, success rate, gate failure reasons
- Worker token usage per runtime, tokens per successful diff
- Fleet pool queue depth, prepared/running/completed ratios
- Enforcement kernel decision latency, allow/block/advisory ratios
- Nested spawn success rate, HTTP timeout count

**Dashboards**:
- Mission Control: Live swarm state, queue, capacity, blocked reasons
- Fleet Cockpit: Pool topology, token burn, warnings, gate health
- Proof Dashboard: Proof run status, rollback capability, contract alerts

---

## Critical Implementation Files

**Phase 6 Foundation**:
- `/packages/server/src/services/loop-service.ts` — Loop state machine
- `/packages/server/src/services/fleet-planner-service.ts` — Worker assignment
- `/packages/server/src/database/migrate.ts` — Goal/loop/lease schema

**Phase 7 Intelligence**:
- `/packages/server/src/services/capability-registry-service.ts` — Capability routing
- `/packages/server/src/services/claim-ledger-service.ts` — Claim ledger
- `/packages/server/src/services/evidence-graph-service.ts` — Evidence graph

**Phase 11 Enforcement**:
- `/packages/server/src/services/enforcement-kernel-service.ts` — Decision kernel
- `/packages/server/src/services/governance-verdict-service.ts` — Verdict storage

**Phase 12 Proof**:
- `/packages/server/src/services/proof-run-service.ts` — Proof orchestration
- `/packages/server/src/services/runtime-contract-probe-service.ts` — Contract probing

**Dashboard**:
- `/packages/dashboard/src/pages/GoalsLoopsPage.tsx` — Orchestration UI
- `/packages/dashboard/src/pages/MissionControlPage.tsx` — Mission Control

---

## Success Criteria by Phase

### Phase 6 ✓
- Goal without acceptance criteria rejected
- 5 concurrent makers, no git conflicts
- Checker verdict enforced; maker cannot bypass
- Dashboard shows full loop lifecycle
- `doc-drift-and-small-fix-loop` completes without merge

### Phase 7 ✓
- Draft/candidate capabilities block live routing
- Panel records support/oppose/uncertainty
- Claim contradictions explicit; no false negatives
- Capacity Governor explains decisions
- Hypothesis workbench creates backlog without workers

### Phase 8 ✓
- Drifted contract blocks execution
- Fleet pool shows prepared/running/completed
- Token usage parsed from runtime
- Fleet Cockpit renders live data
- Goals batch dry-run shows ordered goals

### Phase 9 ✓
- Selective commit freezes scope; local env clean
- Workstation smoke all green
- Real smoke completes with gates, no merge
- Policy runner enforces contract/capacity/risk

### Phase 10 ✓
- Heartbeat detects stale agents (> 5 min)
- Memory sync stores without leaking secrets
- Context injection uses top-3 with threshold
- Skills distribution opt-in only
- Training export includes audit trail

### Phase 11 ✓
- Verdicts include policy/capability/evidence refs
- Worker selection fails if capability invalid
- Manifests auto-written (append-only)
- Mission Control drill shows evidence chain
- OKF sync auto-creates candidates

### Phase 12 ✓
- Proof auto-generates real operational state
- Rollback scoped by proof_run_id
- Contract probed before proof
- OKF path allowlist enforced
- Proof cards show live counts

### Phase 13 ✓
- Mock root → child → grandchild; depth-3 blocked
- Spawn token scoped (no escalation)
- Per-depth budget enforced
- Capability manifest read-only
- claude/gemini/editor runtimes build correctly

---

## Conclusion

Djimitflo v0.5.8 → v1.0+ transformation via 8 OpenSpec phases represents a systematic progression from **single-loop execution** (Phase 6) to **swarm intelligence with governance** (Phase 11) to **distributed orchestration** (Phases 10–13).

**Total Investment**: 7–9 months, 4–6 engineers, 47k–68k lines of code, 460+ test cases.

**Outcome**: Production-ready, auditable, multi-agent orchestration platform respecting governance while enabling autonomous throughput through verified control loops.

---

*Analysis Date: June 2026*
*Analyst: Claude AI Code Planning Agent*
