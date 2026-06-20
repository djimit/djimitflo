# Phase 7: Next-Level Swarm Skills & Specialists — Implementation Plan

**Status**: Design Phase | **Complexity**: VERY HIGH | **Impact**: TRANSFORMATIONAL  
**Estimated Duration**: 8–12 weeks | **Team Size**: 3–4 engineers | **Start Date**: Post-Phase 6 Release

---

## Executive Summary

Phase 7 transforms Djimitflo from a loop orchestration platform into a **multi-disciplinary swarm intelligence kernel** with specialist reasoning, evidence-based decision making, and capability-driven routing.

### Strategic Vision

Currently (Phase 6), the swarm is **task-driven**: goals → loops → workers execute → completion. Phase 7 introduces **intelligence-driven execution** where:

- **Specialist Councils** analyze multi-disciplinary questions (math, physics, security, product)
- **Capability Registry** gates worker routing (only validated capabilities execute live)
- **Evidence Graph** tracks operational truth vs. claims (no auto-inference; explicit contradictions)
- **Hypothesis Workbench** validates questions before spawning workers (bounded exploration)
- **Capacity Governor V2** implements fair-share scheduling (research ≠ starvation of fixes)

### Critical Dependencies

**Phase 7 depends on**:
- Phase 6: Loop service, worker leases, gates, dashboard ✅ (95% complete)
- Phase 8: Fleet scale, runtime contracts (can proceed in parallel)

**Phase 7 enables**:
- Phase 9: Commit & smoke testing
- Phase 11: Governance enforcement kernel
- Phase 12: Proof runner (accelerated validation)

---

## Architecture Overview

```
Phase 7 Intelligence Kernel Architecture
═══════════════════════════════════════════════════════════════

User Query / Goal
    ↓
┌─────────────────────────────────────┐
│  Hypothesis Workbench               │
│  Question → Evidence Plan → Panel   │
│  (bounded exploration budget)       │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  Specialist Panel Consensus         │
│  [Mathematician, Physicist,         │
│   Security, Product, Architect]     │
│  → Consensus + Dissent Record       │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  Capability Registry                │
│  Draft → Candidate → Validated      │
│  (typed contracts, eval scoring)    │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  Capacity Governor V2               │
│  Queue Classes + Fair-Share         │
│  [research, doc_fix, test_repair,   │
│   security, memory, policy]         │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  Evidence Graph & Claim Ledger      │
│  (Supports / Contradicts / Refines) │
│  → Immutable audit trail            │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  Worker Execution (Phase 6)         │
│  (constrained by capability/queue)  │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  Mission Control Dashboard          │
│  (registry, planned work, blocked)  │
└─────────────────────────────────────┘
```

---

## Core Components

### 1. Capability Registry

**Purpose**: Gate worker routing to validated capabilities only. Prevent untested/deprecated capabilities from executing live.

**Data Model**:
```typescript
interface SwarmCapability {
  id: string;                        // UUID
  kind: 'skill' | 'specialist' | 'loop_template';
  name: string;                      // e.g., "doc-drift-fix"
  version: string;                   // Semantic: "1.0.0"
  owner: string;                     // User/team that owns this
  status: 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
  risk_ceiling: 'low' | 'medium' | 'high' | 'critical';
  contract: {
    inputs: Record<string, TypeSpec>;   // Required parameters
    outputs: Record<string, TypeSpec>;  // Expected outputs
    side_effects: string[];             // What this touches
    token_budget: number;               // Max tokens
    wall_clock_budget_ms: number;       // Max duration
  };
  eval_score?: number;                // 0–100 (validation quality)
  eval_evidence_refs?: string[];      // Links to eval runs
  allowed_actions: string[];          // Explicit allow list (file patterns, commands)
  forbidden_actions: string[];        // Explicit deny list (destructive ops)
  metadata: {
    created_by: string;
    created_at: string;
    promoted_at?: string;            // When moved to 'validated'
    promoted_by?: string;
    last_executed_at?: string;
    execution_count: number;
  };
}
```

**Lifecycle**:
1. **Draft**: Created by specialist; not yet tested
2. **Candidate**: Passed eval threshold (>80); awaiting human review
3. **Validated**: Approved for live execution
4. **Deprecated**: Replaced by newer version; gradual phase-out
5. **Disabled**: Security issue or operational failure; immediate block

**Routing Rule**: Worker selection → Check capability status → Only `validated` can execute live

