# Design

## Current Problem

G14 created valuable swarm intelligence primitives, but the audit found the same pattern across them: important facts exist as records or previews, while the runtime path can still proceed without them.

The real problem is enforcement. A system that can display capability contracts, governance verdicts, claims, capacity plans and manifests is useful for observability. It becomes 10x more valuable when those same records are the only way a worker can be routed, started, completed, promoted to memory or shown as active execution.

## Design Options

### Option A: Central Enforcement Kernel

One service owns all permission, governance, capability, evidence and capacity gate checks before any mutating swarm action.

Strengths:

- One place to prove why a worker action was allowed or blocked.
- Strongest defense against spoofed API inputs.
- Clear integration points for runner, loop service, memory promotion and dashboard actions.

Weaknesses:

- Can become a large service if it also owns graph traversal and UI shaping.
- Requires careful boundaries so it validates facts instead of re-implementing every subsystem.

### Option B: Distributed Capability Mesh

Each subsystem enforces its own contracts: capability service enforces capabilities, claim service enforces claim refs, runner enforces manifests, loop service enforces completion gates.

Strengths:

- Local code remains close to the data it owns.
- Easier incremental adoption.
- Lower risk of a single large coordinator.

Weaknesses:

- Easy to miss one runtime path.
- Harder to produce a single audit explanation.
- Dashboard actions may drift from runner behavior.

### Option C: Mission Workflow Engine

All work becomes a mission state machine. Every panel, claim, goal, lease, runner action, manifest and memory candidate is a transition in one workflow.

Strengths:

- Best operator model for Mission Control.
- Natural end-to-end lineage.
- Strong fit for replay and scenario smoke tests.

Weaknesses:

- Too large as a first enforcement step.
- Risks forcing existing loop/worker models into a new abstraction before there is enough pressure.

## Recommendation

Use a hybrid:

- **Enforcement Kernel** for hard allow/block decisions.
- **Evidence Mesh** for typed, resolvable records owned by existing services.
- **Mission Workflow Surface** for dashboard drill-through and end-to-end scenarios.

The enforcement kernel should not own all data. It should resolve references, call existing services, evaluate policies and return a decision envelope:

```json
{
  "decision": "allow",
  "action": "worker.start_next",
  "risk_class": "medium",
  "policy_version": "swarm-governance-v1",
  "capability_refs": ["capability:codex-worker:1"],
  "evidence_refs": ["trace:...", "checkpoint:..."],
  "blocked_reasons": [],
  "required_human_approval": false
}
```

Every runner, loop, memory and dashboard mutating action consumes this envelope and writes trace/manifest evidence from it.

## Core Contracts

### Enforcement Decision

An enforcement decision includes:

- `action`
- `actor`
- `risk_class`
- `target_ref`
- `policy_version`
- `capability_refs`
- `governance_refs`
- `evidence_refs`
- `budget_snapshot_ref`
- `capacity_snapshot_ref`
- `decision`: `allow`, `block`, `advisory`, `human_required`
- `blocked_reasons`
- `expires_at`

The caller cannot supply pass/fail booleans for maker, checker, security checker, quorum or human approval. It supplies refs. The enforcement layer resolves those refs against persisted records.

### Capability Lifecycle

Capabilities move through:

1. `draft`
2. `candidate`
3. `validated`
4. `deprecated`
5. `disabled`

Creation may produce `draft` or `candidate`. Promotion to `validated` requires eval scorecard refs, evidence refs, owner, version, risk ceiling, allowed actions, forbidden actions, thresholds and removal strategy.

Any eval below threshold is a hard failure. The capability router must never average that away.

### Claim Ledger V2

Claims become typed:

- `subject_ref`
- `predicate`
- `object`
- `scope`
- `confidence`
- `valid_from`
- `valid_until`
- `status`
- `evidence_refs`
- `supports_refs`
- `refines_refs`
- `contradicts_refs`
- `source_ref`
- `sensitivity`

Contradiction is explicit. Two supported claims on the same subject are not contradictory unless predicate/object/scope rules or explicit `contradicts_refs` say they are.

