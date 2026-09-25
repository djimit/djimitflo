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
