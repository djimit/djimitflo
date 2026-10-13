import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { experimentArms, recordMakerCall, ledgerTotals } from '../services/model-call-ledger';
import { createTestDb } from './helpers/test-db';

describe('model-call-ledger exports (experimentArms, recordMakerCall, ledgerTotals)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // The shared test-db helper does not create llm_model_calls (added by runMigrations);
    // create the minimum shape recordModelCall / ledgerTotals read/write.
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        consumer TEXT NOT NULL,
        model TEXT NOT NULL,
        ok INTEGER NOT NULL,
        latency_ms INTEGER,
        out_chars INTEGER,
        shadow INTEGER NOT NULL DEFAULT 0,
        agree INTEGER,
        provider TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        task_kind TEXT,
        run_id TEXT,
        status TEXT,
        attempts INTEGER,
        purpose TEXT,
        experiment_id TEXT,
        cost_basis TEXT,
        list_price_cost REAL,
        marginal_cost REAL,
        created_at TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('experimentArms', () => {
    it('returns null when no arms are present', () => {
      expect(experimentArms(db, null, null, null)).toBeNull();
    });

    it('formats the ACE arm as ACE-001:<arm>', () => {
      expect(experimentArms(db, null, { arm: '01' }, null)).toBe('ACE-001:01');
    });

    it('formats the STE arm as STE-001:<arm>', () => {
      expect(experimentArms(db, null, null, { arm: 1 })).toBe('STE-001:1');
    });

    it('joins ACE and STE arms in order', () => {
      expect(experimentArms(db, null, { arm: 'cross' }, { arm: 2 })).toBe('ACE-001:cross,STE-001:2');
    });

    it('appends the F2 arm from the goal metadata checker_family_arm', () => {
      db.prepare("INSERT INTO goals (id, objective, metadata) VALUES ('g1', 'o', ?)").run(
        JSON.stringify({ checker_family_arm: 'cross' }),
      );
      expect(experimentArms(db, 'g1', { arm: '01' }, { arm: 1 })).toBe('ACE-001:01,STE-001:1,F2:cross');
    });

    it('omits the F2 arm when the goal has no checker_family_arm metadata', () => {
      db.prepare("INSERT INTO goals (id, objective, metadata) VALUES ('g2', 'o', '{}')").run();
      expect(experimentArms(db, 'g2', null, null)).toBeNull();
    });

    it('returns null when the goal id does not exist (query yields nothing)', () => {
      expect(experimentArms(db, 'missing', null, null)).toBeNull();
    });

    it('still returns ACE/STE arms when the goals table lookup throws (old schema)', () => {
      db.exec('DROP TABLE goals');
      expect(experimentArms(db, 'gone', { arm: '01' }, { arm: 1 })).toBe('ACE-001:01,STE-001:1');
    });
  });

  describe('recordMakerCall', () => {
    it('records one row tagged maker:<loopName> with the experiment arms', () => {
      db.prepare("INSERT INTO goals (id, objective, metadata) VALUES ('g9', 'o', ?)").run(
        JSON.stringify({ checker_family_arm: 'cross' }),
      );
      recordMakerCall(db, {
        runId: 'run-1',
        goalId: 'g9',
        loopName: 'self-improvement',
        runtime: 'opencode',
        meta: { model: 'glm-5.2', runtime_usage: { input_tokens: 1200, output_tokens: 300 } },
        ace: { arm: '01' },
        ste: { arm: 1 },
        durationMs: 42,
        ok: true,
      });
      const row = db.prepare('SELECT consumer, model, provider, task_kind, run_id, purpose, experiment_id, status, tokens_in, tokens_out FROM llm_model_calls').get() as Record<string, unknown>;
      expect(row.consumer).toBe('maker');
      expect(row.model).toBe('glm-5.2');
      expect(row.provider).toBe('opencode');
      expect(row.task_kind).toBe('self-improvement');
      expect(row.run_id).toBe('run-1');
      expect(row.purpose).toBe('maker:self-improvement');
      expect(row.experiment_id).toBe('ACE-001:01,STE-001:1,F2:cross');
      expect(row.status).toBe('verified');
      expect(row.tokens_in).toBe(1200);
      expect(row.tokens_out).toBe(300);
    });

    it('falls back to the runtime as the model when meta.model is absent', () => {
      recordMakerCall(db, {
        runId: 'run-2', goalId: null, loopName: 'planning', runtime: 'codex',
        meta: { runtime_usage: { total_tokens: 500 } }, ace: null, ste: null, durationMs: 7, ok: false,
      });
      const row = db.prepare('SELECT model, provider, status, tokens_in, tokens_out, experiment_id FROM llm_model_calls').get() as Record<string, unknown>;
      expect(row.model).toBe('codex');
      expect(row.provider).toBe('codex');
      expect(row.status).toBe('not_verified');
      expect(row.tokens_in).toBe(500);
      expect(row.tokens_out).toBeNull();
      expect(row.experiment_id).toBeNull();
    });

    it('never throws when the llm_model_calls table is missing (ledger must not break the call)', () => {
      db.exec('DROP TABLE llm_model_calls');
      expect(() =>
        recordMakerCall(db, {
          runId: 'run-3', goalId: null, loopName: 'x', runtime: 'opencode',
          meta: { runtime_usage: {} }, ace: null, ste: null, durationMs: 1, ok: true,
        }),
      ).not.toThrow();
    });
  });

  describe('ledgerTotals', () => {
    it('groups by purpose and experiment_id over the since cutoff', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO llm_model_calls (consumer, model, ok, latency_ms, out_chars, shadow, tokens_in, tokens_out, purpose, experiment_id, cost_basis, list_price_cost, marginal_cost, created_at)
        VALUES ('maker','m',1,10,0,0,100,20,'maker:self-improvement','ACE-001:01','metered',0.01,0.01,?),
               ('maker','m',0,5,0,0,NULL,NULL,'maker:self-improvement','ACE-001:01','unknown',NULL,NULL,?),
               ('maker','m',1,8,0,0,50,10,'maker:planning',NULL,'local',NULL,0,?)`).run(now, now, now);
      const totals = ledgerTotals(db, '2000-01-01T00:00:00.000Z');
      expect(totals.by_purpose).toHaveLength(2);
      const si = totals.by_purpose.find((r) => r.key === 'maker:self-improvement') as Record<string, unknown>;
      expect(si.calls).toBe(2);
      expect(si.ok).toBe(1);
      expect(si.calls_tokens_unknown).toBe(1);
      expect(si.tokens_in).toBe(100);
      expect(si.tokens_out).toBe(20);
      const plan = totals.by_purpose.find((r) => r.key === 'maker:planning') as Record<string, unknown>;
      expect(plan.calls).toBe(1);
      expect(totals.by_experiment).toHaveLength(1);
      const ace = totals.by_experiment[0] as Record<string, unknown>;
      expect(ace.key).toBe('ACE-001:01');
      expect(ace.calls).toBe(2);
    });

    it('returns empty arrays when no rows match the window', () => {
      const totals = ledgerTotals(db, '9999-12-31T00:00:00.000Z');
      expect(totals.by_purpose).toEqual([]);
      expect(totals.by_experiment).toEqual([]);
    });

    it('returns empty arrays when the llm_model_calls table is missing', () => {
      db.exec('DROP TABLE llm_model_calls');
      const totals = ledgerTotals(db, '2000-01-01T00:00:00.000Z');
      expect(totals.by_purpose).toEqual([]);
      expect(totals.by_experiment).toEqual([]);
    });
  });
});