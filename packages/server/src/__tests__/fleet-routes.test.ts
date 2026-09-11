import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createFleetRoutes } from '../routes/fleet';
import { errorHandler } from '../middleware/error-handler';

describe('fleet mesh route contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  function app() {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    return { db, server: express().use(express.json()).use('/fleet', createFleetRoutes(db, auth)).use(errorHandler) };
  }

  it('rejects malformed node and distribution payloads before persistence', async () => {
    const { db, server } = app();
    for (const body of [
      { name: 1, endpoint: 'http://node-a' },
      { name: 'node', endpoint: 'http://node-a', capabilities: ['ok', 4] },
      { name: 'node', endpoint: 'http://node-a', maxAgents: 0 },
      { name: 'node', endpoint: 'http://node-a', metadata: [] },
    ]) {
      const response = await request(server).post('/fleet/nodes').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const distribution = await request(server).post('/fleet/distribute').send({ loopRunId: 'run', requiredCapabilities: ['codex'], priority: 101 });
    expect(distribution.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM fleet_nodes').get()).toEqual({ count: 0 });
  });

  it('executes node, handoff, distribution and capability-sync routes end to end', async () => {
    const { server } = app();
    const first = await request(server).post('/fleet/nodes').send({ name: 'MacBook', endpoint: 'http://macbook', capabilities: ['codex'], maxAgents: 4 }).expect(201);
    const second = await request(server).post('/fleet/nodes').send({ name: 'Workstation', endpoint: 'http://workstation', capabilities: ['opencode'], maxAgents: 8 }).expect(201);
    await request(server).get('/fleet/status').expect(200);
    await request(server).get('/fleet/nodes').expect(200);
    await request(server).get(`/fleet/nodes/${first.body.id}`).expect(200);
    const handoff = await request(server).post('/fleet/handoff').send({ fromNode: first.body.id, toNode: second.body.id, agentId: 'agent-1' }).expect(201);
    await request(server).post(`/fleet/handoff/${handoff.body.id}/accept`).expect(200, { accepted: true });
    await request(server).post(`/fleet/handoff/${handoff.body.id}/complete`).expect(200, { completed: true });
    await request(server).post('/fleet/distribute').send({ loopRunId: 'loop-1', requiredCapabilities: ['codex'], priority: 10 }).expect(201);
    await request(server).post('/fleet/sync-capability').send({ sourceNode: first.body.id, capabilityId: 'cap-1', capabilityType: 'reasoning', score: 0.9 }).expect(201);
  });
});
