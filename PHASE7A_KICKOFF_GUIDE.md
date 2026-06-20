# Phase 7A Kickoff: Capability Registry Implementation

**Start Date**: Post-Phase 6 Release (estimated Week 13)  
**Duration**: 3 weeks (Weeks 13–15)  
**Team**: 2 engineers (Backend + Full-Stack)  
**Scope**: Capability Registry foundation + Database schema + API routes

---

## Phase 7A Overview

**Goal**: Implement the Capability Registry service as the foundation for Phase 7. This enables capability-driven worker routing (validated capabilities only) and prepares the architecture for Specialist Panels and Evidence Graph.

**What Gets Built**:
- 8 new database tables (schema migration)
- CapabilityRegistry service (CRUD + status transitions)
- 6 API endpoints (list, get, create, update, promote, evaluate)
- 20+ unit tests
- Dashboard stub for Phase 7E integration

**What Gets Unblocked**:
- Phase 7B can start immediately after (Specialist Profiles)
- Phase 8 can integrate capability routing
- Phase 11 can enforce capability gates

---

## Database Schema Migration

### New Tables (Phase 7A Only)

**Table 1: swarm_capabilities**
```sql
CREATE TABLE swarm_capabilities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'specialist', 'loop_template')),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'candidate', 'validated', 'deprecated', 'disabled')),
  risk_ceiling TEXT NOT NULL CHECK(risk_ceiling IN ('low', 'medium', 'high', 'critical')),
  contract TEXT NOT NULL, -- JSON: {inputs, outputs, side_effects, token_budget, wall_clock_budget_ms}
  eval_score INTEGER, -- 0–100, NULL if not evaluated
  eval_evidence_refs TEXT, -- JSON array of eval run IDs
  allowed_actions TEXT NOT NULL DEFAULT '[]', -- JSON array of action patterns
  forbidden_actions TEXT NOT NULL DEFAULT '[]', -- JSON array of blocked patterns
  metadata TEXT NOT NULL, -- JSON: {created_by, created_at, promoted_at, promoted_by, last_executed_at, execution_count}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, name, version)
);

CREATE INDEX idx_swarm_capabilities_status ON swarm_capabilities(status);
CREATE INDEX idx_swarm_capabilities_kind ON swarm_capabilities(kind);
CREATE INDEX idx_swarm_capabilities_owner ON swarm_capabilities(owner);
CREATE INDEX idx_swarm_capabilities_name ON swarm_capabilities(name);
```

**Migration File**: `packages/server/src/database/migrate-phase7a.ts`

---

## Service Implementation

### File Structure

```
packages/server/src/
├── services/
│   ├── capability-registry.ts          (NEW - 400–500 LOC)
│   └── index.ts                        (add export)
├── routes/
│   ├── capabilities.ts                 (NEW - 150–200 LOC)
│   └── index.ts                        (add route)
├── middleware/
│   ├── capability-validator.ts         (NEW - 80–100 LOC)
│   └── index.ts                        (add middleware)
├── database/
│   └── migrate-phase7a.ts              (NEW - schema)
└── __tests__/
    └── capability-registry.test.ts     (NEW - 400–500 LOC)
```

### CapabilityRegistry Service

**File**: `packages/server/src/services/capability-registry.ts`

