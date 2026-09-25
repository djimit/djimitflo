import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { NeedsGroundingTriageService } from '../services/needs-grounding-triage-service';

let db: Database.Database;
const si = (id: string, status = 'needs_grounding') => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
  VALUES (?, 'feature', 't', 'd', 'r', 'reflection', ?, 0.5, datetime('now'), datetime('now'))`).run(id, status);
const triage = (id: string, subject: string, reason: string, at = '2026-09-24T01:00:00Z') => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
  VALUES (?, 'reflection_triage', 'self_improvement', ?, 'h', 'shadow', 'x', ?, ?)`).run(id, subject, reason, at);
const status = (id: string) => (db.prepare('SELECT status FROM self_improvements WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

it('routes djimitflo changes to refinement, archives confident other-system/aspiration, leaves the rest', () => {
  si('change'); triage('j1', 'change', 'jev=djimitflo_change conf=0.72');
  si('elsewhere'); triage('j2', 'elsewhere', 'jev=other_system conf=0.92');
  si('vague'); triage('j3', 'vague', 'jev=aspiration conf=0.65');
  si('unjudged');
  si('done', 'verified'); triage('j4', 'done', 'jev=other_system conf=0.99');
  si('latest-wins'); triage('j5', 'latest-wins', 'jev=other_system conf=0.95', '2026-09-24T00:00:00Z'); triage('j6', 'latest-wins', 'jev=djimitflo_change conf=0.9');
  expect(new NeedsGroundingTriageService(db).run()).toEqual({ toRefinement: 2, archived: 1, skipped: 1 });
  expect([status('change'), status('elsewhere'), status('vague'), status('unjudged'), status('done'), status('latest-wins')])
    .toEqual(['needs_more_evidence', 'archived', 'needs_grounding', 'needs_grounding', 'verified', 'needs_more_evidence']);
});
