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
import { swarmEventBus } from '../services/swarm-event-bus';

let db: Database.Database;
let loops: LoopService;
let intelligence: SwarmIntelligenceService;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g14-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g14-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G14 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
  intelligence = new SwarmIntelligenceService(db);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  swarmEventBus.removeAllListeners();
});

describe('G14: Live observability', () => {
  it('emits aimd_state event on adjustConcurrency', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    // Trigger adjustConcurrency (it's private, so we call it via any)
    (loops as any).adjustConcurrency(true);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('aimd_state');
    expect(events[0].data.success).toBe(true);
    expect(events[0].data.dynamicLimit).toBeDefined();
    expect(events[0].data.active).toBeDefined();
    expect(events[0].data.queue_depth).toBeDefined();
  });

  it('emits convergence event on certifyLoopRun', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
    loops.certifyLoopRun(run.id);

    const convergenceEvent = events.find((e) => e.type === 'convergence');
    expect(convergenceEvent).toBeDefined();
    expect(convergenceEvent.data.run_id).toBe(run.id);
    expect(convergenceEvent.data.certified).toBeDefined();
  });

  it('emits capability_transition on auto-deprecation', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    // Insert a validated capability with poor performance.
    db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
        eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
        metadata, created_at, updated_at
      ) VALUES (?, 'skill', 'test', '0.1', 'validated', 'low', 'none', 'none',
        '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', null, '{}', datetime('now'), datetime('now'))
    `).run('cap-bad');

    // Insert 3 failed leases to trigger auto-deprecation.
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('run-dep', 'test', 'closed', 'completed')`).run();
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata, capability_id)
        VALUES (?, 'run-dep', 'maker', 'codex', 'failed', 'f1', '/tmp/wt', '{}', 'cap-bad')
      `).run(`lease-dep-${i}`);
    }

    intelligence.measureCompetence('cap-bad');

    const transitionEvent = events.find((e) => e.type === 'capability_transition');
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent.data.capability_id).toBe('cap-bad');
    expect(transitionEvent.data.old_status).toBe('validated');
    expect(transitionEvent.data.new_status).toBe('deprecated');
  });

  it('emits recovery event on resumeInterruptedRun', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    // Create an interrupted run.
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata) VALUES ('run-resume', 'test', 'closed', 'interrupted', '/tmp', '[]', '[]', '[]', '[]', '{}')`).run();
    loops.resumeInterruptedRun('run-resume');

    const recoveryEvent = events.find((e) => e.type === 'recovery');
    expect(recoveryEvent).toBeDefined();
    expect(recoveryEvent.data.run_id).toBe('run-resume');
    expect(recoveryEvent.data.resumed).toBe(true);
  });

  it('event bus supports multiple subscribers', () => {
    const events1: any[] = [];
    const events2: any[] = [];
    swarmEventBus.subscribe((e) => events1.push(e));
    swarmEventBus.subscribe((e) => events2.push(e));

    (loops as any).adjustConcurrency(false);

    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);
    expect(events1[0].type).toBe('aimd_state');
    expect(events2[0].type).toBe('aimd_state');
  });
});
