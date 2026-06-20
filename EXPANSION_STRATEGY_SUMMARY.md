# Djimitflo Expansion Strategy: Executive Summary

**Current Status**: v0.5.8, Phase 5 Complete ✅
**Available Expansions**: 8 OpenSpec proposals  
**Recommended Timeline**: 7–9 months, 4–6 engineers  
**Total Effort**: 47k–68k LOC, 460+ tests

---

## The 8 Expansions at a Glance

| Phase | Name | Focus | Complexity | Status | Duration |
|-------|------|-------|-----------|--------|----------|
| **6** | Agentic Control Loop Fleet | Goal/loop/lease execution model | HIGH | Mostly implemented | 8–12 wk |
| **7** | Swarm Skills & Specialists | Capability registry, specialist reasoning | VERY HIGH | Design complete | 8–12 wk |
| **8** | Real Worker Fleet & Scale | Runtime contracts, fleet observability | HIGH | Mostly implemented | 4–6 wk |
| **9** | Commit, Smoke & Policy Runner | Selective commit, smoke tests, policy gates | MEDIUM | Design complete | 4 wk |
| **10** | Telegram Swarm | Multi-workstation via Telegram bot | MEDIUM | Partially implemented | 4–6 wk |
| **11** | Enforced Swarm Intelligence | Central enforcement kernel, governance | VERY HIGH | Design complete | 8 wk |
| **12** | No-Theater Swarm Proof | Contract probing, proof runner, rollback | HIGH | Design complete | 4 wk |
| **13** | Nested Control Loop L1–L4 | Self-spawning agents, recursive hierarchy | MEDIUM | Mostly implemented | 4 wk |

---

## Recommended Execution Path

### Critical Path (Must-Do, 5 phases)
```
Phase 6 (Goal/Loop/Fleet) → Phase 8 (Fleet Scale) 
                          → Phase 7 (Swarm Intel)
                          → Phase 11 (Enforcement)
                          → Phase 12 (Proof)
```
**Timeline**: ~5 months, 2–4 engineers  
**Outcome**: Foundational, provably-governed multi-agent orchestration

### Optional Enhancements (After critical path)
- **Phase 9**: Commit & Smoke (1 mo) — Smoke testing validation
- **Phase 10**: Telegram Swarm (1 mo) — Multi-workstation coordination
- **Phase 13**: Nested Spawns (1 mo) — Self-spawning agent hierarchies

---

## Key Architectural Decisions

### 1. Foundation First: Goal/Loop/Lease Model (Phase 6)
**Why**: All downstream phases depend on this. Enables parallel workers, measurable goals, closed-loop verification.
- New API: `/api/goals`, `/api/loops`, `/api/leases`
- New dashboard: Goals/Loops page showing full lifecycle
- First real loop: `doc-drift-and-small-fix-loop` (low-risk, high-value)
- **Validation**: 5 concurrent makers in separate worktrees, no git conflicts

### 2. Intelligence Kernel Before Governance (Phase 7 before 11)
**Why**: Phase 7 (capability registry, specialist panels) must exist before Phase 11 (enforcement kernel) routes workers through them.
- Capability validation gates worker selection
- Specialist panels produce evidence for decisions
- Claim ledger becomes operational truth source

### 3. Proof Before Production Scale (Phase 12 after 11)
**Why**: Phase 12 proves Phase 11 enforcement actually works end-to-end.
- Proof runner auto-generates operational state in isolated proof_run_id scope
- Rollback safety verified (no production data corruption)
- Contract probing detects runtime drift before execution

### 4. Fleet Observability Parallel with Intelligence (Phase 8 with Phase 7)
**Why**: Fleet Cockpit (Phase 8) provides visibility needed while intelligence kernel (Phase 7) is being built.
- No blocking dependency; Phase 8 mostly implemented already
- Can run in parallel; both feed Phase 9 smoke testing

---

## Critical Success Criteria

### Phase 6 (Loop/Fleet)
- ✅ Loop without acceptance criteria rejected by API
- ✅ 5 concurrent makers in separate worktrees complete without git conflicts
- ✅ Checker verdict enforced; maker output cannot bypass gates
- ✅ Dashboard shows full loop lifecycle (created → verifying → completed)
- ✅ `doc-drift-and-small-fix-loop` completes without auto-merge

### Phase 7 (Swarm Intelligence)
- ✅ Draft/candidate capabilities block live worker routing
- ✅ Specialist panel output records support/oppose/uncertainty with dissent preserved
- ✅ Claim contradictions explicit in graph edges; no false negatives
- ✅ Capacity Governor explains why work is blocked/queued/eligible/running

