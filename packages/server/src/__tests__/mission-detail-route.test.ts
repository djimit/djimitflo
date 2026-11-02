/**
 * Mission detail (read-only): GET /swarms/intelligence/missions/:id/execution joins one mission to its goal, loop runs,
 * leases, tasks, decisions, tokens and provenance. It needs read:evidence, writes no row, and reports what is not
 * recorded as null — never 0, never an inferred blocker or next action.
 */
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
const asked: string[] = [];
// the caller holds only the permissions in the x-perms header; every check is recorded
const auth = { requirePermission: (permission: string) => (req: any, res: any, next: any) => {
  asked.push(permission);
  return String(req.headers['x-perms'] ?? '').split(',').includes(permission) ? next() : res.status(403).json({ error: 'forbidden' });
} };
const app = () => express().use('/swarms', createSwarmRoutes(db, auth as any)).use(errorHandler);
const get = (path: string, perms = 'read:evidence') => request(app()).get(path).set('x-perms', perms);
const TABLES = ['swarm_missions', 'swarm_tasks', 'swarm_decisions', 'goals', 'loop_runs', 'worker_leases', 'loop_learning_closures', 'judgments', 'self_improvements'];
const snapshot = () => JSON.stringify(TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

function seed() {
  db.prepare("INSERT INTO goals (id, objective, risk_class, status) VALUES ('g1', 'Fix doc drift', 'low', 'running')").run();
  db.prepare("INSERT INTO swarm_missions (id, goal_id, title, risk_class, status, created_at) VALUES ('m1', 'g1', 'Docs agree with code', 'low', 'observed', '2026-10-20T00:00:00Z')").run();
  db.prepare("INSERT INTO swarm_missions (id, goal_id, title, risk_class, status, created_at) VALUES ('m-bare', NULL, 'No goal yet', 'low', 'observed', '2026-10-19T00:00:00Z')").run();
  const run = db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, next_actions_json, created_at, updated_at) VALUES (?, 'g1', 'doc-drift-and-small-fix-loop', 'closed', ?, ?, '[]', ?, ?)");
  run.run('run-1', 'completed', '[]', '2026-10-20T01:00:00Z', '2026-10-20T01:30:00Z');
  run.run('run-2', 'blocked', JSON.stringify([{ name: 'tests_lint_typecheck', status: 'fail' }, { name: 'objective_scope', status: 'pass' }]), '2026-10-20T02:00:00Z', '2026-10-20T02:30:00Z');
  const lease = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, 'codex', 'completed', ?, ?, ?)");
  lease.run('mk-1', 'run-1', 'maker', JSON.stringify({ runtime_usage: { total_tokens: 1200 } }), '2026-10-20T01:01:00Z', '2026-10-20T01:01:00Z');
  lease.run('ck-1', 'run-1', 'checker', JSON.stringify({ verdict: 'accepted', maker_lease_id: 'mk-1' }), '2026-10-20T01:02:00Z', '2026-10-20T01:02:00Z');
  lease.run('mk-2', 'run-2', 'maker', JSON.stringify({}), '2026-10-20T02:01:00Z', '2026-10-20T02:01:00Z');
  db.prepare("INSERT INTO loop_learning_closures (loop_run_id, eval_run_id, reflection_id, memory_candidate_id, score_delta) VALUES ('run-1', 'eval-1', 'r', 'mem', 0.1)").run();
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('j1', 'outcome_attribution', 'loop_run', 'run-1', 'h', 'annotation', 'verified', 'all gates passed', '2026-10-20T01:40:00Z')").run();
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  asked.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe('GET /swarms/intelligence/missions/:id/execution', () => {
  it('requires read:evidence (the list endpoint permission) and refuses without it', async () => {
    seed();
    const denied = await get('/swarms/intelligence/missions/m1/execution', 'write:swarm_action');
    expect(denied.status).toBe(403);
    expect(asked).toContain('read:evidence');
    expect(asked).not.toContain('write:swarm_action');
  });

  it('joins one mission to its runs, closures, attribution, leases and tokens without writing a row', async () => {
    seed();
    const before = snapshot();
    const res = await get('/swarms/intelligence/missions/m1/execution');
    expect(res.status).toBe(200);
    expect(res.body.mission).toMatchObject({ id: 'm1', title: 'Docs agree with code', planning_status: 'observed' });
    expect(res.body.goal).toMatchObject({ id: 'g1', status: 'running' });
    // the same row the list join returns
    expect(res.body.execution).toMatchObject({ lineage: 'linked', goal_status: 'running', execution: { loop_runs: 2, latest_run: { id: 'run-2', status: 'blocked' }, closed_runs: 1 } });
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(['run-2', 'run-1']);
    const [run2, run1] = res.body.runs;
    expect(run1).toMatchObject({ closure: { eval_run_id: 'eval-1' }, attribution: { outcome: 'verified', judgment_id: 'j1' } });
    expect(run2).toMatchObject({ failed_gates: ['tests_lint_typecheck'], closure: null, attribution: null });
    // the blocker is read from the gates of the blocked latest run, with its source
    expect(res.body.blocker).toEqual({ text: 'failed gates: tests_lint_typecheck', source: 'loop_runs.gates_json#run-2' });
    // no next action recorded on the latest run: null, not invented
    expect(res.body.next_action).toBeNull();
    expect(res.body.leases.find((l: { id: string }) => l.id === 'ck-1')).toMatchObject({ role: 'checker', verdict: 'accepted', maker_lease_id: 'mk-1' });
    // three lease usage events, one reported: partial coverage, not a total over unknowns
    expect(res.body.tokens).toMatchObject({ value: 1200, events: 3, known: 1, coverage: 0.333, status: 'partial' });
    expect(snapshot()).toBe(before);
  });

  it('a mission without a goal has no runs and unknown tokens (null, not 0)', async () => {
    seed();
    const res = await get('/swarms/intelligence/missions/m-bare/execution');
    expect(res.status).toBe(200);
    expect(res.body.execution).toMatchObject({ lineage: 'no_goal', execution: null });
    expect(res.body).toMatchObject({ goal: null, runs: [], leases: [], tokens: null, blocker: null, next_action: null, provenance: [] });
  });

  it('prefers the newest decision blocked reasons and reports the recorded next action', async () => {
    seed();
    db.prepare("UPDATE loop_runs SET next_actions_json = ? WHERE id = 'run-2'").run(JSON.stringify(['Fix the failing lint rule']));
    db.prepare("INSERT INTO swarm_decisions (id, mission_id, decision_type, decision, blocked_reasons_json, created_at) VALUES ('d1', 'm1', 'gate', 'hold', ?, '2026-10-20T03:00:00Z')").run(JSON.stringify(['awaiting operator review']));
    const res = await get('/swarms/intelligence/missions/m1/execution');
    expect(res.body.blocker).toEqual({ text: 'awaiting operator review', source: 'swarm_decisions.blocked_reasons_json#d1' });
    expect(res.body.next_action).toEqual({ items: ['Fix the failing lint rule'], source: 'loop_runs.next_actions_json#run-2' });
  });

  it('returns only provenance edges that touch the mission runs (plus the edges into the proposal they experimented)', async () => {
    seed();
    const proposal = db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, evidence_refs_json, created_at) VALUES (?, 'fix', ?, 'd', 'r', 'discovery', ?, '2026-10-19T00:00:00Z')");
    proposal.run('p1', 'Mission proposal', JSON.stringify(['expert_unit:u1']));
    proposal.run('p-other', 'Unrelated', JSON.stringify(['expert_unit:u2']));
    db.prepare("UPDATE goals SET improvement_id = 'p1' WHERE id = 'g1'").run();
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('g-other', 'x', 'low', 'running', 'p-other')").run();
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('run-x', 'g-other', 'l', 'closed', 'completed', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z')").run();
    const res = await get('/swarms/intelligence/missions/m1/execution');
    const edges = res.body.provenance.map((e: { edge_type: string; source: { id: string }; target: { id: string } }) => `${e.edge_type}:${e.source.id}->${e.target.id}`).sort();
    expect(edges).toEqual(['cites_knowledge:u1->p1', 'experimented_as:p1->run-1', 'experimented_as:p1->run-2', 'made_by_lease:run-1->mk-1', 'made_by_lease:run-2->mk-2']);
  });

  it('answers 404 for an unknown mission', async () => {
    const res = await get('/swarms/intelligence/missions/nope/execution');
    expect(res.status).toBe(404);
  });
});