**Database Schema**:
```sql
CREATE TABLE swarm_capabilities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'specialist', 'loop_template')),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'candidate', 'validated', 'deprecated', 'disabled')),
  risk_ceiling TEXT NOT NULL CHECK(risk_ceiling IN ('low', 'medium', 'high', 'critical')),
  contract TEXT NOT NULL, -- JSON
  eval_score INTEGER, -- 0–100
  eval_evidence_refs TEXT, -- JSON array
  allowed_actions TEXT NOT NULL DEFAULT '[]', -- JSON array
  forbidden_actions TEXT NOT NULL DEFAULT '[]', -- JSON array
  metadata TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, name, version)
);

CREATE INDEX idx_swarm_capabilities_status ON swarm_capabilities(status);
CREATE INDEX idx_swarm_capabilities_kind ON swarm_capabilities(kind);
```

---

### 2. Specialist Profiles

**Purpose**: Represent domain expertise (mathematician, physicist, security reviewer, architect, product manager, strategist). Specialists form panels to analyze multi-disciplinary questions.

**Data Model**:
```typescript
interface SpecialistProfile {
  id: string;
  name: string;                      // "Alice Chen" or "Chief Mathematician"
  domain: string;                    // e.g., "mathematics", "security", "product"
  owner: string;                     // User who manages this specialist
  version: string;                   // Semantic versioning
  max_autonomy_level: 'low' | 'medium' | 'high' | 'unrestricted';
  description: string;               // Expertise areas, focus
  preferred_runtimes: string[];       // Codex, OpenCode, etc.
  base_capabilities: string[];        // [capability_ids] this specialist has access to
  metadata: {
    created_by: string;
    created_at: string;
    total_panels: number;            // How many panels they've participated in
    consensus_rate: number;          // % of time consensus vs. dissent
    last_used_at?: string;
  };
}
```

**Built-in Specialists** (suggested defaults):
- **Mathematician**: Validates logic, proofs, constraints, complexity
- **Physicist**: Energy/performance optimization, physical constraints
- **Security Reviewer**: Threat modeling, access control, vulnerability analysis
- **Architect**: System design, scalability, integration points
- **Product Manager**: User impact, feature prioritization, acceptance criteria
- **Strategist**: Long-term vision alignment, cross-phase dependencies

**Database Schema**:
```sql
CREATE TABLE specialist_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  owner TEXT NOT NULL,
  version TEXT NOT NULL,
  max_autonomy_level TEXT NOT NULL CHECK(max_autonomy_level IN ('low', 'medium', 'high', 'unrestricted')),
  description TEXT NOT NULL,
  preferred_runtimes TEXT NOT NULL DEFAULT '[]', -- JSON array
  base_capabilities TEXT NOT NULL DEFAULT '[]', -- JSON array of capability_ids
  metadata TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain, name)
);

CREATE INDEX idx_specialist_profiles_domain ON specialist_profiles(domain);
```

---

### 3. Hypothesis Workbench

**Purpose**: Validate research questions before spawning workers. Generate evidence plans, form panels, derive consensus. Prevent speculative worker leases.

**Data Model**:
```typescript
interface Hypothesis {
  id: string;
  question: string;                  // e.g., "Does our build scale to 100k components?"
  hypothesis_type: 'research' | 'validation' | 'exploration';
  discovery_budget: {
    max_tokens: number;              // e.g., 50,000
    max_leases: number;              // e.g., 5
    max_panels: number;              // e.g., 3
  };
  evidence_plan: {
    goal: string;                    // What we're trying to prove/disprove
    scope: string[];                 // What areas to investigate
    success_criteria: string[];       // How we measure success
    blockers: string[];              // Known unknowns
  };
  status: 'draft' | 'planned' | 'in_evidence_collection' | 'panel_review' | 'backlog_created' | 'archived';
  
  // Panel consensus
  specialist_panels: string[];       // [panel_ids]
  consensus_findings?: string;       // What we learned
  consensus_confidence: number;      // 0–100
  dissent?: {
    specialist_id: string;
    position: string;                // Their alternative view
    reasoning: string;
  }[];
  
  // Derived backlog
  backlog_item_id?: string;          // Link to created goal (if consensus reached)
  created_at: string;
  completed_at?: string;
}
```

**Workflow**:
1. User submits question → Hypothesis (draft)
2. Evidence plan generated (scope, success criteria)
3. Specialist panel selected (e.g., [Mathematician, Architect])
4. Panel deliberation (recorded as panel_id)
5. Consensus reached → Backlog goal created (not immediately executed)
6. Dissent recorded → Preserved in hypothesis record

**Discovery Budget Enforcement**: 
- Token usage tracked per hypothesis
- Leases blocked if budget exhausted
- Panels can be reviewers only (read-only) to conserve tokens

