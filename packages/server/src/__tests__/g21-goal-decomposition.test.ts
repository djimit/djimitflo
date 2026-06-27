import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { GoalDecomposer } from '../services/goal-decomposer';
import { swarmEventBus } from '../services/swarm-event-bus';

let db: Database.Database;
let loops: LoopService;
let intelligence: SwarmIntelligenceService;
let decomposer: GoalDecomposer;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g21-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
  execFileSync('git', ['init'], {cwd: tempDir, stdio: 'ignore'});
  execFileSync('git', ['config', 'user.email', 'g21@test'], {cwd: tempDir});
  execFileSync('git', ['config', 'user.name', 'G21'], {cwd: tempDir});
  execFileSync('git', ['add', '.'], {cwd: tempDir});
  execFileSync('git', ['commit', '-m', 'init'], {cwd: tempDir, stdio: 'ignore'});
  loops = new LoopService(db, '/tmp/djimitflo-test');
  intelligence = new SwarmIntelligenceService(db);
  decomposer = new GoalDecomposer(db, loops, intelligence);
});

afterEach(() => { db?.close(); fs.rmSync(tempDir, {recursive: true, force: true}); swarmEventBus.removeAllListeners(); });

describe('G21: Goal decomposition into capability DAGs', () => {
  it('decomposes an API endpoint goal into a multi-step DAG', () => {
    const goal = loops.createGoal({
      objective: 'Add a new API endpoint with tests and documentation',
      acceptance_criteria: [{metric: 'test_passes', target: 'all'}],
      risk_class: 'low',
    });
    const dag = decomposer.decomposeGoalToDAG(goal.id);
    expect(dag.fallback).toBe(false);
    expect(dag.nodes.length).toBeGreaterThanOrEqual(3);
    const steps = dag.nodes.map(n => n.step);
    expect(steps).toContain('implement');
    expect(steps).toContain('test');
    expect(steps).toContain('document');
  });

  it('builds dependencies between steps', () => {
    const goal = loops.createGoal({
      objective: 'Implement a feature and test it',
      acceptance_criteria: [{metric: 'test_passes', target: 'all'}],
      risk_class: 'low',
    });
    const dag = decomposer.decomposeGoalToDAG(goal.id);
    expect(dag.nodes.length).toBeGreaterThanOrEqual(2);
    expect(dag.nodes[1].dependencies).toContain(dag.nodes[0].step);
  });

  it('falls back to predefined loops when no keywords match', () => {
    const goal = loops.createGoal({
      objective: 'Random unrelated text',
      acceptance_criteria: [{metric: 'test_passes', target: 'all'}],
      risk_class: 'low',
    });
    const dag = decomposer.decomposeGoalToDAG(goal.id);
    expect(dag.fallback).toBe(true);
    expect(dag.nodes.length).toBe(0);
  });

  it('emits a decomposition event on the SSE stream', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));
    const goal = loops.createGoal({
      objective: 'Implement and test a feature',
      acceptance_criteria: [{metric: 'test_passes', target: 'all'}],
      risk_class: 'low',
    });
    decomposer.decomposeGoalToDAG(goal.id);
    const decomposeEvent = events.find((e) => e.data?.decomposition === 'dag_created');
    expect(decomposeEvent).toBeDefined();
  });
});
