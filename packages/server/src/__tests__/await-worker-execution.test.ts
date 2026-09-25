import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

it('waits until the approved engine task is terminal before the result is read back', async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const loops = new LoopService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'await-')));
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES ('t1', 't', 'd', 'running', 'low', 'low', 'local', '[]', '{}', datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('l1', 'r', 'maker', 'opencode', 'prepared', ?)").run(JSON.stringify({ execution_task_id: 't1' }));
  setTimeout(() => db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 't1'").run(), 60);
  const started = Date.now();
  expect(await loops.awaitWorkerExecution('l1', 5_000, 20)).toBe('completed');
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  expect(await loops.awaitWorkerExecution('missing', 100, 20)).toBeNull();
  db.close();
});
