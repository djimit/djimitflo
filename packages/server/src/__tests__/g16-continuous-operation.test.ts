import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { LoopDaemon } from '../services/loop-daemon';
import { swarmEventBus } from '../services/swarm-event-bus';

let db: Database.Database;
let loops: LoopService;
let daemon: LoopDaemon;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g16-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g16-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G16 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
  daemon = new LoopDaemon(db, loops, { pollMs: 100 });
});

afterEach(() => {
  daemon.stop();
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  swarmEventBus.removeAllListeners();
});

function insertGoal(id: string, objective: string, riskClass: string, status: string = 'created') {
  const goal = loops.createGoal({
    objective,
    acceptance_criteria: [{ metric: 'test_passes', target: 'all' }],
    risk_class: riskClass as any,
  });
  // Update the status if needed.
  if (status !== 'created') {
    db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, goal.id);
  }
  return goal.id;
}

describe('G16: Continuous operation mode', () => {
  it('loads pending goals sorted by risk priority', () => {
    const goalLowId = insertGoal('goal-low', 'Low priority goal', 'low');
    const goalHighId = insertGoal('goal-high', 'High priority goal', 'high');
    const goalCriticalId = insertGoal('goal-critical', 'Critical goal', 'critical');

    // Access the private loadQueue method.
    const queue = (daemon as any).loadQueue();
    expect(queue.length).toBe(3);
    expect(queue[0].id).toBe(goalCriticalId);
    expect(queue[1].id).toBe(goalHighId);
    expect(queue[2].id).toBe(goalLowId);
  });

  it('starts and stops the daemon', () => {
    expect(daemon.isRunning()).toBe(false);
    daemon.start();
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it('executes a goal from the queue (decompose + start loop)', async () => {
    const goal1Id = insertGoal('goal-1', 'Fix documentation drift', 'low');

    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    // Execute one tick directly.
    await (daemon as any).tick();

    // The daemon should have attempted to decompose and start the goal.
    // A convergence event should have been emitted (goal_started or goal_failed).
    const daemonEvent = events.find((e) => e.data?.daemon === 'goal_started' || e.data?.daemon === 'goal_failed');
    expect(daemonEvent).toBeDefined();
    expect(daemonEvent.data.goal_id).toBe(goal1Id);
  });

  it('does not process completed or failed goals', () => {
    const goalDoneId = insertGoal('goal-done', 'Completed goal', 'high', 'completed');
    const goalFailedId = insertGoal('goal-failed', 'Failed goal', 'high', 'failed');

    const queue = (daemon as any).loadQueue();
    expect(queue.length).toBe(0);
  });

  it('marks a goal as failed if execution throws', async () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    // Override loadQueue to return a non-existent goal — startDocDriftAndSmallFixLoop will throw.
    (daemon as any).loadQueue = () => [{
      id: 'goal-nonexistent',
      objective: 'Non-existent goal',
      risk_class: 'low',
      metadata: {},
      created_at: new Date().toISOString(),
    }];

    await (daemon as any).tick();

    // The daemon should emit a goal_failed event.
    const failEvent = events.find((e) => e.data?.daemon === 'goal_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent.data.goal_id).toBe('goal-nonexistent');
  });
});
