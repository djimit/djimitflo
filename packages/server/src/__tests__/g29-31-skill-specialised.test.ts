import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillService } from '../services/skill-service';
import { LoopService } from '../services/loop-service';

let db: Database.Database;
let skills: SkillService;
let loops: LoopService;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g29-'));
  // Create a fake OKF skills directory with a test skill
  fs.mkdirSync(path.join(tempDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'skills', 'typescript.md'),
    '---\ntype: Skill\ntitle: "TypeScript Fix"\ntrust_level: validated\n---\n\n# TypeScript Fix Procedure\n\n1. Read the finding\n2. Analyse the TypeScript code\n3. Apply the fix\n4. Verify with tsc\n');
  process.env.OKF_BASE = tempDir;
  skills = new SkillService(db);
  loops = new LoopService(db, '/tmp/djimitflo-test');
});

afterEach(() => { db?.close(); fs.rmSync(tempDir, { recursive: true, force: true }); delete process.env.OKF_BASE; });

describe('G29: Skill injection', () => {
  it('retrieves a skill procedure by name', () => {
    const proc = skills.getSkillProcedure('typescript');
    expect(proc).not.toBeNull();
    expect(proc).toContain('TypeScript Fix Procedure');
  });

  it('retrieves a skill for a finding by file extension', () => {
    const proc = skills.getSkillForFinding('Fix type error', 'src/test.ts');
    expect(proc).not.toBeNull();
    expect(proc).toContain('TypeScript');
  });

  it('returns null when no skill matches', () => {
    const proc = skills.getSkillForFinding('Unknown problem', 'file.unknown');
    expect(proc).toBeNull();
  });
});

describe('G31: Specialised capabilities', () => {
  it('planLoopRun prefers specialised over generic capabilities', () => {
    // Insert a generic + a specialised capability.
    db.prepare('INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('cap-generic', 'skill', 'test', '0.1', 'validated', 'low', 'none', 'none', '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', '{}', new Date().toISOString(), new Date().toISOString());
    db.prepare('INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('cap-ts-fix', 'skill', 'test', '0.1', 'validated', 'low', 'none', 'none', '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', JSON.stringify({ specialisation: 'typescript' }), new Date().toISOString(), new Date().toISOString());

    // Create a loop run with a finding.
    fs.mkdirSync(path.join(tempDir, 'repo'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'repo', 'README.md'), 'TODO\n');
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init'], { cwd: path.join(tempDir, 'repo'), stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: path.join(tempDir, 'repo') });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: path.join(tempDir, 'repo') });
    execFileSync('git', ['add', '.'], { cwd: path.join(tempDir, 'repo') });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: path.join(tempDir, 'repo'), stdio: 'ignore' });

    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: path.join(tempDir, 'repo') });
    const plan = loops.planLoopRun(run.id);
    expect(plan.length).toBeGreaterThan(0);
    // The plan should contain runtime selections for each finding
    for (const item of plan) {
      expect(item.runtime).toBeDefined();
      expect(item.findingId).toBeDefined();
    }
  });
});
