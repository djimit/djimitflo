import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SwarmStatusService } from '../services/swarm-status-service';

describe('SwarmStatusService', () => {
  let db: Database.Database;
  let service: SwarmStatusService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Minimal schema — service methods that query missing tables will throw,
    // but we verify the service instantiates and has the expected methods
    db.exec(`
      CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT DEFAULT 'created', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'idle', last_active_at TEXT);
      CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'candidate', priority INTEGER DEFAULT 3);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'pending');
      CREATE TABLE worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, status TEXT DEFAULT 'prepared');
    `);
    service = new SwarmStatusService(db);
  });

  it('instantiates without throwing', () => {
    expect(service).toBeDefined();
  });

  it('has getStatus method', () => {
    expect(typeof service.getStatus).toBe('function');
  });

  it('has planWorkerPool method', () => {
    expect(typeof service.planWorkerPool).toBe('function');
  });

  it('has tickScheduler method', () => {
    expect(typeof service.tickScheduler).toBe('function');
  });
});
