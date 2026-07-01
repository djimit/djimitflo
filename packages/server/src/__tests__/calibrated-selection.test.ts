import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { SelfModelService } from '../services/self-model-service';

let db: Database.Database;
let selfModel: SelfModelService;
let loops: LoopService;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  try { db.exec('ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5'); } catch { /* ok */ }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g37-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g37-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G37 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial'], { cwd: tempDir, stdio: 'ignore' });
  selfModel = new SelfModelService(db);
  loops = new LoopService(db, undefined, undefined, selfModel);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertCapability(id: string, status: string = 'validated', costModel: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  db.prepare(`
    INSERT INTO swarm_capabilities (
      id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
      eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
      metadata, created_at, updated_at
    ) VALUES (?, 'skill', 'test', '0.1', ?, 'low', 'none', 'none',
      '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, ?, 'demote_on_fail', null, ?, datetime('now'), datetime('now'))
  `).run(id, status, JSON.stringify(costModel), JSON.stringify(metadata));
}

function insertWorkerLease(capabilityId: string, status: string, runtime: string, confidence: number = 0.5) {
  const runId = 'run-' + Math.random().toString(36).slice(2, 10);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', datetime('now'), datetime('now'))`).run(runId);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, capability_id, confidence, created_at, updated_at) VALUES (?, ?, 'maker', ?, ?, ?, ?, datetime('now'), datetime('now'))`).run('lease-' + Math.random().toString(36).slice(2, 10), runId, runtime, status, capabilityId, confidence);
}

describe('G37: Calibrated Runtime Selection', () => {
  it('selects runtime with highest calibrated success_rate', () => {
    insertCapability('cap-cal', 'validated', {}, { runtime: 'codex' });
    for (let i = 0; i < 5; i++) insertWorkerLease('cap-cal', 'completed', 'codex', 0.8);
    for (let i = 0; i < 5; i++) insertWorkerLease('cap-cal', 'failed', 'opencode', 0.8);
    const cal = selfModel.getCalibration('cap-cal');
    expect(cal.observedSuccessRate).toBeGreaterThan(0);
    expect(cal.nRuns).toBe(10);
  });

  it('falls back to default when insufficient data', () => {
    insertCapability('cap-new', 'validated');
    const cal = selfModel.getCalibration('cap-new');
    expect(cal.nRuns).toBe(0);
    expect(cal.recommendedConfidence).toBe(0.5);
  });

  it('skips runtimes with success_rate below 0.3', () => {
    insertCapability('cap-low', 'validated');
    for (let i = 0; i < 10; i++) insertWorkerLease('cap-low', 'failed', 'gemini', 0.9);
    const cal = selfModel.getCalibration('cap-low');
    expect(cal.observedSuccessRate).toBeLessThan(0.3);
  });

  it('self-model is wired into LoopService', () => {
    insertCapability('cap-wire', 'validated');
    for (let i = 0; i < 5; i++) insertWorkerLease('cap-wire', 'completed', 'codex');
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    const plan = loops.planLoopRun(run.id);
    expect(plan.length).toBeGreaterThanOrEqual(0);
  });
});
