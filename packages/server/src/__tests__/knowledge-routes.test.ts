import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeRoutes } from '../routes/knowledge';
import { knowledgeBus } from '../services/knowledge-bus';
import { errorHandler } from '../middleware/error-handler';
import { createTestDb } from './helpers/test-db';

describe('knowledge bus HTTP publish contract', () => {
  afterEach(() => knowledgeBus.removeAllListeners('claim'));

  function app() {
    const db = createTestDb();
    const auth = { requireAuth: (_req: any, _res: any, next: any) => next() } as any;
    const instance = express().use(express.json()).use('/knowledge', createKnowledgeRoutes(auth, db)).use(errorHandler);
    return { instance, db };
  }

  it('rejects malformed claim fields without publishing', async () => {
    const { instance, db } = app();
    const published: unknown[] = [];
    knowledgeBus.on('claim', claim => published.push(claim));
    for (const body of [
      { claim_id: 42, subject_ref: 'subject' },
      { claim_id: 'claim', subject_ref: 'subject', confidence: 1.1 },
      { claim_id: 'claim', subject_ref: 'subject', trust: 'high' },
      { claim_id: 'claim', subject_ref: 'subject', evidence_refs: ['ok', 7] },
    ]) {
      const response = await request(instance).post('/knowledge/publish').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(published).toHaveLength(0);
    db.close();
  });

  it('preserves zero scores and publishes a valid claim', async () => {
    const { instance, db } = app();
    const published: any[] = [];
    knowledgeBus.on('claim', claim => published.push(claim));
    const response = await request(instance).post('/knowledge/publish').send({
      claim_id: 'claim-1', subject_ref: 'subject-1', confidence: 0, trust: 0, evidence_refs: [],
    });
    expect(response.status).toBe(200);
    expect(published[0]).toMatchObject({ claim_id: 'claim-1', subject_ref: 'subject-1', confidence: 0, trust: 0 });
    db.close();
  });

  it('reads recent durable claims through the events route with bounded limits', async () => {
    const { instance, db } = app();
    db.prepare(`INSERT INTO swarm_claims
      (id, claim, claim_type, subject_ref, predicate, confidence, status, created_from)
      VALUES ('claim-event-1', 'Fixture claim', 'observation', 'subject-1', 'supports', 0.8, 'supported', 'route-test')`).run();

    const response = await request(instance).get('/knowledge/events?limit=1');
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0]).toMatchObject({
      subject_ref: 'subject-1', predicate: 'supports', confidence: 0.8, status: 'supported',
    });
    expect((await request(instance).get('/knowledge/events?limit=0')).status).toBe(400);
    db.close();
  });

  it('opens the canonical SSE subscription and cleans up on disconnect', async () => {
    const { instance, db } = app();
    const server: Server = instance.listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address() as { port: number };
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/knowledge/subscribe/capability-a`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"type":"connected"');
      await reader.cancel();
      reader.releaseLock();
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      server.closeIdleConnections();
      server.closeAllConnections();
    } finally {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