**Database Schema**:
```sql
CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  hypothesis_type TEXT NOT NULL CHECK(hypothesis_type IN ('research', 'validation', 'exploration')),
  discovery_budget TEXT NOT NULL, -- JSON
  evidence_plan TEXT NOT NULL, -- JSON
  status TEXT NOT NULL CHECK(status IN ('draft', 'planned', 'in_evidence_collection', 'panel_review', 'backlog_created', 'archived')),
  specialist_panels TEXT NOT NULL DEFAULT '[]', -- JSON array of panel_ids
  consensus_findings TEXT,
  consensus_confidence INTEGER CHECK(consensus_confidence >= 0 AND consensus_confidence <= 100),
  dissent TEXT, -- JSON array of {specialist_id, position, reasoning}
  backlog_item_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (backlog_item_id) REFERENCES goals(id) ON DELETE SET NULL
);

CREATE INDEX idx_hypotheses_status ON hypotheses(status);
```

---

### 4. Specialist Panels

**Purpose**: Convene specialists to deliberate on complex questions. Record consensus, dissent, and evidence.

**Data Model**:
```typescript
interface SpecialistPanel {
  id: string;
  hypothesis_id: string;             // What question are they answering?
  question: string;                  // Explicit question text
  evidence_plan: string;             // Summarized plan for this panel
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  
  members: {
    specialist_id: string;
    specialist_name: string;
    role: 'reviewer' | 'decision_maker' | 'observer';
  }[];
  
  status: 'formed' | 'in_deliberation' | 'consensus_reached' | 'conflict' | 'archived';
  
  // Deliberation record
  deliberation_log: {
    timestamp: string;
    specialist_id: string;
    action: 'joined' | 'proposed' | 'objected' | 'abstained';
    evidence_refs: string[];        // Links to docs/runs that informed decision
    notes: string;
  }[];
  
  // Consensus
  consensus_findings: string;        // What the panel agrees on
  consensus_type: 'unanimous' | 'majority' | 'split';
  consensus_confidence: number;      // 0–100
  
  // Dissent (preserved explicitly)
  dissent_members: {
    specialist_id: string;
    position: string;
    reasoning: string;
    confidence: number;
  }[];
  
  evidence_refs: string[];           // Links to supporting evidence
  created_at: string;
  completed_at?: string;
}
```

**Panel Formation Rules**:
- Minimum 2 specialists per panel
- All relevant domains represented (e.g., security question → includes Security Reviewer)
- Mix of decision_makers and reviewers (reviewers can investigate without voting)

**Consensus Recording**:
- Unanimous: All agree
- Majority: >50% agree
- Split: Explicit dissent preserved with reasoning

**Database Schema**:
```sql
CREATE TABLE specialist_panels (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL,
  question TEXT NOT NULL,
  evidence_plan TEXT NOT NULL,
  risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
  members TEXT NOT NULL, -- JSON array
  status TEXT NOT NULL CHECK(status IN ('formed', 'in_deliberation', 'consensus_reached', 'conflict', 'archived')),
  deliberation_log TEXT NOT NULL DEFAULT '[]', -- JSON array
  consensus_findings TEXT,
  consensus_type TEXT CHECK(consensus_type IN ('unanimous', 'majority', 'split')),
  consensus_confidence INTEGER CHECK(consensus_confidence >= 0 AND consensus_confidence <= 100),
  dissent_members TEXT, -- JSON array
  evidence_refs TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (hypothesis_id) REFERENCES hypotheses(id) ON DELETE CASCADE
);

CREATE INDEX idx_specialist_panels_hypothesis_id ON specialist_panels(hypothesis_id);
CREATE INDEX idx_specialist_panels_status ON specialist_panels(status);
```

---

### 5. Evidence Graph & Claim Ledger

**Purpose**: Maintain immutable record of operational truth. Track claims, evidence, and explicit contradictions. No auto-inference.

**Evidence Graph** (Directed, immutable):
- **Nodes**: Facts, artifacts, claims, decisions
- **Edges**: Relationships (supports, refines, contradicts, sources, causes)

**Claim Ledger** (Typed claims with lifecycle):
- **Subject**: What the claim is about (e.g., goal_id, loop_id, capability_id)
- **Predicate**: The property being claimed (e.g., "passes_security_review", "ready_for_production")
- **Object**: The value (e.g., "true", "2024-06-20T19:00:00Z")
- **Status**: proposed → supported → resolved (or refuted)

