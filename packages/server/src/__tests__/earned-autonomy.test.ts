import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { earnedAutonomy } from '../services/earned-autonomy';

let db: Database.Database; let n = 0;
const NOW = Date.parse('2026-09-29T12:00:00Z');
const recent = new Date(NOW - 86_400_000).toISOString();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); n = 0; });
afterEach(() => db.close());
/** one approved/denied maker run in a lane with its outcome */
function approval(o: { lane: 'test-gap' | 'mutation'; status?: string; by?: string; outcome?: string; runtime?: string }) {
  n++;
  const refs = o.lane === 'mutation' ? '["mutation-gap:x"]' : '["test-gap:x"]';
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', ?, ?, ?, ?)`).run(`s${n}`, o.outcome ?? 'verified', refs, recent, recent);
  db.prepare(`INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 'o', 'low', 'completed')`).run(`g${n}`, `s${n}`);
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES (?, ?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(`r${n}`, `g${n}`, recent, recent);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', ?, 'completed', ?, ?, ?)`).run(`l${n}`, `r${n}`, o.runtime ?? 'opencode', JSON.stringify({ execution_task_id: `t${n}` }), recent, recent);
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, created_at) VALUES (?, ?, ?, 'high', 'high_risk_action', 'm', '{}', ?, ?)`).run(`a${n}`, `t${n}`, o.status ?? 'approved', o.by ?? 'dennis', recent);
}

it('a class earns autonomy after 20 human approvals with no denial and at most one regression', () => {
  for (let i = 0; i < 19; i++) approval({ lane: 'test-gap' });
  approval({ lane: 'test-gap', outcome: 'regressed' });
  approval({ lane: 'test-gap', by: 'autonomy:test-gap-rule-v1' }); // automated approvals do not count
  const [c] = earnedAutonomy(db, NOW);
  expect(c).toMatchObject({ cls: 'maker:test-gap:opencode', human_approved: 20, auto_approved: 1, verified: 20, regressed: 1, earned: true, why: 'earned' });
});

it('a denial, too few approvals or a second regression keep the class supervised, and says why', () => {
  for (let i = 0; i < 21; i++) approval({ lane: 'mutation', outcome: i < 2 ? 'regressed' : 'verified' });
  approval({ lane: 'mutation', status: 'denied' });
  approval({ lane: 'test-gap', runtime: 'remote' });
  const recs = Object.fromEntries(earnedAutonomy(db, NOW).map((c) => [c.cls, c]));
  expect(recs['maker:mutation:opencode']).toMatchObject({ earned: false, why: '1 denied / 0 expired; 2 regressions (max 1)' });
  expect(recs['maker:test-gap:remote']).toMatchObject({ earned: false, why: '19 more human approvals' });
});
