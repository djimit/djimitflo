import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';

it('a requeued proposal whose previous goal failed gets a new goal instead of a UNIQUE crash (prod 2026-09-25)', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
    VALUES ('p1', 'feature', 'Raise the mutation score', 'd', 'r', 'gap_analysis', 'scheduled', 0.6, datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at)
    VALUES ('old', 'o', 'failed', 'low', '[]', '{}', 'p1', '{}', datetime('now'), datetime('now'))`).run();
  expect(() => new AutonomousGoalGenerator(db).generateFromSelfImprovements()).not.toThrow();
  const goals = db.prepare("SELECT id, status, improvement_id AS imp, json_extract(metadata, '$.requeued_improvement_id') AS rq FROM goals ORDER BY created_at, id").all() as Array<{ id: string; status: string; imp: string | null; rq: string | null }>;
  expect(goals.find((g) => g.id === 'old')).toMatchObject({ status: 'failed', imp: null, rq: 'p1' });
  expect(goals.filter((g) => g.imp === 'p1')).toHaveLength(1);
  expect(db.prepare("SELECT status FROM self_improvements WHERE id = 'p1'").get()).toEqual({ status: 'executing' });
  db.close();
});