### Evidence Provenance

Evidence refs must resolve to allowed record kinds:

- specialist panel
- specialist review
- claim
- backlog item
- goal
- loop run
- worker lease
- trace span
- checkpoint
- runner manifest
- eval scorecard
- human approval
- policy decision
- memory candidate

Each evidence record carries source, created time, actor, sensitivity, retention or deletion policy and whether it may influence routing, memory or backlog priority.

### Runner Manifest

Runner manifests are append-only records written by runner code for:

- plan
- start
- skip
- stop
- kill
- timeout
- failure
- completion
- drain summary

The public API may read manifests and request runner actions, but cannot directly assert a completed manifest. Manifest writes require a real loop, lease, action, actor, capacity snapshot, budget snapshot and enforcement decision.

### Capacity Scheduler

The scheduler consumes prepared leases and emits a runner plan:

- queue class
- queue age
- fair-share weight
- runtime
- capability eligibility
- concurrency slots
- token budget state
- wall-clock budget state
- failure budget state
- policy/gate status
- selected or blocked reason

Starting a worker requires both scheduler eligibility and enforcement allow.

### Mission Control

Mission Control is not a source of truth. It is a drill-through surface over evidence:

- It shows active execution only from runtime evidence.
- It disables actions when enforcement says block or human required.
- It links every visible claim to its supporting records.
- It can request gated actions, but it cannot bypass runner/governance checks.

## Implementation Slices

### G15.1 Security Boundary And Provenance Baseline

Close the audit findings that can contaminate later enforcement: OKF path allowlist, scoped permissions, shared secret-like detector, runtime node config and evidence ref validation.

### G15.2 Capability Promotion And Router Enforcement

Split candidate writes from validated promotion, hard-fail eval threshold misses and require the worker router to select through validated capability contracts.

### G15.3 Governance Enforcement Layer

Make governance verdicts unspoofable and integrate them into loop verify, loop complete, start-next, drain, stop/kill and memory promotion.

### G15.4 Claim Ledger V2 And Evidence Provenance

Implement typed claims, explicit supports/refines/contradicts edges and resolvable evidence refs with sensitivity and retention metadata.

### G15.5 Evidence Graph Lineage Resolver

Add graph traversal from panel to backlog to goal to loop to lease to trace to checkpoint to manifest to memory candidate, with API and tests.

### G15.6 Runner Manifest Auto-Write

Move manifests from manual assertion to runner-owned append-only evidence for every meaningful runner action.

### G15.7 Capacity Governor Live Scheduler

Turn planning into enforced scheduling with queue fairness, runtime concurrency, budgets, kill handling and fleet circuit breakers.

### G15.8 OKF Skill Sync And Hypothesis Workbench

Index configured OKF skill roots into capability candidates, add rebuild dry-run/apply flow, persist specialist profile versions and add hypothesis/falsification/stop-condition records.

### G15.9 Mission Control Drill-Through And Actions

Add dashboard drill-through and gated actions for capability promotion, claim resolution, panel projection, goal creation, start-next, drain, stop/kill and manifest review.

### G15.10 End-To-End Scenario And Runtime Smoke

Prove the full chain with mock runtime first, then run bounded Codex/OpenCode smokes with real stdout/stderr/artifacts, parsed runtime usage, trace spans, checkpoints and dashboard evidence.

## Validation Strategy

- OpenSpec strict validation.
- Node syntax validation and dry-run for goal batch.
- Unit tests for path allowlist, secret-like rejection, capability threshold hard fail, evidence ref resolution and claim contradiction.
- Service tests for governance enforcement in verify, complete, start-next, drain and memory promotion.
- Runner tests with mock runtime for manifest auto-write, budget stop, timeout kill and circuit breaker.
- API tests for scoped permissions and inability to spoof governance, claim support or runner manifests.
- Dashboard tests for active-execution truth, disabled blocked actions and drill-through links.
- End-to-end mock scenario before any real runtime smoke.
- Bounded real Codex/OpenCode smoke after mock proof is green.