**Data Model**:
```typescript
interface SwarmClaim {
  id: string;
  subject_ref: string;               // e.g., "goal/abc123"
  subject_type: 'goal' | 'loop' | 'capability' | 'specialist' | 'hypothesis';
  predicate: string;                 // e.g., "passes_security_review"
  object: string;                    // e.g., "true" or JSON
  status: 'proposed' | 'supported' | 'resolved' | 'refuted' | 'withdrawn';
  confidence: number;                // 0–100
  
  evidence_refs: string[];           // Links to supporting artifacts
  evidence_strength: 'weak' | 'moderate' | 'strong' | 'conclusive';
  
  // Relationship graph
  supports_refs: string[];           // Claims this supports
  supported_by_refs: string[];       // Claims supporting this
  contradicts_refs: string[];        // Explicitly contradictory claims (preserved)
  refines_refs: string[];            // More specific versions
  
  proposed_by: string;               // User/system that proposed
  proposed_at: string;
  decided_by?: string;               // User that resolved
  decided_at?: string;
  
  metadata: {
    reasoning: string;               // Why this claim matters
    context: Record<string, unknown>;
  };
}

interface EvidenceGraphNode {
  id: string;
  kind: 'claim' | 'artifact' | 'decision' | 'event' | 'metric';
  ref_id: string;                    // Foreign key to actual object
  properties: Record<string, unknown>;
  created_at: string;
}

interface EvidenceGraphEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relationship: 'supports' | 'contradicts' | 'refines' | 'sources' | 'causes' | 'relates_to';
  strength: number;                  // 0–1 confidence
  reasoning: string;
  created_at: string;
}
```

**Critical Invariants**:
- No auto-inference: Contradictions must be explicit edges
- Immutable: Claims/edges never deleted, only archived
- Resolvable: All refs must point to valid objects
- Audit trail: All changes timestamped and attributed

**Database Schema**:
```sql
CREATE TABLE swarm_claims (
  id TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('goal', 'loop', 'capability', 'specialist', 'hypothesis')),
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed', 'supported', 'resolved', 'refuted', 'withdrawn')),
  confidence INTEGER CHECK(confidence >= 0 AND confidence <= 100),
  evidence_refs TEXT NOT NULL DEFAULT '[]', -- JSON array
  evidence_strength TEXT CHECK(evidence_strength IN ('weak', 'moderate', 'strong', 'conclusive')),
  supports_refs TEXT NOT NULL DEFAULT '[]', -- JSON array of claim_ids
  supported_by_refs TEXT NOT NULL DEFAULT '[]', -- JSON array
  contradicts_refs TEXT NOT NULL DEFAULT '[]', -- Explicit contradictions
  refines_refs TEXT NOT NULL DEFAULT '[]',
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT,
  metadata TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE evidence_graph_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('claim', 'artifact', 'decision', 'event', 'metric')),
  ref_id TEXT NOT NULL,
  properties TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE evidence_graph_edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  relationship TEXT NOT NULL CHECK(relationship IN ('supports', 'contradicts', 'refines', 'sources', 'causes', 'relates_to')),
  strength REAL CHECK(strength >= 0 AND strength <= 1),
  reasoning TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_node_id) REFERENCES evidence_graph_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES evidence_graph_nodes(id) ON DELETE CASCADE
);

CREATE INDEX idx_swarm_claims_subject_ref ON swarm_claims(subject_ref);
CREATE INDEX idx_swarm_claims_status ON swarm_claims(status);
CREATE INDEX idx_evidence_graph_edges_source ON evidence_graph_edges(source_node_id);
```

---

### 6. Capacity Governor V2

**Purpose**: Fair-share scheduling with queue classes. Prevent high-cost research from starving critical fixes.

**Queue Classes**:
- **research**: Hypothesis exploration, discovery (~20% fleet)
- **doc_fix**: Documentation drift, small fixes (~30% fleet)
- **test_repair**: Test failures, CI issues (~15% fleet)
- **security**: Security patches, vulnerability fixes (~20% fleet)
- **memory**: Knowledge base updates (~10% fleet)
- **policy**: Policy enforcement, governance updates (~5% fleet)

**Data Model**:
```typescript
interface QueueClass {
  id: string;
  name: string;                      // e.g., "doc_fix"
  priority: number;                  // 1–10 (10 = highest)
  weight: number;                    // Fair-share weight
  max_concurrency: number;           // Max simultaneous leases
  max_parallel_per_user: number;     // Prevent single user monopolizing
  token_budget: number;              // Per-class budget
  token_budget_period_ms: number;    // Refill period (e.g., 3600000 = 1 hour)
  wall_clock_budget_ms: number;      // Max duration per lease
  created_at: string;
}

interface CapacityDecision {
  id: string;
  lease_id: string;
  queue_class: string;               // Which class this lease belongs to
  decision: 'eligible' | 'queued' | 'running' | 'blocked';
  blocked_reason?: string;           // If blocked: why?
  
  // Resource snapshot at decision time
  metrics: {
    cpu_load: number;                // 0–100%
    memory_pct: number;              // % of system memory used
    active_leases_by_class: Record<string, number>;
    token_usage_by_class: Record<string, number>;
  };
  
  scheduler_decision: {
    reason: string;
    suggested_wait_ms?: number;      // If queued: when to retry
  };
  
  decided_at: string;
  decided_by: string;                // System service
}
```