```typescript
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface CapabilityContract {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  side_effects: string[];
  token_budget: number;
  wall_clock_budget_ms: number;
}

export interface SwarmCapability {
  id: string;
  kind: 'skill' | 'specialist' | 'loop_template';
  name: string;
  version: string;
  owner: string;
  status: 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
  risk_ceiling: 'low' | 'medium' | 'high' | 'critical';
  contract: CapabilityContract;
  eval_score?: number;
  eval_evidence_refs?: string[];
  allowed_actions: string[];
  forbidden_actions: string[];
  metadata: {
    created_by: string;
    created_at: string;
    promoted_at?: string;
    promoted_by?: string;
    last_executed_at?: string;
    execution_count: number;
  };
  created_at: string;
  updated_at: string;
}

export interface CreateCapabilityInput {
  kind: 'skill' | 'specialist' | 'loop_template';
  name: string;
  version: string;
  risk_ceiling: 'low' | 'medium' | 'high' | 'critical';
  contract: CapabilityContract;
  allowed_actions?: string[];
  forbidden_actions?: string[];
}

export class CapabilityRegistry {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateCapabilityInput, ownerUserId: string): SwarmCapability {
    // Validate input
    if (!input.name || !input.name.trim()) {
      throw new Error('CAPABILITY_NAME_REQUIRED');
    }
    if (!input.version || !/^\d+\.\d+\.\d+/.test(input.version)) {
      throw new Error('CAPABILITY_VERSION_INVALID');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, name, version, owner, status, risk_ceiling,
        contract, allowed_actions, forbidden_actions, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const metadata = {
      created_by: ownerUserId,
      created_at: now,
      execution_count: 0,
    };

    stmt.run(
      id,
      input.kind,
      input.name,
      input.version,
      ownerUserId,
      'draft',
      input.risk_ceiling,
      JSON.stringify(input.contract),
      JSON.stringify(input.allowed_actions || []),
      JSON.stringify(input.forbidden_actions || []),
      JSON.stringify(metadata),
      now,
      now
    );

    return this.getById(id)!;
  }

  getById(id: string): SwarmCapability | null {
    const stmt = this.db.prepare(`
      SELECT * FROM swarm_capabilities WHERE id = ?
    `);
    const row = stmt.get(id) as any;
    return row ? this.deserialize(row) : null;
  }

  list(filters?: {
    kind?: string;
    status?: string;
    owner?: string;
    name?: string;
  }): SwarmCapability[] {
    let query = 'SELECT * FROM swarm_capabilities WHERE 1=1';
    const params: any[] = [];

    if (filters?.kind) {
      query += ' AND kind = ?';
      params.push(filters.kind);
    }
    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.owner) {
      query += ' AND owner = ?';
      params.push(filters.owner);
    }
    if (filters?.name) {
      query += ' AND name LIKE ?';
      params.push(`%${filters.name}%`);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.deserialize(row));
  }

  promote(id: string, to_status: 'candidate' | 'validated', promoted_by: string): SwarmCapability {
    const capability = this.getById(id);
    if (!capability) {
      throw new Error('CAPABILITY_NOT_FOUND');
    }

    // Validate state transition
    const validTransitions: Record<string, string[]> = {
      draft: ['candidate'],
      candidate: ['validated', 'draft'],
      validated: ['deprecated', 'disabled'],
      deprecated: ['disabled'],
      disabled: [],
    };

    if (!validTransitions[capability.status].includes(to_status)) {
      throw new Error(`INVALID_STATUS_TRANSITION: ${capability.status} → ${to_status}`);
    }

    // If promoting to validated, require eval_score >= 80
    if (to_status === 'validated' && (!capability.eval_score || capability.eval_score < 80)) {
      throw new Error('EVAL_THRESHOLD_NOT_MET: require eval_score >= 80');
    }

    const now = new Date().toISOString();
    const metadata = capability.metadata;
    if (to_status === 'validated') {
      metadata.promoted_at = now;
      metadata.promoted_by = promoted_by;
    }

    const stmt = this.db.prepare(`
      UPDATE swarm_capabilities
      SET status = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(to_status, JSON.stringify(metadata), now, id);
    return this.getById(id)!;
  }

  updateEvalScore(id: string, eval_score: number, evidence_refs: string[]): SwarmCapability {
    if (eval_score < 0 || eval_score > 100) {
      throw new Error('EVAL_SCORE_OUT_OF_RANGE');
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE swarm_capabilities
      SET eval_score = ?, eval_evidence_refs = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(eval_score, JSON.stringify(evidence_refs), now, id);
    return this.getById(id)!;
  }

  canRoute(id: string): boolean {
    const capability = this.getById(id);
    if (!capability) return false;

    // Only validated capabilities can route live workers
    return capability.status === 'validated';
  }

  recordExecution(id: string, tokens_used: number): void {
    const capability = this.getById(id);
    if (!capability) {
      throw new Error('CAPABILITY_NOT_FOUND');
    }

    const now = new Date().toISOString();
    const metadata = capability.metadata;
    metadata.last_executed_at = now;
    metadata.execution_count += 1;

    const stmt = this.db.prepare(`
      UPDATE swarm_capabilities
      SET metadata = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(JSON.stringify(metadata), now, id);
  }

  private deserialize(row: any): SwarmCapability {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      version: row.version,
      owner: row.owner,
      status: row.status,
      risk_ceiling: row.risk_ceiling,
      contract: JSON.parse(row.contract),
      eval_score: row.eval_score,
      eval_evidence_refs: row.eval_evidence_refs ? JSON.parse(row.eval_evidence_refs) : undefined,
      allowed_actions: JSON.parse(row.allowed_actions),
      forbidden_actions: JSON.parse(row.forbidden_actions),
      metadata: JSON.parse(row.metadata),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
```

---

## API Routes

**File**: `packages/server/src/routes/capabilities.ts`

```typescript
import { Router } from 'express';
import { CapabilityRegistry } from '../services/capability-registry';
import { AuthService } from '../services/auth-service';
import { Database } from 'better-sqlite3';

export function createCapabilityRoutes(db: Database, auth: AuthService) {
  const router = Router();
  const registry = new CapabilityRegistry(db);

  // POST /capabilities - Create new capability
  router.post('/', (req, res) => {
    try {
      const { kind, name, version, risk_ceiling, contract, allowed_actions, forbidden_actions } = req.body;
      const user = req.user || auth.findUserById('system');

      const capability = registry.create(
        { kind, name, version, risk_ceiling, contract, allowed_actions, forbidden_actions },
        user.id
      );

      res.status(201).json(capability);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /capabilities - List capabilities
  router.get('/', (req, res) => {
    try {
      const { kind, status, owner, name } = req.query;
      const capabilities = registry.list({
        kind: kind as string,
        status: status as string,
        owner: owner as string,
        name: name as string,
      });

      res.json({ capabilities });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /capabilities/:id - Get capability by ID
  router.get('/:id', (req, res) => {
    try {
      const capability = registry.getById(req.params.id);
      if (!capability) {
        return res.status(404).json({ error: 'CAPABILITY_NOT_FOUND' });
      }

      res.json(capability);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PATCH /capabilities/:id/promote - Promote capability status
  router.patch('/:id/promote', (req, res) => {
    try {
      const { to_status } = req.body;
      const user = req.user || auth.findUserById('system');

      const capability = registry.promote(req.params.id, to_status, user.id);
      res.json(capability);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // PATCH /capabilities/:id/eval - Update eval score
  router.patch('/:id/eval', (req, res) => {
    try {
      const { eval_score, evidence_refs } = req.body;

      const capability = registry.updateEvalScore(req.params.id, eval_score, evidence_refs);
      res.json(capability);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /capabilities/:id/execute - Record execution
  router.post('/:id/execute', (req, res) => {
    try {
      const { tokens_used } = req.body;
      registry.recordExecution(req.params.id, tokens_used);

      res.json({ status: 'recorded' });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /capabilities/:id/can-route - Check if capability can route workers
  router.get('/:id/can-route', (req, res) => {
    try {
      const canRoute = registry.canRoute(req.params.id);
      res.json({ can_route: canRoute });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
```

---

## Unit Tests

**File**: `packages/server/src/__tests__/capability-registry.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { join } from 'path';
import { rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { CapabilityRegistry } from '../services/capability-registry';

const TEST_DIR = join(tmpdir(), `djimitflo-cap-${Date.now()}`);
const TEST_DB = join(TEST_DIR, 'test.sqlite');

describe('CapabilityRegistry', () => {
  let db: BetterSqlite3.Database;
  let registry: CapabilityRegistry;
  const testUserId = 'user-test-123';

  beforeEach(() => {
    if (TEST_DIR) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });

    db = new BetterSqlite3(TEST_DB);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);

    registry = new CapabilityRegistry(db);
  });

  afterEach(() => {
    if (db) db.close();
    if (TEST_DIR) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a new capability in draft status', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'doc-drift-fix',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: { target_dir: 'string' },
            outputs: { files_changed: 'number' },
            side_effects: ['git:commit'],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      expect(cap).toBeDefined();
      expect(cap.status).toBe('draft');
      expect(cap.eval_score).toBeUndefined();
      expect(cap.name).toBe('doc-drift-fix');
      expect(cap.version).toBe('1.0.0');
    });

    it('rejects capability without name', () => {
      expect(() => {
        registry.create(
          {
            kind: 'skill',
            name: '',
            version: '1.0.0',
            risk_ceiling: 'low',
            contract: {
              inputs: {},
              outputs: {},
              side_effects: [],
              token_budget: 10000,
              wall_clock_budget_ms: 30000,
            },
          },
          testUserId
        );
      }).toThrow('CAPABILITY_NAME_REQUIRED');
    });

    it('rejects capability with invalid version', () => {
      expect(() => {
        registry.create(
          {
            kind: 'skill',
            name: 'test-skill',
            version: 'not-semantic',
            risk_ceiling: 'low',
            contract: {
              inputs: {},
              outputs: {},
              side_effects: [],
              token_budget: 10000,
              wall_clock_budget_ms: 30000,
            },
          },
          testUserId
        );
      }).toThrow('CAPABILITY_VERSION_INVALID');
    });
  });

  describe('promote', () => {
    it('promotes draft to candidate', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      const promoted = registry.promote(cap.id, 'candidate', testUserId);
      expect(promoted.status).toBe('candidate');
    });

    it('blocks promotion to validated without eval score', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      registry.promote(cap.id, 'candidate', testUserId);

      expect(() => {
        registry.promote(cap.id, 'validated', testUserId);
      }).toThrow('EVAL_THRESHOLD_NOT_MET');
    });

    it('allows promotion to validated with eval score >= 80', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      registry.promote(cap.id, 'candidate', testUserId);
      registry.updateEvalScore(cap.id, 85, ['eval-run-123']);

      const validated = registry.promote(cap.id, 'validated', testUserId);
      expect(validated.status).toBe('validated');
    });
  });

  describe('canRoute', () => {
    it('returns false for draft capabilities', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      expect(registry.canRoute(cap.id)).toBe(false);
    });

    it('returns true for validated capabilities', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      registry.promote(cap.id, 'candidate', testUserId);
      registry.updateEvalScore(cap.id, 90, ['eval-run-123']);
      registry.promote(cap.id, 'validated', testUserId);

      expect(registry.canRoute(cap.id)).toBe(true);
    });

    it('returns false for disabled capabilities', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      registry.promote(cap.id, 'candidate', testUserId);
      registry.updateEvalScore(cap.id, 90, ['eval-run-123']);
      registry.promote(cap.id, 'validated', testUserId);
      registry.promote(cap.id, 'disabled', testUserId);

      expect(registry.canRoute(cap.id)).toBe(false);
    });
  });

  describe('recordExecution', () => {
    it('increments execution count', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      expect(cap.metadata.execution_count).toBe(0);

      registry.recordExecution(cap.id, 500);
      const updated = registry.getById(cap.id)!;
      expect(updated.metadata.execution_count).toBe(1);

      registry.recordExecution(cap.id, 600);
      const updated2 = registry.getById(cap.id)!;
      expect(updated2.metadata.execution_count).toBe(2);
    });
  });

  describe('list', () => {
    it('lists all capabilities', () => {
      registry.create(
        {
          kind: 'skill',
          name: 'skill-1',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      registry.create(
        {
          kind: 'specialist',
          name: 'spec-1',
          version: '1.0.0',
          risk_ceiling: 'medium',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 20000,
            wall_clock_budget_ms: 60000,
          },
        },
        testUserId
      );

      const all = registry.list();
      expect(all).toHaveLength(2);
    });

    it('filters by status', () => {
      const cap1 = registry.create(
        {
          kind: 'skill',
          name: 'skill-1',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      const cap2 = registry.create(
        {
          kind: 'skill',
          name: 'skill-2',
          version: '1.0.0',
          risk_ceiling: 'low',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 10000,
            wall_clock_budget_ms: 30000,
          },
        },
        testUserId
      );

      registry.promote(cap1.id, 'candidate', testUserId);

      const drafts = registry.list({ status: 'draft' });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].name).toBe('skill-2');

      const candidates = registry.list({ status: 'candidate' });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].name).toBe('skill-1');
    });
  });
});
```

---

## Implementation Checklist

### Week 1: Database & Service Foundation

- [ ] Create `packages/server/src/database/migrate-phase7a.ts`
  - [ ] Define swarm_capabilities table schema
  - [ ] Write CREATE TABLE statements
  - [ ] Add migration to runMigrations() in migrate.ts
  - [ ] Test migration runs without errors

- [ ] Create `packages/server/src/services/capability-registry.ts`
  - [ ] Implement all methods (create, getById, list, promote, updateEvalScore, canRoute, recordExecution)
  - [ ] Add input validation
  - [ ] Add error handling (custom error codes)
  - [ ] Write JSDoc comments

- [ ] Create unit test file
  - [ ] Set up test database initialization
  - [ ] Write 20+ unit tests covering:
    - [ ] Create capability (valid, name/version validation)
    - [ ] Status transitions (draft → candidate → validated)
    - [ ] Eval score enforcement (>= 80 for validation)
    - [ ] canRoute logic (true only for validated)
    - [ ] recordExecution (increment counter)
    - [ ] list() with filters (status, kind, owner)

### Week 2: API Routes & Integration

- [ ] Create `packages/server/src/routes/capabilities.ts`
  - [ ] POST /capabilities (create)
  - [ ] GET /capabilities (list with filters)
  - [ ] GET /capabilities/:id (get by ID)
  - [ ] PATCH /capabilities/:id/promote (status transitions)
  - [ ] PATCH /capabilities/:id/eval (update eval score)
  - [ ] POST /capabilities/:id/execute (record execution)
  - [ ] GET /capabilities/:id/can-route (check routing eligibility)

- [ ] Integrate routes into Express app
  - [ ] Add route import in packages/server/src/index.ts
  - [ ] Mount at /api/capabilities
  - [ ] Ensure auth middleware applied

- [ ] Test all endpoints
  - [ ] Use curl or Postman
  - [ ] Test status transitions
  - [ ] Test validation errors
  - [ ] Test filtering/listing

### Week 3: Dashboard Stub & Integration

- [ ] Create capability-list component (React)
  - [ ] Fetch capabilities from API
  - [ ] Display in table (kind, name, version, status, eval_score)
  - [ ] Filter by status
  - [ ] Link to detail view (Phase 7E)

- [ ] Create promotion UI
  - [ ] Draft → Candidate button (always available)
  - [ ] Candidate → Validated button (if eval_score >= 80)
  - [ ] Show eval_score in UI

- [ ] Integrate with LoopService
  - [ ] Call registry.canRoute(capability_id) before worker lease
  - [ ] Block worker assignment if canRoute() returns false

- [ ] Run full test suite
  - [ ] `npm run test` (all tests pass)
  - [ ] `npm run build` (no TypeScript errors)
  - [ ] Manual browser test (UI works)

---

## Definition of Done (DoD)

### Code Quality
- [ ] All code reviewed and approved
- [ ] No console.log or debug statements
- [ ] TypeScript strict mode passing
- [ ] ESLint/Prettier clean
- [ ] No unused imports/variables

### Testing
- [ ] 20+ unit tests passing (100% coverage on service)
- [ ] 8+ integration tests (API routes)
- [ ] Manual E2E test (create → promote → canRoute → execute)

### Documentation
- [ ] Inline code comments (why, not what)
- [ ] JSDoc for all public methods
- [ ] API documentation (routes, request/response)
- [ ] README with Phase 7A summary

### Performance
- [ ] List query completes in < 500ms (< 10k capabilities)
- [ ] Get by ID completes in < 100ms
- [ ] Promote completes in < 50ms

### Security
- [ ] Auth checks on all routes (user context required)
- [ ] Input validation (name, version, status)
- [ ] No SQL injection (parameterized queries)
- [ ] Error messages don't leak sensitive data

---

## Success Criteria

**Must-Have** (MVP):
- ✓ Capability Registry service 100% operational
- ✓ Draft/candidate/validated status gates worker routing
- ✓ API routes all passing tests
- ✓ 20+ unit tests passing
- ✓ Build passes (tsc + vite)

**Should-Have** (Polish):
- ✓ Dashboard UI for listing/promoting capabilities
- ✓ LoopService integration (canRoute check)
- ✓ API documentation (Swagger)
- ✓ Performance benchmarks

**Nice-to-Have** (Phase 7B+):
- Bulk operations (import multiple capabilities)
- Deprecation timeline (schedule capability sunset)
- Audit trail (who promoted, when, why)

---

## Known Risks & Mitigations

| Risk | Probability | Mitigation |
|------|-------------|-----------|
| Migration fails on existing DB | Low | Test migration on Phase 6 production DB snapshot |
| Status transition bugs | Medium | Comprehensive state machine tests |
| Eval score gaming | Medium | Human review required before validation |
| Performance (large capability list) | Low | Add pagination + indexing |
| Worker routing not checking capability | High | Add explicit check in LoopService.continueLoopRun() |

---

## Phase 7A → Phase 7B Handoff

**What Phase 7B Consumes**:
- Capability Registry ready (schema + service + API)
- Worker routing integrated (only validated execute)
- Sample capabilities created (for testing)

**What Phase 7B Delivers**:
- Specialist Profiles (CRUD + built-in set)
- Specialist Panels (formation + deliberation)
- Hypothesis Workbench (question → backlog)
- All ready for Phase 7C (Evidence Graph)

---

## Phase 7A Team Assignments

| Role | Weeks | Tasks |
|------|-------|-------|
| **Backend Lead** | 3 | Service, DB schema, API routes, testing |
| **Full-Stack (Dashboard)** | 3 | UI component, LoopService integration, E2E |
| **QA/Tester** | 3 | Unit tests, integration tests, manual testing |

---

## Kickoff Meeting Agenda (30 min)

1. **Review Phase 7A Goals** (5 min)
   - Capability Registry foundation
   - Worker routing gates
   - What blocks Phase 7B start

2. **Tech Deep Dive** (10 min)
   - Database schema walkthrough
   - Service architecture (CRUD, state machine)
   - API design (routes, payloads)

3. **Task Breakdown** (10 min)
   - Week 1: DB + Service + Tests
   - Week 2: API Routes + Integration
   - Week 3: Dashboard + E2E + Buffer

4. **Open Questions** (5 min)
   - Migration strategy (backfill existing DB?)
   - Auth model (who can promote?)
   - Eval process (who scores capabilities?)

---

## References

- **Phase 7 Plan**: PHASE7_SWARM_INTELLIGENCE_PLAN.md (Section: Phase 7A: Foundation)
- **LoopService Reference**: packages/server/src/services/loop-service.ts (4,520 LOC)
- **DB Schema**: packages/server/src/database/schema.ts
- **Existing Migrations**: packages/server/src/database/migrate.ts

---

**Document Status**: ✅ Ready for Implementation  
**Last Updated**: June 20, 2026  
**Next Step**: Kickoff meeting + Week 1 sprint begins  
