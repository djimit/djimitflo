import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContextIsolationService } from '../services/context-isolation-service';

describe('ContextIsolationService', () => {
  let db: Database.Database;
  let service: ContextIsolationService;
  let tempDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE spawn_trees (
        id TEXT PRIMARY KEY,
        depth_budget INTEGER DEFAULT 0,
        total_token_budget INTEGER DEFAULT 0,
        consumed_tokens INTEGER DEFAULT 0,
        total_wall_budget_ms INTEGER DEFAULT 0,
        consumed_wall_ms INTEGER DEFAULT 0,
        max_concurrent_children INTEGER DEFAULT 4,
        risk_class TEXT DEFAULT 'medium',
        context_budget INTEGER DEFAULT 0,
        context_consumed INTEGER DEFAULT 0,
        status TEXT DEFAULT 'open',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    tempDir = mkdtempSync(join(tmpdir(), 'ctx-iso-'));
    service = new ContextIsolationService(db, tempDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 0 budget when no isolation configured', () => {
    expect(service.getContextBudget('tree-1')).toBe(0);
    expect(service.hasIsolation('tree-1')).toBe(false);
  });

  it('hasIsolation returns true when budget is set', () => {
    db.prepare(`INSERT INTO spawn_trees (id, context_budget, context_consumed, status, started_at, updated_at) VALUES ('tree-1', 1000, 0, 'open', datetime('now'), datetime('now'))`).run();
    expect(service.hasIsolation('tree-1')).toBe(true);
    expect(service.getContextBudget('tree-1')).toBe(1000);
  });

  it('appendMessage tracks consumed tokens', () => {
    db.prepare(`INSERT INTO spawn_trees (id, context_budget, context_consumed, status, started_at, updated_at) VALUES ('tree-1', 1000, 0, 'open', datetime('now'), datetime('now'))`).run();
    const result = service.appendMessage('tree-1', 'lease-1', {
      role: 'user',
      content: 'Hello world',
      timestamp: new Date().toISOString(),
    });
    expect(result.withinBudget).toBe(true);
    expect(result.summarized).toBe(false);
    expect(service.getContextConsumed('tree-1')).toBeGreaterThan(0);
  });

  it('triggers summarization when budget exceeded', () => {
    db.prepare(`INSERT INTO spawn_trees (id, context_budget, context_consumed, status, started_at, updated_at) VALUES ('tree-1', 10, 0, 'open', datetime('now'), datetime('now'))`).run();
    const result = service.appendMessage('tree-1', 'lease-1', {
      role: 'user',
      content: 'This is a very long message that should exceed the tiny budget of 10 tokens',
      timestamp: new Date().toISOString(),
    });
    expect(result.withinBudget).toBe(false);
    expect(result.summarized).toBe(true);
  });

  it('no isolation when budget is 0 (backward-compatible)', () => {
    db.prepare(`INSERT INTO spawn_trees (id, context_budget, context_consumed, status, started_at, updated_at) VALUES ('tree-1', 0, 0, 'open', datetime('now'), datetime('now'))`).run();
    const result = service.appendMessage('tree-1', 'lease-1', {
      role: 'user',
      content: 'Any message',
      timestamp: new Date().toISOString(),
    });
    expect(result.withinBudget).toBe(true);
    expect(result.summarized).toBe(false);
  });

  it('getStatus returns correct utilization', () => {
    db.prepare(`INSERT INTO spawn_trees (id, context_budget, context_consumed, status, started_at, updated_at) VALUES ('tree-1', 1000, 500, 'open', datetime('now'), datetime('now'))`).run();
    const status = service.getStatus('tree-1');
    expect(status.budget).toBe(1000);
    expect(status.consumed).toBe(500);
    expect(status.utilization).toBe(0.5);
    expect(status.isolated).toBe(true);
  });
});
