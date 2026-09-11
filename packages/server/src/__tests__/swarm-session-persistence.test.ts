import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SwarmOrchestrationService } from '../services/swarm-orchestration-service';

describe('swarm session durable planning state', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  it('restores list and exact progress after service recreation without enabling execution', () => {
    const first = new SwarmOrchestrationService(db);
    const session = first.createSession('Analyze and review disposable fixture', { priority: 2 });
    const before = first.getProgress(session.id);
    const restarted = new SwarmOrchestrationService(db);
    expect(restarted.listSessions()).toEqual(first.listSessions());
    expect(restarted.getProgress(session.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'planning', completed: 0, running: 0, agents: [] });
    expect(before.pending).toBe(session.subtasks.length);
    expect(() => restarted.executeSession(session.id)).toThrow('SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED');
    expect(restarted.getProgress(session.id)).toEqual(before);
  });

  it('reads current durable state rather than stale instance caches', () => {
    const first = new SwarmOrchestrationService(db);
    const second = new SwarmOrchestrationService(db);
    const session = first.createSession('Record fixture plan');
    expect(second.listSessions().map(item => item.id)).toContain(session.id);
    db.prepare('DELETE FROM swarm_sessions WHERE id = ?').run(session.id);
    expect(first.listSessions()).toEqual([]);
    expect(() => first.getProgress(session.id)).toThrow('SWARM_SESSION_NOT_FOUND');
    expect(() => first.executeSession(session.id)).toThrow('SWARM_SESSION_NOT_FOUND');
  });
});
