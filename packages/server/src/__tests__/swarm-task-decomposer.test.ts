import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';
import { SwarmTaskDecomposer } from '../services/swarm-task-decomposer';

describe('SwarmTaskDecomposer', () => {
  let db: DBType;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('decomposes a build+test goal into implementation and verification tasks', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build the feature and test it');

    expect(plan.goal).toBe('build the feature and test it');
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(plan.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const types = plan.tasks.map((t) => t.type);
    expect(types).toContain('implementation');
    expect(types).toContain('verification');
    expect(plan.tasks.length).toBeGreaterThanOrEqual(2);
  });

  it('detects documentation and integration components from goal keywords', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('document the API and integrate with the gateway');
    const types = plan.tasks.map((t) => t.type);
    expect(types).toContain('documentation');
    expect(types).toContain('integration');
  });

  it('falls back to analysis+implementation+verification when no keywords match', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('review the weather');
    const types = plan.tasks.map((t) => t.type);
    expect(types).toEqual(['analysis', 'implementation', 'verification']);
  });

  it('builds a linear dependency chain between tasks', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build and test');
    expect(plan.tasks[0].dependencies).toEqual([]);
    for (let i = 1; i < plan.tasks.length; i++) {
      expect(plan.tasks[i].dependencies).toContain(plan.tasks[i - 1].id);
    }
  });

  it('produces one stage per task for a linear dependency chain', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build and test');
    expect(plan.stages.length).toBe(plan.tasks.length);
    plan.stages.forEach((stage) => expect(stage.length).toBe(1));
    // Stages follow dependency order
    plan.stages.forEach((stage, idx) => expect(stage[0]).toBe(plan.tasks[idx].id));
  });

  it('respects maxParallelism by capping tasks per stage', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('review the weather', { maxParallelism: 1 });
    expect(plan.stages.length).toBe(plan.tasks.length);
    plan.stages.forEach((stage) => expect(stage.length).toBe(1));
  });

  it('assigns large effort to implementation and medium to others', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build and test');
    const impl = plan.tasks.find((t) => t.type === 'implementation');
    const verify = plan.tasks.find((t) => t.type === 'verification');
    expect(impl?.estimatedEffort).toBe('large');
    expect(verify?.estimatedEffort).toBe('medium');
  });

  it('estimates total time as sum of effort minutes (large=30, medium=15)', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build and test');
    const expected = plan.tasks.reduce(
      (sum, t) => sum + (t.estimatedEffort === 'large' ? 30 : t.estimatedEffort === 'medium' ? 15 : 5),
      0,
    );
    expect(plan.estimatedTotalMinutes).toBe(expected);
  });

  it('applies the provided priority to all tasks', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build and test', { priority: 5 });
    plan.tasks.forEach((t) => expect(t.priority).toBe(5));
  });

  it('persists the plan and retrieves it via getPlan', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build and test');
    const retrieved = decomposer.getPlan(plan.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(plan.id);
    expect(retrieved!.goal).toBe(plan.goal);
    expect(retrieved!.tasks.length).toBe(plan.tasks.length);
    expect(retrieved!.stages).toEqual(plan.stages);
    expect(retrieved!.estimatedTotalMinutes).toBe(plan.estimatedTotalMinutes);
  });

  it('returns null for an unknown plan id', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    expect(decomposer.getPlan('does-not-exist')).toBeNull();
  });

  it('listPlans returns persisted plans with truncated goal and task count', () => {
    const decomposer = new SwarmTaskDecomposer(db);
    decomposer.decompose('build and test');
    const longGoal = 'x'.repeat(120);
    decomposer.decompose(longGoal);
    const plans = decomposer.listPlans();
    expect(plans.length).toBe(2);
    // Most recent first
    expect(plans[0].goal.length).toBeLessThanOrEqual(80);
    expect(plans[0].taskCount).toBeGreaterThan(0);
    plans.forEach((p) => expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/));
  });

  it('ensureTables is idempotent and reuses an existing table', () => {
    new SwarmTaskDecomposer(db);
    const decomposer = new SwarmTaskDecomposer(db);
    const plan = decomposer.decompose('build and test');
    expect(plan.tasks.length).toBeGreaterThan(0);
  });

  it('migrates legacy subtasks_json column data into tasks_json', () => {
    db.exec(`
      CREATE TABLE execution_plans (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL,
        subtasks_json TEXT NOT NULL DEFAULT '[]', stages_json TEXT NOT NULL DEFAULT '[]',
        estimated_minutes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO execution_plans (id, goal, subtasks_json, stages_json, estimated_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('legacy-1', 'legacy goal', JSON.stringify([{ id: 't1', title: 'Legacy' }]), JSON.stringify([['t1']]), 10, '2026-01-01T00:00:00.000Z');

    const decomposer = new SwarmTaskDecomposer(db);
    const retrieved = decomposer.getPlan('legacy-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tasks.length).toBe(1);
    expect(retrieved!.tasks[0].title).toBe('Legacy');
  });
});