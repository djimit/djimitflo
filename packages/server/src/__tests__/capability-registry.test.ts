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

    // Create test user for foreign key references
    db.prepare(`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).run(testUserId, 'test@example.com', 'hashed', 'admin');

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
      expect(cap.eval_score).toBeNull();
      expect(cap.name).toBe('doc-drift-fix');
      expect(cap.version).toBe('1.0.0');
      expect(cap.kind).toBe('skill');
      expect(cap.owner).toBe(testUserId);
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

    it('accepts valid semantic versions', () => {
      const versions = ['1.0.0', '2.1.3', '0.0.1', '10.20.30'];
      for (const version of versions) {
        const cap = registry.create(
          {
            kind: 'skill',
            name: `test-skill-${version}`,
            version,
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
        expect(cap.version).toBe(version);
      }
    });

    it('initializes metadata with created_by and execution_count=0', () => {
      const cap = registry.create(
        {
          kind: 'skill',
          name: 'test-skill',
          version: '1.0.0',
          risk_ceiling: 'medium',
          contract: {
            inputs: {},
            outputs: {},
            side_effects: [],
            token_budget: 5000,
            wall_clock_budget_ms: 60000,
          },
        },
        testUserId
      );

      expect(cap.metadata.created_by).toBe(testUserId);
      expect(cap.metadata.execution_count).toBe(0);
      expect(cap.metadata.created_at).toBeDefined();
      expect(cap.metadata.promoted_at).toBeUndefined();
    });
  });

  describe('getById', () => {
    it('retrieves capability by ID', () => {
      const created = registry.create(
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

      const retrieved = registry.getById(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.name).toBe('test-skill');
    });

    it('returns null for non-existent capability', () => {
      const retrieved = registry.getById('non-existent-id');
      expect(retrieved).toBeNull();
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

    it('blocks promotion to validated with eval score < 80', () => {
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
      registry.updateEvalScore(cap.id, 79, ['eval-run-123']);

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
      expect(validated.metadata.promoted_at).toBeDefined();
      expect(validated.metadata.promoted_by).toBe(testUserId);
    });

    it('allows promotion to validated with eval score exactly 80', () => {
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
      registry.updateEvalScore(cap.id, 80, ['eval-run-123']);

      const validated = registry.promote(cap.id, 'validated', testUserId);
      expect(validated.status).toBe('validated');
    });

    it('allows demotion from candidate back to draft', () => {
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
      const demoted = registry.promote(cap.id, 'draft', testUserId);
      expect(demoted.status).toBe('draft');
    });

    it('allows transition from validated to deprecated', () => {
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

      const deprecated = registry.promote(cap.id, 'deprecated', testUserId);
      expect(deprecated.status).toBe('deprecated');
    });

    it('allows transition from validated to disabled', () => {
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

      const disabled = registry.promote(cap.id, 'disabled', testUserId);
      expect(disabled.status).toBe('disabled');
    });

    it('rejects invalid status transitions', () => {
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

      expect(() => {
        registry.promote(cap.id, 'validated', testUserId);
      }).toThrow('INVALID_STATUS_TRANSITION');

      registry.promote(cap.id, 'candidate', testUserId);
      expect(() => {
        registry.promote(cap.id, 'deprecated', testUserId);
      }).toThrow('INVALID_STATUS_TRANSITION');
    });

    it('throws when capability not found', () => {
      expect(() => {
        registry.promote('non-existent', 'candidate', testUserId);
      }).toThrow('CAPABILITY_NOT_FOUND');
    });
  });

  describe('updateEvalScore', () => {
    it('updates eval score with evidence refs', () => {
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

      const updated = registry.updateEvalScore(cap.id, 85, ['eval-run-123', 'eval-run-456']);
      expect(updated.eval_score).toBe(85);
      expect(updated.eval_evidence_refs).toEqual(['eval-run-123', 'eval-run-456']);
    });

    it('accepts eval score 0', () => {
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

      const updated = registry.updateEvalScore(cap.id, 0, []);
      expect(updated.eval_score).toBe(0);
    });

    it('accepts eval score 100', () => {
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

      const updated = registry.updateEvalScore(cap.id, 100, []);
      expect(updated.eval_score).toBe(100);
    });

    it('rejects eval score < 0', () => {
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

      expect(() => {
        registry.updateEvalScore(cap.id, -1, []);
      }).toThrow('EVAL_SCORE_OUT_OF_RANGE');
    });

    it('rejects eval score > 100', () => {
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

      expect(() => {
        registry.updateEvalScore(cap.id, 101, []);
      }).toThrow('EVAL_SCORE_OUT_OF_RANGE');
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

    it('returns false for candidate capabilities', () => {
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

    it('returns false for deprecated capabilities', () => {
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
      registry.promote(cap.id, 'deprecated', testUserId);

      expect(registry.canRoute(cap.id)).toBe(false);
    });

    it('returns false for non-existent capability', () => {
      expect(registry.canRoute('non-existent-id')).toBe(false);
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

    it('updates last_executed_at timestamp', () => {
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

      expect(cap.metadata.last_executed_at).toBeUndefined();

      registry.recordExecution(cap.id, 500);
      const updated = registry.getById(cap.id)!;
      expect(updated.metadata.last_executed_at).toBeDefined();
    });

    it('throws when capability not found', () => {
      expect(() => {
        registry.recordExecution('non-existent', 500);
      }).toThrow('CAPABILITY_NOT_FOUND');
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

    it('filters by kind', () => {
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

      const skills = registry.list({ kind: 'skill' });
      expect(skills).toHaveLength(1);
      expect(skills[0].kind).toBe('skill');

      const specialists = registry.list({ kind: 'specialist' });
      expect(specialists).toHaveLength(1);
      expect(specialists[0].kind).toBe('specialist');
    });

    it('filters by owner', () => {
      const user1 = 'user-1';
      const user2 = 'user-2';

      // Create test users
      db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`).run(user1, 'user1@example.com', 'hashed', 'admin');
      db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`).run(user2, 'user2@example.com', 'hashed', 'admin');

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
        user1
      );

      registry.create(
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
        user2
      );

      const user1Caps = registry.list({ owner: user1 });
      expect(user1Caps).toHaveLength(1);
      expect(user1Caps[0].owner).toBe(user1);
    });

    it('filters by name (LIKE query)', () => {
      registry.create(
        {
          kind: 'skill',
          name: 'doc-drift-fix',
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
          kind: 'skill',
          name: 'doc-analyzer',
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
          kind: 'skill',
          name: 'code-formatter',
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

      const docs = registry.list({ name: 'doc' });
      expect(docs).toHaveLength(2);
      expect(docs.every(c => c.name.includes('doc'))).toBe(true);
    });

    it('combines multiple filters', () => {
      const user1 = 'user-1';

      // Create test user
      db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`).run(user1, 'user1@example.com', 'hashed', 'admin');

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
        user1
      );

      registry.create(
        {
          kind: 'specialist',
          name: 'spec-1',
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
        user1
      );

      const filtered = registry.list({ kind: 'skill', owner: user1, status: 'draft' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('skill-1');
    });

    it('lists capabilities in consistent order', () => {
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

      const all = registry.list();
      expect(all.length).toBe(2);
      expect(all.map(c => c.name)).toContain('skill-1');
      expect(all.map(c => c.name)).toContain('skill-2');
    });
  });
});
