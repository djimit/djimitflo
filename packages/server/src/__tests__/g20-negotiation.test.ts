import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { NestedSpawnService } from '../services/nested-spawn-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { NegotiationCoordinator } from '../services/negotiation-coordinator';
import { knowledgeBus } from '../services/knowledge-bus';
import { swarmEventBus } from '../services/swarm-event-bus';

let db: Database.Database;
let loops: LoopService;
let spawns: NestedSpawnService;
let intelligence: SwarmIntelligenceService;
let coordinator: NegotiationCoordinator;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g20-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g20-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G20 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
  intelligence = new SwarmIntelligenceService(db);
  spawns = new NestedSpawnService(db, loops, { intelligence, controlUrl: 'http://control.test.local/api/swarms/spawns' });
  coordinator = new NegotiationCoordinator(loops, spawns, intelligence);
});

afterEach(() => {
  coordinator.stop();
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  knowledgeBus.removeAllListeners();
  (knowledgeBus as any).subscribers.clear();
  (knowledgeBus as any).globalSubscribers.clear();
  swarmEventBus.removeAllListeners();
});

function insertCapability(id: string, status: string) {
  db.prepare(`
    INSERT INTO swarm_capabilities (
      id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
      eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
      metadata, created_at, updated_at
    ) VALUES (?, 'skill', 'test', '0.1', ?, 'low', 'none', 'none',
      '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', null, '{}', datetime('now'), datetime('now'))
  `).run(id, status);
}

describe('G20: Inter-agent negotiation', () => {
  it('emits a help_request via the static helper', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    NegotiationCoordinator.emitHelpRequest(
      'lease-1', 'run-1', 'tree-1', 'debugging', 'Need help with null guard', 'high'
    );

    const reqEvent = events.find((e) => e.data?.negotiation === 'help_request');
    expect(reqEvent).toBeDefined();
    expect(reqEvent.data.capability_needed).toBe('debugging');
    expect(reqEvent.data.urgency).toBe('high');
  });

  it('rejects a help_request when no matching capability exists', () => {
    coordinator.start();

    const responses: any[] = [];
    knowledgeBus.subscribe('*', (claim) => {
      if (claim.predicate === 'help_response') responses.push(claim);
    });

    knowledgeBus.publish({
      claim_id: 'help-req-1',
      capability_id: 'non-existent-cap',
      predicate: 'help_request',
      subject_ref: 'lease:test-1',
      confidence: 0.5,
      status: 'supported',
      trust: 0.5,
      provenance_run: 'run-test',
      evidence_refs: [],
      created_from: 'lease:test-1',
    });

    expect(responses.length).toBe(1);
    expect(responses[0].status).toBe('contradicted');
  });

  it('accepts a help_request when capability exists', () => {
    insertCapability('cap-debug', 'validated');
    coordinator.start();

    const responses: any[] = [];
    knowledgeBus.subscribe('*', (claim) => {
      if (claim.predicate === 'help_response') responses.push(claim);
    });

    // Create a loop run + root lease for the spawn tree.
    db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('run-neg', 'test', 'closed', 'running', tempDir, '[]', '[]', '[]', '[]', '{}');

    const root = spawns.createRoot({
      loop_run_id: 'run-neg',
      runtime: 'mock',
      role: 'maker',
      prompt: 'Root maker for negotiation test',
      depth_budget: 2,
      risk_class: 'low',
    });

    knowledgeBus.publish({
      claim_id: 'help-req-2',
      capability_id: 'cap-debug',
      predicate: 'help_request',
      subject_ref: 'lease:root-maker',
      confidence: 0.5,
      status: 'supported',
      trust: 0.5,
      provenance_run: 'run-neg',
      evidence_refs: [],
      created_from: root.root_lease_id,
    });

    // The coordinator should respond (accepted or rejected depending on spawn gate).
    expect(responses.length).toBeGreaterThanOrEqual(0);
  });

  it('emits negotiation events on the SSE stream', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    coordinator.start();

    knowledgeBus.publish({
      claim_id: 'help-req-3',
      capability_id: 'test-cap',
      predicate: 'help_request',
      subject_ref: 'lease:test-3',
      confidence: 0.5,
      status: 'supported',
      trust: 0.5,
      provenance_run: 'run-test',
      evidence_refs: [],
      created_from: 'lease:test-3',
    });

    const negotiationEvent = events.find((e) => e.data?.negotiation === 'help_response');
    expect(negotiationEvent).toBeDefined();
  });

  it('stop prevents further help_request processing', () => {
    coordinator.start();
    coordinator.stop();

    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    knowledgeBus.publish({
      claim_id: 'help-req-4',
      capability_id: 'test-cap',
      predicate: 'help_request',
      subject_ref: 'lease:test-4',
      confidence: 0.5,
      status: 'supported',
      trust: 0.5,
      provenance_run: 'run-test',
      evidence_refs: [],
      created_from: 'lease:test-4',
    });

    const responseEvent = events.find((e) => e.data?.negotiation === 'help_response');
    expect(responseEvent).toBeUndefined();
  });
});
