import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb } from './helpers/test-db';
import { createMemoryEvolutionRoutes } from '../routes/memory-evolution';

describe('memory evolution routes', () => {
  let db: ReturnType<typeof createTestDb>;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = createTestDb();
    const app = express();
    app.use(express.json());
    app.use('/memory-evolution', createMemoryEvolutionRoutes(db));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server.close();
    db.close();
  });

  it('persists ingested traces and schedules real evaluation goals', async () => {
    const ingest = await fetch(`${baseUrl}/memory-evolution/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'maker-a', content: 'When checks fail, inspect the exact error.', metadata: { title: 'Check failures', shared: 1 } }),
    });
    expect(ingest.status).toBe(201);
    const ingested = await ingest.json() as any;
    expect(db.prepare('SELECT content FROM memory_candidates WHERE id = ?').get(ingested.candidate.id))
      .toEqual({ content: 'When checks fail, inspect the exact error.' });

    const evolve = await fetch(`${baseUrl}/memory-evolution/evolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'evaluate', candidate_ids: [ingested.candidate.id], agent_id: 'scheduler' }),
    });
    expect(evolve.status).toBe(200);
    const evolved = await evolve.json() as any;
    expect(evolved.status).toBe('scheduled');
    expect(evolved.goals).toHaveLength(1);
    expect(db.prepare('SELECT status FROM goals WHERE id = ?').get(evolved.goals[0].id)).toEqual({ status: 'created' });

    const promoted = await fetch(`${baseUrl}/memory-evolution/promote/${ingested.candidate.id}`, { method: 'POST' });
    expect(promoted.status).toBe(200);
    expect((await promoted.json() as any).eligible).toBe(false);
    const lease = await fetch(`${baseUrl}/memory-evolution/leases`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loop_run_id: evolved.goals[0].id, role: 'memory_evaluator', memory_candidate_id: ingested.candidate.id, metadata: { source: 'route-test' } }),
    });
    expect(lease.status).toBe(201);
    const listedLeases = await fetch(`${baseUrl}/memory-evolution/leases?role=memory_evaluator`);
    expect(listedLeases.status).toBe(200);
    expect((await listedLeases.json() as any).leases[0]).toMatchObject({ role: 'memory_evaluator', memory_candidate_id: ingested.candidate.id, metadata: { source: 'route-test' } });
  });

  it('derives cross-agent usage from distinct retrieval access records', async () => {
    const ingest = await fetch(`${baseUrl}/memory-evolution/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'maker-a', content: 'Shared operational memory', metadata: { shared: 1 } }),
    });
    const candidate = (await ingest.json() as any).candidate;

    for (const agentId of ['checker-b', 'checker-c']) {
      const retrieve = await fetch(`${baseUrl}/memory-evolution/retrieve?agent_id=${agentId}`);
      expect(retrieve.status).toBe(200);
      expect((await retrieve.json() as any).candidates).toContain(candidate.id);
    }

    const quality = await fetch(`${baseUrl}/memory-evolution/quality/${candidate.id}`);
    expect(quality.status).toBe(200);
    expect((await quality.json() as any).crossAgentUsage).toBe(1);
    expect(db.prepare('SELECT COUNT(DISTINCT agent_id) AS count FROM memory_access_log WHERE candidate_id = ?').get(candidate.id))
      .toEqual({ count: 2 });
  });

  it('rejects malformed retrieval limits at the HTTP boundary', async () => {
    for (const value of ['NaN', '0', '101', '1.5']) {
      const response = await fetch(`${baseUrl}/memory-evolution/retrieve?agent_id=agent-a&limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('rejects malformed ingest, evolution and lease payloads before mutation', async () => {
    for (const [path, body] of [
      ['/memory-evolution/ingest', { agent_id: {}, content: 'trace' }],
      ['/memory-evolution/evolve', { action: 'evaluate', candidate_ids: [42] }],
      ['/memory-evolution/leases', { loop_run_id: 'run-1', role: 'unknown' }],
      ['/memory-evolution/leases', { loop_run_id: 'run-1', role: 'memory_evaluator', metadata: [] }],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_evolution_leases').get()).toEqual({ count: 0 });
  });
});
