import { expect, it } from 'vitest';
import { AgentCommunicationService } from '../services/agent-communication-service';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { panelAttemptMetrics } from '../services/panel-attempt-metrics';

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

it('AC-03: mixed historical fixture mirroring the 24-10 audit — 24 grounded → 18 children → 0 goals, 10 technical failures apart', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const svc = new AgentCommunicationService(db);
  const at = '2026-09-26T10:00:00Z';
  const legacy = ['needs_evidence', 0, 'Model response could not be parsed as a structured review.'] as const;
  type Seat = readonly [string, number, string];
  const prop = (id: string, status: string, panel: string | null = null) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, panel_id, created_at, updated_at)
    VALUES (?, 'feature', ?, 'd', 'r', 'reflection', ?, 0.5, ?, ?, ?)`).run(id, id, status, panel, at, at);
  const msg = (parent: string) => db.prepare(`INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, status)
    VALUES (?, 'commons-muse', 'broadcast', 'knowledge', 'normal', ?, ?, 'delivered')`).run(`m-${parent}`, JSON.stringify({ action: 'social.learning', thread_id: `t-${parent}`, params: { improvement_id: parent } }), at);
  const ground = (parent: string, kid: string | null) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'commons_grounding', 'self_improvement', ?, 'h', 'enforce', 'yes', 'r', ?, ?)`).run(`g-${parent}`, parent, JSON.stringify(kid ? { refinement_id: kid } : {}), at);
  const child = (n: number, decision: string, seats: Seat[]) => {
    db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, panel_json, consensus_json, created_at) VALUES (?, 't', 'q', 'consensus_ready', 'medium', ?, ?, ?)`)
      .run(`panel-${n}`, JSON.stringify(seats.map((_, i) => ({ id: `s${i}` }))), JSON.stringify({ decision }), at);
    seats.forEach(([stance, confidence, finding], i) => db.prepare(`INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, findings_json, status, created_at)
      VALUES (?, ?, ?, 'T', ?, ?, ?, 'submitted', ?)`).run(`r-${n}-${i}`, `panel-${n}`, `s${i}`, stance, confidence, JSON.stringify([finding]), at));
    prop(`p${n}`, 'archived'); msg(`p${n}`); prop(`k${n}`, 'archived', `panel-${n}`); ground(`p${n}`, `k${n}`);
  };
  let n = 0;
  for (let i = 0; i < 10; i++) child(n++, 'needs_more_evidence', [legacy, legacy]); // 20 legacy fallback reviews
  const ne = ['needs_evidence', 0.6, 'no reproduction named'] as const;
  child(n++, 'needs_more_evidence', [ne, ne]); child(n++, 'needs_more_evidence', [ne, ne]); child(n++, 'needs_more_evidence', [ne, ['support', 0.7, 'plausible']]);
  for (let i = 0; i < 3; i++) child(n++, 'backlog', [['support', 0.7, 'ok'], ['support', 0.75, 'ok']]);
  for (let i = 0; i < 2; i++) child(n++, 'blocked', [['oppose', 0.8, 'wrong layer'], ['oppose', 0.7, 'risk']]);
  for (let i = 0; i < 6; i++) { prop(`q${i}`, 'archived'); msg(`q${i}`); ground(`q${i}`, null); } // grounded, no refinement (APPLY off)

  const stats = svc.commonsStats()!;
  expect(stats.proposals_grounded).toBe(24);
  expect(stats.children_attempted).toBe(18);
  expect(stats.child_outcomes).toMatchObject({
    grounded_proposals: 24, no_refinement: 6, children: 18, legacy_fallback_reviews: 20,
    outcomes: { technical_failure: 10, needs_evidence: 3, blocked: 2, backlog: 3, goal: 0, pending: 0 },
  });
  // the parent-level stops no longer call the 10 technical failures 'rejected'
  expect(stats.grounding_stops).toMatchObject({ no_refinement: 6, panel_failed: 10, panel_backlog: 3, rejected: 5, goal: 0 });
  // the same 20 rows are the legacy class of the #792 attempt metrics — never an attempt, never in a rate
  const attempts = panelAttemptMetrics(db, { days: 3650, now: Date.parse('2026-10-24T00:00:00Z') });
  expect(attempts.legacy.coerced_unparseable).toBe(20);
  expect(attempts.seat_attempts.totals.n_attempt).toBe(0);
  db.close();
});
