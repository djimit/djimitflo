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

  it('records event with large metadata without error', () => {
    seedRun('run-1');
    const large: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) large[`k${i}`] = '';
    large.kept = 'data';
    service.recordEvent('run-1', 'event', 'info', 'Big', large);

    const events = service.listEvents('run-1');
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('Big');
  });

  it('queries all events with an empty filter', () => {
    seedRun('run-1');
    seedRun('run-2');
    service.recordEvent('run-1', 'evt', 'info', 'A');
    service.recordEvent('run-2', 'evt', 'info', 'B');

    const all = service.queryEvents({});
    expect(all).toHaveLength(2);
  });

  it('filters by until date', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'evt', 'info', 'Past');

    const included = service.queryEvents({
      loop_run_id: 'run-1',
      until: new Date(Date.now() + 60000).toISOString(),
    });
    expect(included).toHaveLength(1);

    const excluded = service.queryEvents({
      loop_run_id: 'run-1',
      until: new Date(Date.now() - 60000).toISOString(),
    });
    expect(excluded).toHaveLength(0);
  });

  it('filters by loop_run_id excluding other runs', () => {
    seedRun('run-1');
    seedRun('run-2');
    service.recordEvent('run-1', 'evt', 'info', 'A');
    service.recordEvent('run-2', 'evt', 'info', 'B');

    const onlyRun1 = service.queryEvents({ loop_run_id: 'run-1' });
    expect(onlyRun1).toHaveLength(1);
    expect(onlyRun1[0].message).toBe('A');

    const onlyRun2 = service.queryEvents({ loop_run_id: 'run-2' });
    expect(onlyRun2).toHaveLength(1);
    expect(onlyRun2[0].message).toBe('B');
  });

  it('filters by event_type excluding other types', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'alpha', 'info', 'A1');
    service.recordEvent('run-1', 'beta', 'info', 'B1');
    service.recordEvent('run-1', 'beta', 'info', 'B2');

    const alpha = service.queryEvents({ loop_run_id: 'run-1', event_type: 'alpha' });
    expect(alpha).toHaveLength(1);
    expect(alpha[0].event_type).toBe('alpha');

    const beta = service.queryEvents({ loop_run_id: 'run-1', event_type: 'beta' });
    expect(beta).toHaveLength(2);
    expect(beta.every(e => e.event_type === 'beta')).toBe(true);
  });

  it('applies default limit of 100 when not specified', () => {
    seedRun('run-1');
    for (let i = 0; i < 110; i++) {
      service.recordEvent('run-1', 'evt', 'info', `E${i}`);
    }
    const defaultLimited = service.queryEvents({ loop_run_id: 'run-1' });
    expect(defaultLimited).toHaveLength(100);
  });

  it('returns changes count from deleteEvents', () => {
    seedRun('run-1');
    seedRun('run-2');
    service.recordEvent('run-1', 'evt', 'info', 'A');
    service.recordEvent('run-1', 'evt', 'info', 'B');
    service.recordEvent('run-2', 'evt', 'info', 'C');

    expect(service.deleteEvents('run-empty')).toBe(0);
    expect(service.deleteEvents('run-2')).toBe(1);
  });

  it('aggregates events ordered by count descending', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'rare', 'info', 'R');
    for (let i = 0; i < 5; i++) service.recordEvent('run-1', 'common', 'info', `C${i}`);
    for (let i = 0; i < 3; i++) service.recordEvent('run-1', 'medium', 'info', `M${i}`);

    const agg = service.aggregateEvents('run-1');
    expect(agg).toHaveLength(3);
    expect(agg[0].event_type).toBe('common');
    expect(agg[0].count).toBe(5);
    expect(agg[1].event_type).toBe('medium');
    expect(agg[1].count).toBe(3);
    expect(agg[2].event_type).toBe('rare');
    expect(agg[2].count).toBe(1);
    expect(typeof agg[0].last_occurred).toBe('string');
  });

  it('parses event with empty-string metadata as empty object', () => {
    seedRun('run-1');
    service.recordEvent('run-1', 'evt', 'info', 'Manual');
    db.prepare('UPDATE loop_events SET metadata = ? WHERE loop_run_id = ?').run('', 'run-1');

    const events = service.listEvents('run-1');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({});
  });

  it('gets latest event by explicit created_at ordering', () => {
    seedRun('run-1');
    db.prepare('INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('e1', 'run-1', 'evt', 'info', 'First', '{}', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('e2', 'run-1', 'evt', 'info', 'Second', '{}', '2026-01-02T00:00:00.000Z');
    db.prepare('INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('e3', 'run-1', 'evt', 'info', 'Third', '{}', '2026-01-03T00:00:00.000Z');

    const latest = service.getLatestEvent('run-1');
    expect(latest).not.toBeNull();
    expect(latest!.message).toBe('Third');
    expect(latest!.id).toBe('e3');
  });
});