**Scheduling Algorithm**:
1. Lease submitted → Classify by goal/hypothesis type → Determine queue_class
2. Check capacity: active_leases[class] < max_concurrency?
3. Check budget: tokens_used[class] < budget?
4. Check system: cpu_load < 80% && memory < 85%?
5. If all pass → eligible (→ running)
6. If budget exhausted → queue (retry after budget refill)
7. If system overloaded → blocked (with wait_ms suggestion)

**Database Schema**:
```sql
CREATE TABLE queue_classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  priority INTEGER NOT NULL CHECK(priority >= 1 AND priority <= 10),
  weight INTEGER NOT NULL DEFAULT 1,
  max_concurrency INTEGER NOT NULL DEFAULT 5,
  max_parallel_per_user INTEGER NOT NULL DEFAULT 2,
  token_budget INTEGER NOT NULL,
  token_budget_period_ms INTEGER NOT NULL DEFAULT 3600000,
  wall_clock_budget_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE capacity_scheduler_decisions (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  queue_class TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('eligible', 'queued', 'running', 'blocked')),
  blocked_reason TEXT,
  metrics TEXT NOT NULL, -- JSON
  scheduler_decision TEXT NOT NULL, -- JSON
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT NOT NULL,
  FOREIGN KEY (lease_id) REFERENCES worker_leases(id) ON DELETE CASCADE,
  FOREIGN KEY (queue_class) REFERENCES queue_classes(name) ON DELETE RESTRICT
);

CREATE INDEX idx_capacity_scheduler_decisions_lease_id ON capacity_scheduler_decisions(lease_id);
CREATE INDEX idx_capacity_scheduler_decisions_queue_class ON capacity_scheduler_decisions(queue_class);
```

---

### 7. Mission Control Dashboard

**Purpose**: Operator view of swarm intelligence state. Registry, planned work, blocked reasons.

**Dashboard Components**:

1. **Capability Registry View**:
   - Filter by status (draft, candidate, validated, deprecated, disabled)
   - Show eval_score for candidates
   - Promote/demote buttons (draft → candidate → validated)

2. **Specialist Councils**:
   - Active panels with consensus status
   - Dissent tracking (explicitly highlighted)
   - Deliberation log drillable

3. **Hypothesis Workbench**:
   - Planned questions (draft, in_evidence_collection, panel_review)
   - Discovery budget used / remaining
   - Evidence plans visible
   - Backlog items created from consensus

4. **Evidence Graph Visualization**:
   - Interactive node/edge display
   - Contradiction detection (explicit contradicts_refs)
   - Drill-down to claim details

