import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillDistillationService } from '../services/skill-distillation-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let tempDir: string;
let skillsDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  try { db.exec('ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5'); } catch { /* ok */ }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g40-'));
  skillsDir = path.join(tempDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertGoal(id: string, objective: string) {
  db.prepare(`INSERT INTO goals (id, objective, status, risk_class, created_at, updated_at) VALUES (?, ?, 'completed', 'low', datetime('now'), datetime('now'))`).run(id, objective);
}

function insertLoopRun(id: string, goalId: string) {
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES (?, ?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', datetime('now'), datetime('now'))`).run(id, goalId);
}

function insertMakerLease(loopRunId: string) {
  const meta = JSON.stringify({ assignment_path: '/tmp/test.md', stdout_path: '/tmp/stdout.log' });
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'codex', 'completed', ?, datetime('now'), datetime('now'))`).run('lease-' + Math.random().toString(36).slice(2, 10), loopRunId, meta);
}

describe('G40: Skill Distillation', () => {
  it('returns null for non-existent run', async () => {
    const svc = new SkillDistillationService(db, skillsDir);
    const result = await svc.distillFromRun('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when no completed maker leases', async () => {
    insertGoal('goal-1', 'Fix auth');
    insertLoopRun('run-1', 'goal-1');
    const svc = new SkillDistillationService(db, skillsDir);
    const result = await svc.distillFromRun('run-1');
    expect(result).toBeNull();
  });

  it('distills a skill from successful run', async () => {
    insertGoal('goal-2', 'Fix TypeScript null guards');
    insertLoopRun('run-2', 'goal-2');
    insertMakerLease('run-2');
    const svc = new SkillDistillationService(db, skillsDir);
    const result = await svc.distillFromRun('run-2');
    expect(result).toBeDefined();
    expect(result!.status).toBe('candidate');
    expect(result!.skillId).toContain('skill-distilled-');
    expect(result!.okfPath).toContain('distilled-');
  });

  it('writes skill file to OKF skills directory', async () => {
    insertGoal('goal-3', 'Fix imports');
    insertLoopRun('run-3', 'goal-3');
    insertMakerLease('run-3');
    const svc = new SkillDistillationService(db, skillsDir);
    const result = await svc.distillFromRun('run-3');
    expect(result).toBeDefined();
    expect(fs.existsSync(result!.okfPath)).toBe(true);
    const content = fs.readFileSync(result!.okfPath, 'utf8');
    expect(content).toContain('capability_id');
    expect(content).toContain('procedure');
  });

  it('creates capability candidate in DB', async () => {
    insertGoal('goal-4', 'Fix exports');
    insertLoopRun('run-4', 'goal-4');
    insertMakerLease('run-4');
    const svc = new SkillDistillationService(db, skillsDir);
    const result = await svc.distillFromRun('run-4');
    expect(result).toBeDefined();
    const cap = db.prepare('SELECT * FROM swarm_capabilities WHERE id = ?').get(result!.skillId) as any;
    expect(cap).toBeDefined();
    expect(cap.status).toBe('candidate');
    expect(cap.kind).toBe('skill');
  });
});
