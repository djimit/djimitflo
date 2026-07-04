import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SubAgentContextService } from '../services/sub-agent-context-service';

describe('SubAgentContextService', () => {
  let db: Database.Database;
  let service: SubAgentContextService;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sac-test-'));
    process.env.DJIMITFLO_SCRATCH_DIR = tempDir;

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE sub_agent_tool_outputs (
        id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, tool_name TEXT NOT NULL DEFAULT '',
        original_size INTEGER NOT NULL DEFAULT 0, file_path TEXT, summary TEXT NOT NULL DEFAULT '',
        offloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sub_agent_scratch (
        id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(lease_id, key)
      );
    `);

    service = new SubAgentContextService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DJIMITFLO_SCRATCH_DIR;
  });

  it('initializes a context window', () => {
    const window = service.initializeWindow('tree-1', 'lease-1', 5000);
    expect(window.leaseId).toBe('lease-1');
    expect(window.budget).toBe(5000);
    expect(window.status).toBe('active');
  });

  it('uses default budget when not specified', () => {
    const window = service.initializeWindow('tree-1', 'lease-1');
    expect(window.budget).toBeGreaterThan(0);
  });

  it('records messages within budget', () => {
    service.initializeWindow('tree-1', 'lease-1', 1000);
    expect(service.recordMessage('lease-1', 100)).toBe('ok');
    expect(service.recordMessage('lease-1', 200)).toBe('ok');
  });

  it('detects overflow when budget exceeded', () => {
    service.initializeWindow('tree-1', 'lease-1', 500);
    expect(service.recordMessage('lease-1', 400)).toBe('ok');
    expect(service.recordMessage('lease-1', 200)).toBe('overflow');
  });

  it('stores small tool outputs in memory', () => {
    service.initializeWindow('tree-1', 'lease-1');
    const result = service.handleToolOutput('lease-1', 'grep', 'small output');
    expect(result.stored).toBe('memory');
  });

  it('offloads large tool outputs to disk', () => {
    service.initializeWindow('tree-1', 'lease-1');
    const largeOutput = 'x'.repeat(3000);
    const result = service.handleToolOutput('lease-1', 'grep', largeOutput);
    expect(result.stored).toBe('disk');
    expect(result.summary).toBeDefined();
  });

  it('retrieves offloaded tool output', () => {
    service.initializeWindow('tree-1', 'lease-1');
    const largeOutput = 'x'.repeat(3000);
    const result = service.handleToolOutput('lease-1', 'grep', largeOutput);

    if (result.stored === 'disk') {
      const retrieved = service.retrieveToolOutput(result.reference);
      expect(retrieved).toBe(largeOutput);
    }
  });

  it('writes and reads scratch space', () => {
    service.writeScratch('lease-1', 'finding', 'Important finding about BSN');
    expect(service.readScratch('lease-1', 'finding')).toBe('Important finding about BSN');
  });

  it('updates existing scratch entries', () => {
    service.writeScratch('lease-1', 'status', 'in_progress');
    service.writeScratch('lease-1', 'status', 'completed');
    expect(service.readScratch('lease-1', 'status')).toBe('completed');
  });

  it('lists scratch entries', () => {
    service.writeScratch('lease-1', 'a', 'value-a');
    service.writeScratch('lease-1', 'b', 'value-b');
    const entries = service.listScratch('lease-1');
    expect(entries.length).toBe(2);
  });

  it('returns null for missing scratch key', () => {
    expect(service.readScratch('lease-1', 'nonexistent')).toBeNull();
  });

  it('gets window status', () => {
    service.initializeWindow('tree-1', 'lease-1', 5000);
    const status = service.getWindowStatus('lease-1');
    expect(status).toBeDefined();
    expect(status?.budget).toBe(5000);
  });

  it('summarizes context on overflow', () => {
    service.initializeWindow('tree-1', 'lease-1', 100);
    service.recordMessage('lease-1', 150); // overflow
    const summary = service.summarizeContext('lease-1');
    expect(summary).toContain('summarized');
  });

  it('closes window and cleans up', () => {
    service.initializeWindow('tree-1', 'lease-1', 5000);
    service.closeWindow('lease-1');
    expect(service.getWindowStatus('lease-1')).toBeNull();
  });

  it('provides stats', () => {
    service.initializeWindow('tree-1', 'lease-1', 5000);
    service.initializeWindow('tree-1', 'lease-2', 3000);
    const stats = service.getStats();
    expect(stats.activeWindows).toBe(2);
    expect(stats.totalBudget).toBe(8000);
  });
});