5. **Capacity Governor**:
   - Queue class status (concurrency, budget used, active leases)
   - Blocked reasons summary (why workers can't start)
   - Fair-share allocation visualization

6. **Alerts**:
   - Contradictory claims detected (explicit edge added)
   - Hypothesis discovery budget exhausted
   - Capability status changes
   - Panel dissent recorded

---

## Implementation Roadmap

### Phase 7A: Foundation (Weeks 1–3)

**Goal**: Capability Registry + Database Schema

**Tasks**:
1. Create all 8 new database tables (schema migration)
2. Implement CapabilityRegistry service:
   - CRUD operations (create, read, update, list)
   - Status transitions (draft → candidate → validated)
   - Eval score computation (threshold: >80)
   - Routing check: only validated execute
3. Add API routes:
   - `POST /api/capabilities` (create)
   - `GET /api/capabilities` (list with filters)
   - `PATCH /api/capabilities/:id` (update status)
   - `POST /api/capabilities/:id/promote` (draft → candidate)
4. Write 20+ unit tests

**Deliverable**: Capability Registry fully operational. Workers can be routed by capability.

### Phase 7B: Specialist Intelligence (Weeks 4–6)

**Goal**: Specialist Profiles + Panels + Hypothesis Workbench

**Tasks**:
1. Implement SpecialistProfileService:
   - CRUD for specialist profiles
   - Built-in specialists (6: math, physics, security, architect, product, strategist)
2. Implement SpecialistPanelService:
   - Form panel (validate domains represented)
   - Record deliberation (proposals, objections, consensus)
   - Dissent preservation
3. Implement HypothesisWorkbenchService:
   - Create hypothesis from question
   - Evidence plan generation
   - Panel formation + deliberation workflow
   - Backlog creation on consensus
4. Add API routes (6–8 endpoints)
5. Write 30+ unit tests

**Deliverable**: Specialist panels can convene, deliberate, and create backlog items without spawning workers.

### Phase 7C: Evidence & Claims (Weeks 7–9)

**Goal**: Evidence Graph + Claim Ledger + Contradiction Detection

**Tasks**:
1. Implement ClaimLedgerService:
   - Create/update claims
   - Status transitions (proposed → supported → resolved)
   - Confidence scoring
2. Implement EvidenceGraphService:
   - Node/edge CRUD
   - Relationship validation (supports, contradicts, refines, etc.)
   - Contradiction detection (explicit edges)
   - Reachability queries (show evidence chain)
3. Add API routes (8–10 endpoints)
4. Write 40+ unit tests

**Deliverable**: Immutable evidence audit trail. Claims can be contradicted explicitly; no false negatives.

### Phase 7D: Capacity Governor V2 (Weeks 10–11)

**Goal**: Queue Classes + Fair-Share Scheduling + Capacity Decisions

**Tasks**:
1. Implement CapacityGovernorV2Service:
   - Queue class management (CRUD)
   - Lease classification (goal type → queue_class)
   - Scheduling algorithm (eligible/queued/blocked)
   - Fair-share enforcement
2. Integrate with Phase 6 loop-service:
   - Check capacity before leasing workers
   - Update capacity_scheduler_decisions table
3. Add API routes (4–6 endpoints)
4. Write 30+ unit tests

**Deliverable**: Fair-share scheduling operational. Research ≠ starvation of fixes.

### Phase 7E: Mission Control Dashboard (Weeks 12)

**Goal**: React component for Intelligence visualization

**Tasks**:
1. Create MissionControlPage.tsx (~600 lines):
   - Capability Registry view
   - Specialist Councils view
   - Hypothesis Workbench view
   - Evidence Graph visualization
   - Capacity Governor view
   - Alerts + Contradictions
2. Add interactive features:
   - Filter capabilities by status
   - Promote/demote capabilities (UI button)
   - Drill-down to panel deliberation
   - Evidence chain viewer
   - Queue class allocation chart
3. Write component tests

**Deliverable**: Mission Control Dashboard deployed. Operators can visualize swarm intelligence state.

---

## API Design (Phase 7)

### Capability Registry

```http
POST /api/capabilities
Content-Type: application/json

{
  "kind": "skill",
  "name": "doc-drift-fix",
  "version": "1.0.0",
  "risk_ceiling": "low",
  "contract": {
    "inputs": {"target_dir": "string", "dry_run": "boolean"},
    "outputs": {"files_changed": "number"},
    "token_budget": 10000,
    "wall_clock_budget_ms": 30000
  },
  "allowed_actions": ["file:write:*.md", "cli:git:add", "cli:git:commit"],
  "forbidden_actions": ["file:write:/etc", "cli:destructive"]
}

Response: 201 Created
{
  "id": "cap-abc123",
  "status": "draft",
  "eval_score": null,
  ...
}
```

```http
PATCH /api/capabilities/cap-abc123/promote
Content-Type: application/json

{
  "to_status": "candidate",
  "eval_evidence_refs": ["eval-run-xyz"]
}

Response: 200 OK
{
  "id": "cap-abc123",
  "status": "candidate",
  "eval_score": 85,
  ...
}
```

### Hypothesis Workbench

```http
POST /api/hypotheses
Content-Type: application/json

{
  "question": "Does our build scale to 100k components?",
  "hypothesis_type": "validation",
  "evidence_plan": {
    "goal": "Prove/disprove scalability claim",
    "scope": ["build", "type_checking", "runtime"],
    "success_criteria": ["build completes in < 2min", "memory < 4GB"],
    "blockers": ["need test repo with 100k files"]
  },
  "discovery_budget": {
    "max_tokens": 50000,
    "max_leases": 5,
    "max_panels": 2
  },
  "specialist_domains": ["mathematician", "architect"]
}

Response: 201 Created
{
  "id": "hyp-abc123",
  "status": "draft",
  "specialist_panels": [],
  ...
}
```

```http
POST /api/specialist-panels
Content-Type: application/json

{
  "hypothesis_id": "hyp-abc123",
  "specialists": ["spec-mathematician", "spec-architect"],
  "evidence_plan": "Build scaling validation",
  "risk_class": "high"
}

Response: 201 Created
{
  "id": "panel-xyz",
  "status": "formed",
  ...
}
```

```http
POST /api/specialist-panels/panel-xyz/deliberation
Content-Type: application/json

{
  "specialist_id": "spec-mathematician",
  "action": "proposed",
  "evidence_refs": ["metric-build-time", "metric-memory"],
  "notes": "Scaling appears linear; should handle 100k components"
}

Response: 200 OK
```

```http
POST /api/specialist-panels/panel-xyz/consensus
Content-Type: application/json

{
  "findings": "Build scales linearly; ready to test at 100k",
  "consensus_type": "unanimous",
  "confidence": 95,
  "create_backlog_item": true
}

Response: 200 OK
{
  "backlog_item_id": "goal-abc",
  "status": "backlog_created",
  ...
}
```

### Claim Ledger

```http
POST /api/claims
Content-Type: application/json

{
  "subject_ref": "cap-abc123",
  "subject_type": "capability",
  "predicate": "passes_security_review",
  "object": "true",
  "confidence": 95,
  "evidence_refs": ["sec-review-2024-06-20"],
  "evidence_strength": "strong",
  "reasoning": "Security team approved after threat modeling"
}

Response: 201 Created
{
  "id": "claim-xyz",
  "status": "proposed",
  ...
}
```

```http
PATCH /api/claims/claim-xyz
Content-Type: application/json

{
  "status": "supported",
  "decided_by": "user-abc",
  "additional_evidence_refs": ["sec-review-followup"]
}

Response: 200 OK
```

### Capacity Governor

```http
GET /api/queue-classes

Response: 200 OK
{
  "queue_classes": [
    {
      "id": "qc-research",
      "name": "research",
      "priority": 2,
      "weight": 2,
      "max_concurrency": 3,
      "token_budget": 100000,
      "wall_clock_budget_ms": 600000
    },
    {
      "id": "qc-doc_fix",
      "name": "doc_fix",
      "priority": 7,
      "weight": 3,
      "max_concurrency": 5,
      "token_budget": 50000,
      "wall_clock_budget_ms": 300000
    },
    ...
  ]
}
```

```http
GET /api/capacity/decisions?status=blocked

Response: 200 OK
{
  "decisions": [
    {
      "lease_id": "lease-abc",
      "queue_class": "research",
      "decision": "blocked",
      "blocked_reason": "budget_exhausted",
      "metrics": {
        "cpu_load": 45,
        "memory_pct": 62,
        "token_usage_by_class": {"research": 100000, "doc_fix": 30000}
      },
      "scheduler_decision": {
        "reason": "Research queue budget exhausted; refill at 2024-06-21T00:00:00Z",
        "suggested_wait_ms": 3600000
      }
    }
  ]
}
```

---

## Success Criteria

### Phase 7 MVP (Weeks 1–9)

**Tier 1: Core Functionality**
- [ ] Capability Registry: draft/candidate/validated status gates worker routing
- [ ] Specialist Profiles: 6 built-in specialists available
- [ ] Hypothesis Workbench: question → evidence plan → panel → backlog (no workers spawned)
- [ ] Specialist Panels: consensus + dissent recorded explicitly
- [ ] Evidence Graph: contradictions explicit (no auto-inference)
- [ ] Claim Ledger: proposed → supported → resolved lifecycle
- [ ] 100+ unit tests passing

**Tier 2: Integration**
- [ ] Capacity Governor V2: Fair-share scheduling operational
- [ ] Worker routing checks capability status (only validated execute)
- [ ] Discovery budget enforced (hypothesis leases blocked if exhausted)
- [ ] Queue classes prevent research starvation (20/30/15/20/10/5 allocation)

**Tier 3: Dashboard & Observability**
- [ ] Mission Control Dashboard deployed
- [ ] Capability registry UI (filter, promote, view eval score)
- [ ] Specialist panel deliberation drillable
- [ ] Evidence graph visualization (nodes, edges, contradictions)
- [ ] Capacity Governor status card (queue allocation, blocked reasons)

### Phase 7 RC (Weeks 10–12)

**E2E Workflow Test**:
1. Create hypothesis: "Determine optimal team size for Phase 8"
2. Form panel: [mathematician, architect, product]
3. Panel deliberates: consensus that 4 people needed
4. Backlog goal created (not executed)
5. Show contradiction explicitly when specialist objects
6. Mission Control shows:
   - Hypothesis progress
   - Panel membership
   - Evidence refs
   - Capacity allocation for any leases

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Contradictions hard to detect | Medium | High | Explicit edge model; graph queries test exhaustively |
| Panel dissent conflicts with product | Medium | Medium | Human approval required for backlog creation |
| Fair-share starvation still possible | Low | Medium | Regular fair-share audit; alerts if any class drops below minimum |
| Eval score gaming (cheap approvals) | Low | High | Human review required for validation step; audit trail preserved |
| Capability contract drift over time | Medium | High | Phase 12 includes contract probing; version tracking mandatory |
| Evidence graph becomes too large | Low | Medium | Archive/prune older claims after resolution |

---

## Dependencies & Sequencing

**Must Complete Before Phase 7A Starts**:
- Phase 6 loop-service fully operational ✅
- Database migration pipeline tested
- API routing framework (Express) stable

**Phase 7 → Phase 8 (Sequential)**:
- Phase 7 enables: Capability-driven worker routing
- Phase 8 consumes: Validated capabilities only

**Phase 7 → Phase 11 (Parallel After 7D)**:
- Phase 7D (Capacity Governor) feeds into Phase 11 (Enforcement Kernel)
- Phase 11 enforces that capabilities → workers

---

## Resource Planning

### Team Composition (3–4 engineers)

| Role | Weeks | Focus |
|------|-------|-------|
| Backend Lead | 12 | Services, DB schema, API routes |
| Full-Stack (Specialist/Panel) | 12 | Panel deliberation UX, API integration |
| Full-Stack (Evidence/Capacity) | 12 | Graph visualization, scheduler |
| QA/Tester | 12 | 100+ unit tests, E2E flows |

### Infrastructure

- **Database**: SQLite (8 new tables, ~50 MB total state)
- **Compute**: Standard (no GPU needed for inference)
- **Storage**: `.data/` directory (~500 MB for evidence graph)

### Timeline

```
Week 1–3:   Phase 7A (Capability Registry)
Week 4–6:   Phase 7B (Specialist Intelligence)
Week 7–9:   Phase 7C (Evidence & Claims)
Week 10–11: Phase 7D (Capacity Governor)
Week 12:    Phase 7E (Mission Control Dashboard)

Total: 12 weeks = 3-month sprint
```

---

## Validation & Testing Strategy

### Unit Tests (100+ tests)

- CapabilityRegistry: status transitions, routing checks (20 tests)
- SpecialistPanel: formation, deliberation, consensus (20 tests)
- Hypothesis: question → evidence plan → backlog (15 tests)
- ClaimLedger: lifecycle, contradictions, evidence refs (25 tests)
- EvidenceGraph: node/edge CRUD, reachability (15 tests)
- CapacityGovernor: scheduling, budget enforcement (15 tests)

### Integration Tests (40+ tests)

- End-to-end hypothesis workflow (no workers spawned)
- Capability routing (validated gates execution)
- Fair-share scheduling (research ≠ starvation)
- Evidence graph queries (show complete chain)

### Manual Testing (Operator workflows)

1. Create hypothesis → Form panel → Deliberate → Create backlog
2. Promote capability draft → candidate → validated
3. View Mission Control: registry, panels, blocked reasons
4. Verify contradictions detected (explicit edges)

---

## Acceptance Criteria (Definition of Done)

- [ ] All 8 database tables migrated (no rollback failures)
- [ ] 100+ unit tests passing (100% coverage on services)
- [ ] 40+ integration tests passing
- [ ] Capability Registry blocks non-validated capabilities (white-box test)
- [ ] Hypothesis workbench creates backlog without workers (black-box test)
- [ ] Specialist panels record consensus + dissent (audit trail verified)
- [ ] Evidence graph shows contradictions explicitly (no false negatives)
- [ ] Capacity Governor enforces fair-share (queue class allocation tested)
- [ ] Mission Control Dashboard deployed with all 6 components
- [ ] API documentation complete (Swagger/OpenAPI)
- [ ] User guide written (specialist panels, hypothesis creation)
- [ ] Zero security findings in code review
- [ ] Performance: Mission Control loads in < 2s, queries complete in < 500ms

---

## Post-Phase 7 (Weeks 13+)

### Phase 8 Sequencing (Parallel Work)

- **Phase 8A**: Runtime contracts, drifted blocking, checker bridges (continues)
- **Phase 8B**: Integrate Phase 7 capability routing (consumes validated capabilities)

### Phase 9 Integration

- **Smoke tests**: Use Phase 7 hypotheses as test plans
- **Policy runner**: Check queue class + capacity before executing

### Phase 11 Foundation

- **Governance kernel**: Enforce capability → worker mapping
- **Runner manifests**: Link to evidence graph (claim provenance)

---

## Success Story (Phase 7 Complete)

**Operator asks**: "Can we scale to 10k concurrent goals?"

**Current System (Phase 6)**: No answer. Must manually test or guess.

**Phase 7 System**:
1. Create hypothesis: "10k goal scalability"
2. Form specialist panel: [mathematician (complexity), architect (design)]
3. Mathematician: "10k is feasible if we shard by risk_class"
4. Architect: "SQL schema needs two indexes; memory bounded"
5. Panel consensus: "Can handle 10k with optimizations"
6. Backlog goal created: "Implement sharding strategy"
7. Capacity Governor: Reserves 40% fleet for implementation
8. Evidence graph shows: Hypothesis → Claims (feasibility, complexity) → Implementation goals → Test results

**Result**: Decisions backed by evidence. Specialist reasoning captured. Research (hypothesis) ≠ workers (execution). Future teams can drill-down to see why scaling works.

---

*Document Status*: Ready for Implementation  
*Last Updated*: June 20, 2026  
*Phase 6 Completion*: 95% complete  
*Phase 7 Kickoff*: Ready on Phase 6 release  
