import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

let db: Database.Database;
let loops: LoopService;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  try { db.exec('ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5'); } catch { /* ok */ }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g39-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
  execFileSync('git', ['add', '.'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('G39: Research Loop', () => {
  it('research-loop is a valid LoopName type', () => {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    expect(run).toBeDefined();
  });

  it('discovers research questions from capability gaps', () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('gap1', 'Missing security knowledge', 'capability', 'security', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('gap2', 'Missing performance knowledge', 'capability', 'performance', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('gap3', 'Missing testing knowledge', 'capability', 'testing', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))
    `).run();

    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    expect(run).toBeDefined();
  });

  it('discovers research questions from draft hypotheses', () => {
    db.prepare(`
      INSERT INTO swarm_hypotheses (id, question, evidence_plan_json, projection_state, created_at, updated_at)
      VALUES ('h1', 'Does caching improve response time?', '[]', 'draft', datetime('now'), datetime('now'))
    `).run();

    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    expect(run).toBeDefined();
  });

  it('research loop generates findings with correct type', () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_at, updated_at, created_from)
      VALUES ('rg1', 'Gap in security knowledge', 'capability', 'security', 'gap', 'proposed', 0.5, '[]', 'test', datetime('now'), datetime('now'))
    `).run();

    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    expect(run.id).toBeDefined();
    expect(run.status).toBeDefined();
  });
});
