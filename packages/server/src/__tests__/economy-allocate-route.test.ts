import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let server: Server;
let baseUrl: string;

const auth = {
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.user = { sub: 'test-user', email: 'user@example.test', role: 'approver' };
    next();
  },
} as any;

function registerCapability(intel: SwarmIntelligenceService, id: string, p50Dollars: number) {
  return intel.registerCapability({
    id,
    kind: 'skill',
    owner: 'test',
    version: '0.1.0',
    status: 'validated',
    risk_ceiling: 'low',
    input_schema_ref: 'none',
    output_schema_ref: 'none',
    allowed_actions: ['maker:mock'],
    forbidden_actions: ['deploy'],
    required_evidence: ['worker_lease'],
    eval_threshold: 0.75,
    removal_strategy: 'disable if eval fails',
    cost_model: { p50_dollars: p50Dollars, p95_dollars: p50Dollars * 1.5 },
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);

  const app = express();
  app.use(express.json());
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});

describe('GET /swarms/economy/allocate', () => {
  it('allocates the highest competence-per-dollar capabilities first within budget', async () => {
    const intel = new SwarmIntelligenceService(db);
    registerCapability(intel, 'cap-cheap', 0.10);
    registerCapability(intel, 'cap-mid', 0.30);
    registerCapability(intel, 'cap-expensive', 0.80);

    const response = await fetch(`${baseUrl}/swarms/economy/allocate?budget=0.45`);
    expect(response.status).toBe(200);
    const body = await response.json() as { allocated: Array<{ capability_id: string }>; deferred: Array<{ capability_id: string }>; budget_insufficient: boolean };
    // Success rate ties at 0 (no worker_leases yet), so ranking order among the
    // tied capabilities is unspecified — but their combined cost (0.10 + 0.30 =
    // 0.40) fits within $0.45 regardless of processing order, while $0.80 alone
    // never fits, so the allocated/deferred split is deterministic either way.
    const allocatedIds = body.allocated.map((c) => c.capability_id).sort();
    expect(allocatedIds).toEqual(['cap-cheap', 'cap-mid']);
    expect(body.deferred.map((c) => c.capability_id)).toEqual(['cap-expensive']);
    expect(body.budget_insufficient).toBe(false);
  });

  it('reports budget_insufficient when nothing fits', async () => {
    const intel = new SwarmIntelligenceService(db);
    registerCapability(intel, 'cap-expensive', 5.0);

    const response = await fetch(`${baseUrl}/swarms/economy/allocate?budget=1.0`);
    const body = await response.json() as { allocated: unknown[]; budget_insufficient: boolean };
    expect(body.allocated).toEqual([]);
    expect(body.budget_insufficient).toBe(true);
  });

  it('rejects a missing or invalid budget', async () => {
    const missing = await fetch(`${baseUrl}/swarms/economy/allocate`);
    expect(missing.status).toBe(400);
    const negative = await fetch(`${baseUrl}/swarms/economy/allocate?budget=-1`);
    expect(negative.status).toBe(400);
  });
});

describe('GET /swarms/economy (null-safe run economy)', () => {
  const insertRun = (id: string, status: string, gates: unknown[]) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata)
    VALUES (?, 'test', 'closed', ?, '/tmp', '[]', '[]', ?, '[]', '{}')`).run(id, status, JSON.stringify(gates));
  const insertLease = (id: string, runId: string, role: string, meta: Record<string, unknown>) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata)
    VALUES (?, ?, ?, 'codex', 'completed', 'f1', '/tmp', ?)`).run(id, runId, role, JSON.stringify(meta));

  it('returns null rather than 0 for unknown dollars and efficiency, and separates completed_unverified', async () => {
    insertRun('run-unknown', 'completed', [{ name: 'maker_completion', status: 'pass', evidence: '' }]);
    insertLease('m-unknown', 'run-unknown', 'maker', {});
    insertRun('run-unverified', 'completed', []);
    insertLease('m-unverified', 'run-unverified', 'maker', { runtime_usage: { total_tokens: 500_000 } });

    const response = await fetch(`${baseUrl}/swarms/economy`);
    expect(response.status).toBe(200);
    const body = await response.json() as { recent_runs: Array<Record<string, unknown>>; summary: Record<string, unknown> };
    const unknown = body.recent_runs.find((r) => r.run_id === 'run-unknown')!;
    expect(unknown).toMatchObject({ verified_artifacts: 1, completed_unverified: 0, dollars_spent: null, efficiency: null, efficiency_reason: 'no_usage_reported',
      usage_coverage: { reported: 0, total: 1, ratio: 0 }, dollars_lower_bound: false, run_verified: true });
    const unverified = body.recent_runs.find((r) => r.run_id === 'run-unverified')!;
    expect(unverified).toMatchObject({ verified_artifacts: 0, completed_unverified: 1, run_verified: false });
    expect(unverified.dollars_spent).toBeCloseTo(1.0, 6);
    // keys kept for backward compatibility; the dollar total sums only runs whose dollars are known
    expect(body.summary).toMatchObject({ total_capabilities: 0, total_verified_artifacts: 1, total_completed_unverified: 1,
      runs_with_unknown_dollars: 1, total_dollars_lower_bound: true });
    expect(body.summary.total_dollars_spent).toBeCloseTo(1.0, 6);
  });

  it('total_dollars_spent is null when no run reported usage', async () => {
    insertRun('run-a', 'completed', []);
    insertLease('m-a', 'run-a', 'maker', {});
    const body = await (await fetch(`${baseUrl}/swarms/economy`)).json() as { summary: Record<string, unknown> };
    expect(body.summary.total_dollars_spent).toBeNull();
    expect(body.summary.total_verified_artifacts).toBe(0);
    expect(body.summary.total_completed_unverified).toBe(1);
  });
});
