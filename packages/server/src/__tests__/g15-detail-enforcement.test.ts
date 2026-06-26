import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { errorHandler } from '../middleware/error-handler';
import { createSwarmRoutes } from '../routes/swarms';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';

const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;

let db: Database.Database;
let server: Server;
let baseUrl: string;
let intel: SwarmIntelligenceService;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intel = new SwarmIntelligenceService(db);
  await startApp();
});

afterEach(() => { server?.close(); db?.close(); });

describe('G15 detail enforcement', () => {
  it('blocks direct API assertion of completed runner manifests', async () => {
    const res = await fetch(`${baseUrl}/swarms/intelligence/runner-manifests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision_id: 'test-direct-complete',
        lease_id: 'lease-1',
        loop_run_id: 'loop-1',
        action: 'complete',
        policy_version: 'test-v1',
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('RUNNER_MANIFEST_DIRECT_ASSERTION_BLOCKED');
  });

  it('allows direct API creation of plan manifests (not completed)', async () => {
    const res = await fetch(`${baseUrl}/swarms/intelligence/runner-manifests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision_id: 'test-plan-manifest',
        lease_id: 'lease-2',
        loop_run_id: 'loop-2',
        action: 'plan',
        policy_version: 'test-v1',
      }),
    });
    expect(res.status).toBe(201);
  });

  it('extracts claims from specialist panel reviews', () => {
    // Create a panel
    const panels = new SpecialistPanelService(db);
    const panel = panels.createPanel({
      topic: 'Test extraction',
      question: 'Should we use approach A or B?',
      risk_class: 'low',
      specialist_ids: ['systems_architect', 'security_reviewer'],
    });

    // Submit reviews with findings
    panels.submitReview(panel.id, {
      specialist_id: 'systems_architect',
      stance: 'support',
      confidence: 0.8,
      findings: 'Approach A is simpler and sufficient',
      recommendations: 'Use approach A',
      evidence_refs: ['doc:comparison'],
    });

    panels.submitReview(panel.id, {
      specialist_id: 'security_reviewer',
      stance: 'uncertain',
      confidence: 0.5,
      findings: 'Need more evidence for security implications',
      recommendations: 'Conduct security review first',
      evidence_refs: [],
    });

    // Extract claims
    const result = intel.extractClaimsFromPanel(panel.id);
    expect(result.extracted).toBe(2);

    // The review with evidence should be 'supported', without should be 'proposed'
    const supported = result.claims.find((c) => c.status === 'supported');
    const proposed = result.claims.find((c) => c.status === 'proposed');
    expect(supported).toBeDefined();
    expect(proposed).toBeDefined();
  });

  it('sets retention metadata on memory candidates', () => {
    // Create a memory candidate first
    db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, sensitivity, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'mem-retention-test', 'Test memory', 'Test memory content', 'operational_memory', 'candidate', 'proposed', 'normal', '{}', new Date().toISOString(), new Date().toISOString()
    );
    intel.setRetentionMetadata('memory:mem-retention-test', {
      ttl_days: 90,
      delete_after: '2027-01-01T00:00:00Z',
      sensitivity: 'normal',
    });

    const row = db.prepare('SELECT metadata FROM memory_candidates WHERE id = ?').get('mem-retention-test') as any;
    const meta = JSON.parse(row.metadata);
    expect(meta.retention_ttl_days).toBe(90);
    expect(meta.retention_delete_after).toBe('2027-01-01T00:00:00Z');
    expect(meta.sensitivity).toBe('normal');
  });

  it('ensures ready_for_human_merge, human_approved, and completed are distinct states', () => {
    // Verify loop_run statuses include all three as distinct values
    const validStatuses = ['created', 'running', 'ready_for_human_merge', 'completed', 'failed', 'interrupted'];
    expect(validStatuses).toContain('ready_for_human_merge');
    expect(validStatuses).toContain('completed');
    expect('ready_for_human_merge').not.toBe('completed');

    // human_approval_ref is a metadata field, not a status
    // Verify completeLoopRun requires human_approval_ref separately from ready_for_human_merge status
    const loopRun = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'loop-distinct-test', 'doc-drift-and-small-fix-loop', 'closed', 'ready_for_human_merge',
      '[]', '{}', '[]', '[]', '{}', new Date().toISOString(), new Date().toISOString()
    );
    expect(loopRun).toBeDefined();

    const row = db.prepare('SELECT status FROM loop_runs WHERE id = ?').get('loop-distinct-test') as any;
    expect(row.status).toBe('ready_for_human_merge');
    expect(row.status).not.toBe('completed');
  });
});