### Phase 11 (Enforcement)
- ✅ All governance verdicts include policy/capability/governance refs
- ✅ Worker selection fails if capability not validated or missing
- ✅ Runner manifests auto-written for all actions (append-only audit trail)
- ✅ Mission Control drill shows complete evidence chain from metric to proof

### Phase 12 (Proof)
- ✅ Proof runner auto-generates nonzero capabilities/goals/leases/manifests
- ✅ Rollback deletes only proof_run_id-scoped records; production data untouched
- ✅ Codex/OpenCode contract probed before execution; drifted status blocks start
- ✅ OKF path allowlist enforced; path escapes rejected in tests

---

## Team Sizing Recommendation

**Foundation Squad** (Phases 6–8, 2–3 months)
- 2–3 backend engineers (loop/fleet/runtime)
- 1 QA engineer (smoke & contract testing)
- 1 DevOps (workstation setup, Docker)

**Intelligence Squad** (Phases 7–11, 3 months)
- 2–3 backend engineers (capability/specialist/enforcement)
- 1 graph specialist (evidence graph & contradictions)
- 1 DevOps (OKF validation, probe services)

**Integration Squad** (Phases 9–10–13, 2–3 months, can overlap)
- 1–2 backend engineers (smoke/Telegram/nested spawns)
- 1 QA (end-to-end validation)

**Total**: 4–6 FTE engineers, 7–9 months, 47k–68k LOC

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| **Phase 6**: Fleet concurrency flakes under git lock | Pre-test with 5 parallel makers in temp repos |
| **Phase 7**: Evidence graph becomes circular | Cycle detection in validation; manifests catch before execution |
| **Phase 11**: Enforcement kernel becomes bottleneck | Stateless service; cache hot paths; async audit fallback |
| **Phase 8**: Runtime CLI contract drifts | Re-probe before each smoke; 1-hour cache; contract mismatch blocks execution |
| **Phase 13**: Nested spawn runaway | Depth budget enforced; non-cooperative workers killed at ceiling |

**Fallback Plans**:
- Fleet concurrency fails → Sequential maker execution (slower, safe)
- Evidence graph too complex → Flat claim table (lose reasoning, keep execution)
- Enforcement kernel overloaded → Async audit, execution unblocked
- Telegram swarm unreliable → Keep instances independent (defer feature)

---

## Effort Breakdown

| Phase | LOC | Services | Tests | Weeks |
|-------|-----|----------|-------|-------|
| **6** Foundation | 8–12k | 8–10 | 80+ | 8–12 |
| **8** Fleet Scale | 4–6k | 3–4 | 40+ | 4–6 |
| **7** Intelligence | 12–16k | 10–12 | 100+ | 8–12 |
| **11** Enforcement | 10–14k | 6–8 | 80+ | 8 |
| **12** Proof | 3–5k | 2–3 | 50+ | 4 |
| **Critical Total** | **37–53k** | **29–37** | **350+** | **32–46 wk** |
| (optional 9/10/13) | +10–15k | +8–11 | +110+ | +12–16 wk |

---

## Next Steps (Week 1)

1. **Review full roadmap**: `/home/user/djimitflo/PHASE6_EXPANSION_ROADMAP.md`
2. **Pick go/no-go**: Confirm Phases 6–7–11–12 as critical path
3. **Allocate team**: Foundation Squad on Phase 6; Intelligence Squad on Phase 7 design
4. **Capture contracts**: 
   - Document current Codex CLI contract (Phase 8 needs this)
   - Test OpenCode CLI flags (Phase 8 validation)
5. **Design reviews**: 
   - Phase 6 loop contract schema
   - Phase 7 capability registry and evidence graph
   - Phase 11 enforcement kernel architecture
6. **Start Phase 6 L1**: Loop state machine and goal lifecycle API

---

## Success = Governance + Autonomy

The 8 OpenSpec phases together create a **governed autonomous orchestration platform**:
- **Execution** (Phase 6): Workers can run in parallel with measurable outcomes
- **Intelligence** (Phase 7): Specialized reasoning from multiple angles  
- **Enforcement** (Phase 11): All decisions provably routed through policy
- **Proof** (Phase 12): Evidence is real, rollback is safe, contract drift is detected
- **Scale** (Phases 10–13): Multi-workstation, self-spawning, distributed memory

**Outcome**: Djimitflo v1.0 as a production-ready, auditable, multi-agent swarm orchestrator respecting governance constraints while enabling real autonomous throughput.

---

*For detailed phase-by-phase breakdown, architecture, dependencies, and implementation guides, see:*  
**`/home/user/djimitflo/PHASE6_EXPANSION_ROADMAP.md`**
