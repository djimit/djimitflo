import { expect, it } from 'vitest';
import { AgentCommunicationService } from '../services/agent-communication-service';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

it('C0: the Commons funnel is a status breakdown; "grounded" = distinct proposals with a valid grounding; lessons per thread; idle residents flagged', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const svc = new AgentCommunicationService(db); // creates agent_messages
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const msg = (id: string, from: string, payload: object, ts: string) => db.prepare(`INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, status)
    VALUES (?, ?, 'broadcast', 'knowledge', 'normal', ?, ?, 'delivered')`).run(id, from, JSON.stringify(payload), ts);
  const prop = (id: string, status: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
    VALUES (?, 'feature', ?, 'd', 'r', 'reflection', ?, 0.5, ?, ?)`).run(id, id, status, old, old);
  for (const [id, status] of [['p1', 'archived'], ['p2', 'needs_grounding'], ['p3', 'needs_more_evidence'], ['p4', 'needs_more_evidence']] as const) prop(id, status);
  // thread t1: two lesson messages (one lesson); thread t2: one lesson message; all within 7 days
  msg('l1', 'commons-muse', { action: 'social.learning', thread_id: 't1', params: { improvement_id: 'p1' } }, old);
  msg('l2', 'commons-muse', { action: 'social.learning', thread_id: 't1', params: { improvement_id: 'p2' } }, old);
  msg('l3', 'commons-scout', { action: 'social.learning', thread_id: 't2', params: { improvement_id: 'p3' } }, old);
  msg('l4', 'commons-scout', { action: 'social.learning', thread_id: 't2', params: { improvement_id: 'p4' } }, old);
  const judge = (id: string, subject: string, decision: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'commons_grounding', 'self_improvement', ?, 'h', 'shadow', ?, 'r', '{}', ?)`).run(id, subject, decision, old);
  judge('j1', 'p3', 'yes'); judge('j2', 'p3', 'yes'); judge('j3', 'p4', 'no');
  const stats = svc.commonsStats()!;
  expect(stats.proposals).toBe(4);
  expect(stats.proposals_by_status).toEqual({ archived: 1, needs_grounding: 1, needs_more_evidence: 2 });
  expect(stats.proposals_grounded).toBe(1); // old rule counted both needs_more_evidence proposals as "grounded"
  expect(stats.learnings_7d).toBe(4);
  expect(stats.lessons_7d).toBe(2);
  expect(stats.autopilot_idle).toBe(true);
  expect(stats.residents?.map((r) => r.agent).sort()).toEqual(['commons-muse', 'commons-scout']);
  msg('r1', 'commons-oracle', { action: 'social.response', thread_id: 't3' }, recent);
  expect(svc.commonsStats()!.autopilot_idle).toBe(false);
  db.close();
});
