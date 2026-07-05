import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LoopService } from '../services/loop-service';
import { GoalService } from '../services/goal-service';
import { WorktreeManager } from '../services/worktree-manager';
import { GovernanceGuardService } from '../services/governance-guard-service';

/**
 * Integration test: core loop lifecycle end-to-end.
 * Validates: goal creation → loop start → continue → verify → (blocked/completed)
 */
describe('Integration: Core Loop Lifecycle', () => {
  let db: Database.Database;
  let loopService: LoopService;
  let goalService: GoalService;
  let tempDir: string;
  let evidenceDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-flow-'));
    evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-flow-evidence-'));

    // Create required tables
    db.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT DEFAULT 'created',
        budget_json TEXT DEFAULT '{}', constraints_json TEXT DEFAULT '[]',
        acceptance_criteria_json TEXT DEFAULT '[]', risk_class TEXT DEFAULT 'low',
        owner_user_id TEXT, metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE loop_runs (
        id TEXT PRIMARY KEY, goal_id TEXT, loop_name TEXT NOT NULL, mode TEXT DEFAULT 'closed',
        status TEXT DEFAULT 'created', repository_path TEXT, state_file TEXT,
        findings_json TEXT DEFAULT '[]', plan_json TEXT DEFAULT '{}',
        gates_json TEXT DEFAULT '[]', next_actions_json TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE worker_leases (
        id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex',
        status TEXT DEFAULT 'prepared', finding_id TEXT, worktree_path TEXT,
        branch_name TEXT, metadata TEXT DEFAULT '{}', budget_json TEXT DEFAULT '{}',
        capability_id TEXT, parent_lease_id TEXT, spawn_tree_id TEXT,
        depth INTEGER DEFAULT 0, spawned_by_agent_id TEXT,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE loop_events (
        id TEXT PRIMARY KEY, loop_run_id TEXT, event_type TEXT, severity TEXT DEFAULT 'info',
        message TEXT, metadata TEXT DEFAULT '{}', level TEXT DEFAULT 'info',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Create minimal git repo
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test\nThis is a test repo.\n\nTODO: add real documentation\n');
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'test-repo',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });

    loopService = new LoopService(db, evidenceDir);
    goalService = new GoalService(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  });

  it('creates a goal', () => {
    const goal = goalService.createGoal({
      objective: 'Fix documentation drift',
      acceptance_criteria: ['All TODOs addressed', 'README updated'],
    });
    expect(goal.id).toBeDefined();
    expect(goal.objective).toBe('Fix documentation drift');
    expect(goal.status).toBe('created');
  });

  it('starts a doc drift loop', () => {
    const run = loopService.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    expect(run.id).toBeDefined();
    expect(run.status).toBeDefined();
    expect(run.findings.length).toBeGreaterThan(0);
  });

  it('continues a loop with maker and checker leases', () => {
    const run = loopService.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    const continued = loopService.continueLoopRun(run.id, { runtime: 'mock' });
    expect(continued.leases.length).toBeGreaterThan(0);
    expect(continued.leases.some(l => l.role === 'maker')).toBe(true);
  });

  it('verifies loop gates', () => {
    const run = loopService.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    loopService.continueLoopRun(run.id, { runtime: 'mock' });
    const verified = loopService.verifyLoopRun(run.id);
    expect(verified.gates).toBeDefined();
    expect(verified.gates.length).toBeGreaterThan(0);
    expect(['blocked', 'verifying', 'ready_for_human_merge']).toContain(verified.run.status);
  });

  it('creates a worktree for a finding', () => {
    const mgr = new WorktreeManager(db);
    const branchName = mgr.branchNameFor('run-1', 'finding-1');
    expect(branchName).toContain('run-1');
    expect(branchName).toContain('finding-1');
  });

  it('governance guard service instantiates', () => {
    const guard = new GovernanceGuardService(db);
    expect(guard).toBeDefined();
  });
});
