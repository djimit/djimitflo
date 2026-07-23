import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { LoopEventService } from '../services/loop-event-service';

describe('LoopEventService', () => {
  let db: Database;
  let service: LoopEventService;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        loop_name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'closed',
        status TEXT NOT NULL DEFAULT 'created',
        repository_path TEXT,
        state_file TEXT,
        findings_json TEXT NOT NULL DEFAULT '[]',
        plan_json TEXT NOT NULL DEFAULT '{}',
        gates_json TEXT NOT NULL DEFAULT '[]',
        next_actions_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS loop_events (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    service = new LoopEventService(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRun(id: string) {
    db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status) VALUES (?, ?, ?, ?)').run(id, 'test-loop', 'closed', 'running');
  }

  it('records an event', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'test_event', 'info', 'Test message', { key: 'value' });

    const events = service.listEvents('run-1');
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('test_event');
    expect(events[0].level).toBe('info');
    expect(events[0].message).toBe('Test message');
    expect(events[0].metadata).toEqual({ key: 'value' });
  });

  it('lists events for a run', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'event_1', 'info', 'First');
    service.recordEvent('run-1', 'event_2', 'info', 'Second');
    service.recordEvent('run-1', 'event_3', 'info', 'Third');

    const events = service.listEvents('run-1');
    expect(events).toHaveLength(3);
    const messages = events.map(e => e.message).sort();
    expect(messages).toContain('First');
    expect(messages).toContain('Second');
    expect(messages).toContain('Third');
  });

  it('queries events with filter', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'type_a', 'info', 'A1');
    service.recordEvent('run-1', 'type_a', 'warning', 'A2');
    service.recordEvent('run-1', 'type_b', 'info', 'B1');

    const filtered = service.queryEvents({ loop_run_id: 'run-1', event_type: 'type_a' });
    expect(filtered).toHaveLength(2);
  });

  it('queries events by level', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'event', 'info', 'Info');
    service.recordEvent('run-1', 'event', 'warning', 'Warning');
    service.recordEvent('run-1', 'event', 'error', 'Error');

    const warnings = service.queryEvents({ loop_run_id: 'run-1', level: 'warning' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe('warning');
  });

  it('aggregates events by type', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'type_a', 'info', 'A1');
    service.recordEvent('run-1', 'type_a', 'info', 'A2');
    service.recordEvent('run-1', 'type_b', 'info', 'B1');

    const agg = service.aggregateEvents('run-1');
    expect(agg).toHaveLength(2);

    const typeA = agg.find(a => a.event_type === 'type_a');
    expect(typeA?.count).toBe(2);

    const typeB = agg.find(a => a.event_type === 'type_b');
    expect(typeB?.count).toBe(1);
  });

  it('gets latest event', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'event', 'info', 'First');
    service.recordEvent('run-1', 'event', 'info', 'Second');

    const latest = service.getLatestEvent('run-1');
    expect(latest).not.toBeNull();
    expect(['First', 'Second']).toContain(latest!.message);
  });

  it('returns null for latest event when no events exist', () => {
    const latest = service.getLatestEvent('run-empty');
    expect(latest).toBeNull();
  });

  it('counts events', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'event', 'info', 'A');
    service.recordEvent('run-1', 'event', 'info', 'B');
    service.recordEvent('run-1', 'event', 'info', 'C');

    expect(service.countEvents('run-1')).toBe(3);
    expect(service.countEvents('run-empty')).toBe(0);
  });

  it('deletes events for a run', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'event', 'info', 'A');
    service.recordEvent('run-1', 'event', 'info', 'B');

    const deleted = service.deleteEvents('run-1');
    expect(deleted).toBe(2);
    expect(service.countEvents('run-1')).toBe(0);
  });

  it('respects limit and offset in queries', () => {
    seedRun('run-1');
    for (let i = 0; i < 10; i++) {
      service.recordEvent('run-1', 'event', 'info', `Event ${i}`);
    }

    const page1 = service.queryEvents({ loop_run_id: 'run-1', limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = service.queryEvents({ loop_run_id: 'run-1', limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
  });

  it('handles empty metadata', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'event', 'info', 'No metadata');

    const events = service.listEvents('run-1');
    expect(events[0].metadata).toEqual({});
  });

  it('filters by date range', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'event', 'info', 'Recent');

    const recent = service.queryEvents({
      loop_run_id: 'run-1',
      since: new Date(Date.now() - 60000).toISOString(),
    });
    expect(recent).toHaveLength(1);

    const future = service.queryEvents({
      loop_run_id: 'run-1',
      since: new Date(Date.now() + 60000).toISOString(),
    });
    expect(future).toHaveLength(0);
  });
});
