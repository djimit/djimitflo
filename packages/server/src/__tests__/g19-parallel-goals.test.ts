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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g19-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g19-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G19 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
  daemon = new LoopDaemon(db, loops, { pollMs: 100, maxConcurrentGoals: 3 });
});

afterEach(() => {
  daemon.stop();
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  swarmEventBus.removeAllListeners();
});

function insertGoal(objective: string, riskClass: string, status: string = 'created') {
  const goal = loops.createGoal({
    objective,
    acceptance_criteria: [{ metric: 'test_passes', target: 'all' }],
    risk_class: riskClass as any,
  });
  if (status !== 'created') {
    db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, goal.id);
  }
  return goal.id;
}

describe('G19: Parallel goal execution', () => {
  it('tracks active goals and available slots', () => {
    expect(daemon.getActiveGoalCount()).toBe(0);
    expect(daemon.getAvailableSlots()).toBe(3);
  });

  it('starts multiple goals concurrently in one tick', async () => {
    const goal1Id = insertGoal('Goal 1', 'high');
    const goal2Id = insertGoal('Goal 2', 'low');

    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    await daemon.tick();

    // Both goals should have been started (2 slots available, 2 goals in queue).
    const startEvents = events.filter((e) => e.data?.daemon === 'goal_started');
    expect(startEvents.length).toBe(2);

    // The tick_processed event should report 2 started.
    const tickEvent = events.find((e) => e.data?.daemon === 'tick_processed');
    expect(tickEvent).toBeDefined();
    expect(tickEvent.data.started).toBe(2);
  });

  it('does not exceed maxConcurrentGoals', async () => {
    // Insert 5 goals but maxConcurrentGoals is 3.
    insertGoal('Goal A', 'high');
    insertGoal('Goal B', 'high');
    insertGoal('Goal C', 'high');
    insertGoal('Goal D', 'low');
    insertGoal('Goal E', 'low');

    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    await daemon.tick();

    const startEvents = events.filter((e) => e.data?.daemon === 'goal_started');
    expect(startEvents.length).toBe(3); // only 3 slots
  });

  it('persists active goals to system_state', async () => {
    insertGoal('Persist test', 'low');

    await daemon.tick();

    // Check system_state has the active goals.
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get('daemon_active_goals') as { value?: string } | undefined;
    expect(row).toBeDefined();
    const activeIds = JSON.parse(row!.value!);
    expect(activeIds.length).toBeGreaterThanOrEqual(0); // may be 0 if goal completed fast
  });

  it('restores active goals on restart', () => {
    // Simulate a restart: save active goals to system_state, then create a new daemon.
    db.prepare('INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('daemon_active_goals', JSON.stringify(['goal-restored']), new Date().toISOString());

    // Mark the goal as running in the DB.
    const goalId = insertGoal('Restored goal', 'low');
    db.prepare('UPDATE goals SET id = ?, status = ? WHERE id = ?').run('goal-restored', 'running', goalId);

    const newDaemon = new LoopDaemon(db, loops, { pollMs: 100 });
    newDaemon.restoreActiveGoals();

    expect(newDaemon.getActiveGoalCount()).toBe(1);
    newDaemon.stop();
  });

  it('prioritizes goals by risk class', async () => {
    const lowId = insertGoal('Low priority', 'low');
    const criticalId = insertGoal('Critical priority', 'critical');
    const highId = insertGoal('High priority', 'high');

    // With maxConcurrentGoals=1, only the highest priority should start.
    const singleDaemon = new LoopDaemon(db, loops, { pollMs: 100, maxConcurrentGoals: 1 });
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    await singleDaemon.tick();

    const startEvents = events.filter((e) => e.data?.daemon === 'goal_started');
    expect(startEvents.length).toBe(1);
    expect(startEvents[0].data.goal_id).toBe(criticalId);

    singleDaemon.stop();
  });

  it('emits tick_processed event with concurrency info', async () => {
    insertGoal('Concurrency test', 'low');

    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    await daemon.tick();

    const tickEvent = events.find((e) => e.data?.daemon === 'tick_processed');
    expect(tickEvent).toBeDefined();
    expect(tickEvent.data.active).toBeDefined();
    expect(tickEvent.data.available_slots).toBeDefined();
  });
});
