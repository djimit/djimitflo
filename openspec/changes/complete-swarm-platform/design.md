# Design

## Decision

Consolidate 256 unchecked tasks across 7 OpenSpec changes into one executable
program with 6 phases and 24 ordered goals. Each goal maps to specific tasks
in the source changes, so progress is traceable from the goals.batch.json
through to individual checkboxes.

The design follows the existing G15 Option B (Distributed Capability Mesh)
pattern: each subsystem enforces its own contracts, with a shared enforcement
layer for cross-cutting governance decisions.

## Phase Map

```
Phase 1 (G14 closure)           — checkbox only, no code
    ↓
Phase 2 (G15 enforcement)        — security, governance, claims, manifests, capacity
    ↓
Phase 3 (G16 proof)              — runtime repair, proof run, live smoke
    ↓
Phase 4 (Pi executor + runtime)  — Pi JSON mapping, loop runtime integration
    ↓
Phase 5 (Loop fleet closure)     — docs, contracts, resume, skill validation
    ↓
Phase 6 (Workstation deploy)     — commit, deploy, verify, smoke
```

## Phase 1 — G14 Closure

No code changes. The 40 `next-level-swarm-skills-specialists` tasks are
already implemented via `converge-foundation-and-swarm-intelligence`:
- swarm_missions/tasks/decisions tables (G14.1)
- capability registry with contracts (G14.2)
- specialist panels with dissent (G14.3)
- evidence graph + claim ledger (G14.4)
- capacity governor v2 with queue classes (G14.5)
- evaluation harness (G14.6)
- Mission Control dashboard (G14.7)
- end-to-end smoke (G14.8-G14.9)

Action: check off all 40 tasks with evidence references to test names.

## Phase 2 — G15 Enforcement

### G15.1 Security Boundary
- OKF path allowlist: `KnowledgeRuntimeService` resolves canonical path,
  rejects paths outside allowlisted roots.
- Scoped permissions: replace `create:task` with `write:capability`,
  `write:claim`, `write:governance`, `write:runner_manifest`.
- Secret-like detector: shared `rejectSecretLike()` already exists in
  `SwarmIntelligenceService`; extend to all mutating endpoints.

### G15.2 Capability Promotion
- Split `registerCapability` into `createCandidate` (draft) and
  `promoteCapability` (validated with evidence refs).
- Require security checker + human approval for high/critical promotion.

### G15.3 Governance Enforcement
- Add `EnforcementDecisionService` that resolves refs (not booleans).
- Wire into `verifyLoopRun`, `completeLoopRun`, `startNextWorker`,
  `drainWorkerPool`, `stop/kill`, memory promotion.
- `enforceCapabilityGate` and `enforceGovernanceCompletion` already exist
  from the G15 enforcement commit — extend to all action types.

### G15.4 Claim Ledger V2
- Typed fields already exist (`subject_ref`, `predicate`, `object`, `scope`).
- Add explicit `supports`/`refines`/`contradicts` edge types.
- Require evidence refs to resolve before status promotion.

### G15.5 Evidence Graph Resolver
- `createEvidenceEdge` exists; add lineage resolver APIs (forward/reverse).
- Add dashboard card summaries from graph traversal.

### G15.6 Runner Manifest Auto-Write
- `autoWriteManifest` exists for start + complete; extend to skip, stop,
  kill, timeout, drain.
- Attach stdout/stderr/artifact refs and token usage.

### G15.7 Capacity Governor Live Scheduler
- `planCapacityV2` exists with queue classes; add concurrency slots,
  budget enforcement, process-aware stop/kill.
- Circuit breaker exists; wire into `startNextWorker`.

### G15.8 OKF Skill Sync + Hypothesis Workbench
- `KnowledgeRuntimeService` syncs OKF to capabilities; add hypothesis
  entities with evidence plan, falsification signal, stop condition.

### G15.9 Mission Control Drill-Through
- Dashboard has metrics; add drill-through links to evidence records.

## Phase 3 — G16 No-Theater Proof

### G16.1 Runtime Contract Repair
- Fix CodexExecutor flags (`exec --json --cd`).
- Extract shared probe used by loop-service and execution-engine.
- Add contract fixtures for available/drifted/unavailable states.

### G16.2 Enforcement Repair
- Overlaps with G15.1-G15.4; complete the security boundary work.
- Add tests for OKF path escape, spoofed governance, spoofed manifest.

### G16.3-G16.4 OpenCode + OpenAI Descriptors
- OpenCode config inspector for `opencode.jsonc`.
- OpenAI Agents/Skills/MCP capability descriptors as privileged candidates.

### G16.5-G16.6 Proof Run Service + API
- `ProofRunService` creates rollback-scoped demo records:
  capabilities, panels, claims, backlog, goal, loop, leases, traces,
  checkpoints, manifests, memory candidates.
- API: `POST /api/swarms/proof-runs`, `GET /:id`, `POST /:id/rollback`.
- CLI: `npm run swarm:proof`, `npm run swarm:proof:rollback`.

### G16.7-G16.8 Mission Control + Live Smoke
- Dashboard proof section with live counts vs required minimums.
- Live workstation smoke: zero-state → proof → nonzero → rollback.

## Phase 4 — Pi Executor + Loop Runtime

### Pi Executor (17 tasks)
- JSON event mapping: `session` → LOG, `agent_start` → TASK_STARTED,
  `tool_execution_*` → TOOL_CALL/TOOL_RESULT, `agent_end` → TASK_COMPLETED.
- Cancel: SIGTERM then SIGKILL.
- E2E sovereign run: djimitflo → PiExecutor → Ollama, zero egress.

### Pi Loop Runtime (32 tasks)
- Add `'pi'` to runtime union sites in `loop-service.ts`.
- `getRuntimeContract('pi')`: probe binary, cache TTL.
- `buildRuntimeCommand('pi', ...)`: `--mode json -p --no-session ...`.
- Parse `message.usage` into worker lease runtime usage.

## Phase 5 — Agentic Loop Fleet Closure (9 tasks)

- Document Ruflo as inspiration only.
- Capture live Codex/OpenCode contracts from binaries.
- Verify loop resume from persisted state after restart.
- Validate skills before active loop use.

## Phase 6 — Workstation Deployment (43 tasks)

- Commit scoped worktree.
- Deploy/restart server on workstation.
- Verify: health, runtime contracts, swarm status, dashboard.
- Run scheduler tick in safe mode.
- Capture all verification evidence.

## Dependency Order

```
P1-G14-closure → P2-G15-enforcement → P3-G16-proof
                                      → P4-Pi-executor → P5-loop-fleet → P6-deploy
```

P4 can run in parallel with P3 after P2 completes (Pi doesn't depend on proof).
P5 depends on P4 (Pi runtime must be in the loop fleet).
P6 depends on P3 + P5 (proof + Pi must be ready before deployment).
