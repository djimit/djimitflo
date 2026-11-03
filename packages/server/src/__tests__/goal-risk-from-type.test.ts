import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';

let db: Database.Database;
const now = new Date().toISOString();
const scheduled = (id: string, type: string, priority: number) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
  VALUES (?, ?, ?, 'd', 'r', 'gap_analysis', 'scheduled', ?, ?, ?)`).run(id, type, `t-${id}`, priority, now, now);
const risk = (id: string) => (db.prepare('SELECT risk_class FROM goals WHERE improvement_id = ?').get(id) as { risk_class: string }).risk_class;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

it('a goal’s risk comes from what the change is, not from its priority (prod 2026-09-25: verified lanes were demoted to no-ops)', () => {
  scheduled('hot-test', 'feature', 0.86); // a test-gap proposal the source bandit boosted
  scheduled('sec', 'security', 0.4);
  const gen = new AutonomousGoalGenerator(db);
  gen.generateImprovement('hot-test'); gen.generateImprovement('sec');
  expect(risk('hot-test')).toBe('low');  // still qualifies for objective mode
  expect(risk('sec')).toBe('high');
});
