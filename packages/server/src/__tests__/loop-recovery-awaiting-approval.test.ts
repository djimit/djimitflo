import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopRecoveryService } from '../services/loop-recovery-service';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const run = (id: string, goalId: string) => db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, ?, 'x', 'closed', 'running')").run(id, goalId);
const goal = (id: string, status: string, metadata: object) => db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata) VALUES (?, 'o', 'low', ?, ?)").run(id, status, JSON.stringify(metadata));
const status = (id: string) => (db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(id) as { status: string }).status;

it('a restart interrupts orphaned runs but leaves a run whose goal waits for an approval alone', () => {
  goal('g-wait', 'blocked', { awaiting_approval: { approval_id: 'a', run_id: 'r-wait', lease_id: 'l' } }); run('r-wait', 'g-wait');
  goal('g-orphan', 'running', {}); run('r-orphan', 'g-orphan');
  expect(new LoopRecoveryService(db).recoverInterruptedRuns().interruptedRuns).toBe(1);
  expect(status('r-wait')).toBe('running'); expect(status('r-orphan')).toBe('interrupted');
});
