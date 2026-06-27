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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g11-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g11-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G11 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertCapability(id: string, status: string, metadata: Record<string, unknown>, costModel: Record<string, unknown> = {}) {
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

describe('G11: Runtime-adaptive selection', () => {
  it('routes all findings to pi when sovereign is true', () => {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir, sovereign: true });
    const plan = loops.planLoopRun(run.id);
    expect(plan.length).toBeGreaterThan(0);
    for (const item of plan) {
      expect(item.runtime).toBe('pi');
    }
  });

  it('routes to pi when PI_OFFLINE env is set', () => {
    process.env.PI_OFFLINE = '1';
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    const plan = loops.planLoopRun(run.id);
    expect(plan.length).toBeGreaterThan(0);
    for (const item of plan) {
      expect(item.runtime).toBe('pi');
    }
    delete process.env.PI_OFFLINE;
  });

  it('defaults to codex when no capability matches', () => {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    const plan = loops.planLoopRun(run.id);
    expect(plan.length).toBeGreaterThan(0);
    for (const item of plan) {
      expect(item.runtime).toBe('codex');
    }
  });

  it('routes to opencode when capability has low p50_tokens', () => {
    insertCapability('cap-light', 'validated', {
      competence: { success_rate: 0.5, p50_cost: 1000 },
      cost_model: { learned: true, p50_tokens: 1000 },
    }, { learned: true, p50_tokens: 1000 });

    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    const plan = loops.planLoopRun(run.id);
    expect(plan.length).toBeGreaterThan(0);
    for (const item of plan) {
      expect(item.runtime).toBe('opencode');
    }
  });

  it('routes to codex when capability has high success_rate', () => {
    insertCapability('cap-complex', 'validated', {
      competence: { success_rate: 0.9, p50_cost: 20000 },
      cost_model: { learned: true, p50_tokens: 20000 },
    }, { learned: true, p50_tokens: 20000 });

    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    const plan = loops.planLoopRun(run.id);
    expect(plan.length).toBeGreaterThan(0);
    for (const item of plan) {
      expect(item.runtime).toBe('codex');
    }
  });
});
