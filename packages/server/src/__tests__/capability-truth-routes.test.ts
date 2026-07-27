import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb } from './helpers/test-db';
import { createAgiRoutes } from '../routes/agi';
import { createEvidenceRoutes } from '../routes/evidence';
import { createHealthRoutes } from '../routes/health';
import { createMemoryEvolutionRoutes } from '../routes/memory-evolution';
import { createRiskRoutes } from '../routes/risk';
import { errorHandler } from '../middleware/error-handler';
import { EvidenceService } from '../services/evidence-service';

describe('capability-truth HTTP chains', () => {
  let db: ReturnType<typeof createTestDb>;
  let server: Server;
  let baseUrl: string;

  const auth = {
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { sub: 'test-admin', email: 'test@example.invalid', role: 'admin' };
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
  } as any;

  beforeEach(async () => {
    db = createTestDb();
    const app = express();
    app.use(express.json());
    app.use('/agi', createAgiRoutes(db, auth));
    app.use('/evidence', createEvidenceRoutes(db, auth));
    app.use('/health', createHealthRoutes(db, auth));
    app.use('/memory-evolution', createMemoryEvolutionRoutes(db));
    app.use('/risk', createRiskRoutes(db, auth));
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    db.close();
  });

  it('persists an ingested trace and exposes its evaluation chain', async () => {
    const ingested = await fetch(`${baseUrl}/memory-evolution/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-memory',
        content: 'When a governed run succeeds, retain its evidence and exact preconditions.',
        metadata: { title: 'Governed run rule' },
      }),
    });
    expect(ingested.status).toBe(201);
    const body = await ingested.json() as any;
    expect(db.prepare('SELECT id FROM memory_candidates WHERE id = ?').get(body.candidate.id))
      .toEqual({ id: body.candidate.id });

    const retrieved = await fetch(`${baseUrl}/memory-evolution/retrieve?agent_id=agent-memory`);
    expect(await retrieved.json()).toMatchObject({ candidates: [body.candidate.id], total: 1 });

    const quality = await fetch(`${baseUrl}/memory-evolution/quality/${body.candidate.id}`);
    expect(await quality.json()).toMatchObject({ candidateId: body.candidate.id, composite: expect.any(Number) });

    const promotion = await fetch(`${baseUrl}/memory-evolution/promote/${body.candidate.id}`, { method: 'POST' });
    expect(await promotion.json()).toMatchObject({
      eligible: expect.any(Boolean),
      quality: { candidateId: body.candidate.id },
      benchmark: { pass: expect.any(Boolean) },
    });
  });

  it('executes AGI observation and persistent consensus routes', async () => {
    const observed = await fetch(`${baseUrl}/agi/observe`);
    expect(observed.status).toBe(200);
    expect(await observed.json()).toBeTypeOf('object');

    const created = await fetch(`${baseUrl}/agi/consensus/debates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'Select the smallest verified improvement', context: 'capability truth' }),
    });
    expect(created.status).toBe(201);
    const debate = await created.json() as any;

    const fetched = await fetch(`${baseUrl}/agi/consensus/debates/${debate.id}`);
    expect(await fetched.json()).toMatchObject({
      id: debate.id,
      topic: 'Select the smallest verified improvement',
      status: 'proposing',
    });
  });

  it('classifies command risk through the HTTP boundary', async () => {
    const low = await fetch(`${baseUrl}/risk/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'git status' }),
    });
    expect(await low.json()).toMatchObject({
      assessment: { risk_level: 'low', recommended_decision: 'allow' },
    });

    const critical = await fetch(`${baseUrl}/risk/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'rm -rf /' }),
    });
    expect(await critical.json()).toMatchObject({
      assessment: { risk_level: 'critical', recommended_decision: 'deny' },
    });
  });

  it('exposes persisted execution evidence and runtime metrics', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode)
      VALUES ('task-capability-truth', 'Evidence route', 'Verify persisted evidence', 'completed', 'medium', 'low', 'local')
    `).run();
    new EvidenceService(db).captureEvidence({
      task_id: 'task-capability-truth',
      evidence_type: 'execution_log' as any,
      severity: 'info' as any,
      title: 'Execution complete',
      summary: 'The test execution completed.',
      source: 'capability-truth-test',
    });

    const evidence = await fetch(`${baseUrl}/evidence/task/task-capability-truth`);
    expect(await evidence.json()).toMatchObject({
      evidence: [expect.objectContaining({ title: 'Execution complete' })],
    });

    const metrics = await fetch(`${baseUrl}/health/metrics/json`);
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      loops: { total: expect.any(Number) },
      workers: { total: expect.any(Number) },
      tokens: { totalUsed: expect.any(Number) },
    });
  });
});
