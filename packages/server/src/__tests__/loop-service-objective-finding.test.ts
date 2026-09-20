import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { GoalService } from '../services/goal-service';

/**
 * Direct regression coverage for the production bug found 2026-09-20: every
 * self-improvement goal was dispatched to startDocDriftAndSmallFixLoop(), a
 * fixed scanner that never looks at the goal's objective — 10/10 executed
 * goals produced the byte-identical canned "no findings" result. This
 * covers the new objective-mode finding path (LoopService.startObjectiveLoop /
 * createObjectiveFinding) that lets a goal's own objective actually reach
 * the maker/checker machinery.
 */
describe('LoopService objective-mode findings', () => {
  let db: Database.Database;
  let loops: LoopService;
  let goals: GoalService;
  let tempDir: string;
  let evidenceRoot: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-finding-'));
    evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-finding-evidence-'));
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# fixture\n');
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });
    loops = new LoopService(db, evidenceRoot);
    goals = new GoalService(db);
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  });

  function seedImprovement(overrides: { type?: string; description?: string; rationale?: string } = {}) {
    const id = 'improvement-1';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'reflection', 'scheduled', 0.5, ?, ?)
    `).run(
      id,
      overrides.type ?? 'feature',
      'Define missing spec',
      overrides.description ?? 'Original proposal description.',
      overrides.rationale ?? 'Original proposal rationale.',
      now, now,
    );
    return id;
  }

  function seedGoal(overrides: { risk_class?: 'low' | 'medium' | 'high' | 'critical'; metadata?: Record<string, unknown>; objective?: string } = {}) {
    return goals.createGoal({
      objective: overrides.objective ?? 'Define the SIG endpoint specification',
      acceptance_criteria: ['Tests pass', 'No regressions'],
      constraints: ['Do not modify auth policy'],
      risk_class: overrides.risk_class ?? 'low',
      metadata: overrides.metadata ?? { source: 'self-improvement' },
    });
  }

  it('produces exactly one self_improvement_objective finding whose message is the goal objective', () => {
    const goal = seedGoal({ objective: 'Implement the missing retry backoff' });
    const run = loops.startObjectiveLoop({ goal_id: goal.id, repository_path: tempDir });
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].type).toBe('self_improvement_objective');
    expect(run.findings[0].message).toBe('Implement the missing retry backoff');
  });

  it('throws OBJECTIVE_MODE_REQUIRES_GOAL rather than silently falling back to discovery', () => {
    expect(() => loops.startLoop({ objective_mode: true, repository_path: tempDir }))
      .toThrow('objective_mode requires a valid goal_id');
  });

  it('enriches the finding evidence from the joined self_improvements row', () => {
    const improvementId = seedImprovement({ description: 'Replace the knowledge-gap heuristic.', rationale: 'Metric gaming risk.' });
    const goal = seedGoal({ metadata: { source: 'self-improvement', improvement_id: improvementId } });
    const run = loops.startObjectiveLoop({ goal_id: goal.id, repository_path: tempDir });
    expect(run.findings[0].evidence).toContain('Replace the knowledge-gap heuristic.');
    expect(run.findings[0].evidence).toContain('Metric gaming risk.');
    expect(run.findings[0].evidence).toContain('Constraints: Do not modify auth policy');
  });

  it('persists objective_mode: true on the run, distinguishing it from a doc-drift run', () => {
    const goal = seedGoal();
    const objectiveRun = loops.startObjectiveLoop({ goal_id: goal.id, repository_path: tempDir });
    expect(objectiveRun.metadata.objective_mode).toBe(true);

    const goal2 = seedGoal();
    const docDriftRun = loops.startDocDriftAndSmallFixLoop({ goal_id: goal2.id, repository_path: tempDir });
    expect(docDriftRun.metadata.objective_mode).toBe(false);
  });

  it('forces the security finding category and trips the existing high-risk gate for a security-typed proposal', () => {
    const improvementId = seedImprovement({ type: 'security' });
    const goal = seedGoal({ risk_class: 'low', metadata: { source: 'self-improvement', improvement_id: improvementId } });
    const run = loops.startObjectiveLoop({ goal_id: goal.id, repository_path: tempDir });
    expect(run.findings[0].metadata?.category).toBe('security');
    expect(loops.isHighRiskRun(run)).toBe(true);
  });

  it('reaches real gate verification driven by the objective, not the old canned no-op', () => {
    const goal = seedGoal({ objective: 'Add input validation to the export endpoint' });
    const run = loops.startObjectiveLoop({ goal_id: goal.id, repository_path: tempDir });
    // Unlike a doc-drift run with nothing to find, an objective-mode run always
    // has exactly one finding, so it never takes the "no_change_required" shortcut.
    expect(run.metadata.outcome).not.toBe('no_change_required');
    const continued = loops.continueLoopRun(run.id, { runtime: 'mock' });
    expect(continued.leases.some((lease) => lease.role === 'maker')).toBe(true);
    const verified = loops.verifyLoopRun(run.id);
    expect(verified.gates.length).toBeGreaterThan(0);
  });
});
