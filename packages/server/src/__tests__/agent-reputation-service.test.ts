import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentReputationService } from '../services/agent-reputation-service';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentLureService } from '../services/agent-lure-service';

// Built against the real schema.ts + migrate.ts rather than the shared
// createTestDb() test helper: that helper's agents table has drifted from
// production (capabilities_json instead of capabilities, and — the reason
// it can't be used here — no total_tasks/completed_tasks/failed_tasks
// columns at all). Same drift already flagged in
// loop-worker-task-agent-assignment.test.ts earlier this session.
describe('AgentReputationService', () => {
  let db: Database.Database;
  let service: AgentReputationService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    // social_lures/social_lure_probes are created by AgentLureService's own
    // constructor, not by schema.ts/migrate.ts — construct it once so those
    // tables exist, matching how routes/swarm-orchestration.ts wires it.
    new AgentLureService(db, new AgentCommunicationService(db));
    service = new AgentReputationService(db);
  });

  afterEach(() => { db?.close(); });

  function insertAgent(id: string, overrides: Partial<{ total_tasks: number; completed_tasks: number; failed_tasks: number; metadata: string }> = {}) {
    db.prepare(`
      INSERT INTO agents (id, name, description, status, capabilities, total_tasks, completed_tasks, failed_tasks, metadata, created_at, updated_at)
      VALUES (?, ?, '', 'active', '[]', ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, id, overrides.total_tasks ?? 0, overrides.completed_tasks ?? 0, overrides.failed_tasks ?? 0, overrides.metadata ?? '{}');
  }

  it('returns a neutral 0.5 score for an agent with no task history and no probes', () => {
    insertAgent('a1');
    const reputation = service.computeReputation('a1');
    expect(reputation.score).toBe(0.5);
    expect(reputation.task_completion_rate).toBeNull();
    expect(reputation.probe_count).toBe(0);
    expect(reputation.bite_count).toBe(0);
    expect(reputation.sample_size).toBe(0);
  });

  it('scores higher for a high task completion rate', () => {
    insertAgent('a2', { total_tasks: 10, completed_tasks: 10, failed_tasks: 0 });
    const reputation = service.computeReputation('a2');
    expect(reputation.task_completion_rate).toBe(1);
    expect(reputation.score).toBeGreaterThan(0.5);
    expect(reputation.score).toBeLessThanOrEqual(1);
  });

  it('scores lower for a high failure rate', () => {
    insertAgent('a3', { total_tasks: 10, completed_tasks: 0, failed_tasks: 10 });
    const reputation = service.computeReputation('a3');
    expect(reputation.score).toBeLessThan(0.5);
    expect(reputation.score).toBeGreaterThanOrEqual(0);
  });

  it('decreases the score as probe count rises beyond the free threshold', () => {
    insertAgent('a4');
    for (let i = 0; i < 5; i += 1) {
      db.prepare("INSERT INTO social_lure_probes (id, agent_id, ip, reason, created_at) VALUES (?, 'a4', '10.0.0.1', 'bad_token', datetime('now'))").run(`probe-${i}`);
    }
    const reputation = service.computeReputation('a4');
    expect(reputation.probe_count).toBe(5);
    expect(reputation.score).toBeLessThan(0.5);
  });

  it('counts a bite when the agent heartbeat falls inside a lure it was invited to', () => {
    const now = new Date();
    const created = new Date(now.getTime() - 60_000).toISOString();
    const expires = new Date(now.getTime() + 60_000).toISOString();
    insertAgent('a5', { metadata: JSON.stringify({ social_runtime: { last_heartbeat_at: now.toISOString() } }) });
    db.prepare("INSERT INTO social_lures (id, topic, topic_ref, created_by, created_at, expires_at, invited_json) VALUES ('lure-1', 't', 'ref', 'operator', ?, ?, ?)")
      .run(created, expires, JSON.stringify(['a5']));
    const reputation = service.computeReputation('a5');
    expect(reputation.bite_count).toBe(1);
    expect(reputation.sample_size).toBe(1);
  });

  it('always clamps the score to [0, 1] even with extreme inputs', () => {
    insertAgent('a6', { total_tasks: 100, completed_tasks: 100, failed_tasks: 0 });
    expect(service.computeReputation('a6').score).toBeLessThanOrEqual(1);
    insertAgent('a7', { total_tasks: 100, completed_tasks: 0, failed_tasks: 100 });
    for (let i = 0; i < 50; i += 1) {
      db.prepare("INSERT INTO social_lure_probes (id, agent_id, ip, reason, created_at) VALUES (?, 'a7', '10.0.0.1', 'bad_token', datetime('now'))").run(`probe-a7-${i}`);
    }
    expect(service.computeReputation('a7').score).toBeGreaterThanOrEqual(0);
  });

  it('throws AGENT_REPUTATION_AGENT_NOT_FOUND for an unknown agent id', () => {
    expect(() => service.computeReputation('does-not-exist')).toThrow('AGENT_REPUTATION_AGENT_NOT_FOUND');
  });
});
