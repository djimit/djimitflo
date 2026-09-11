import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createLegalRoutes } from '../routes/legal';
import { errorHandler } from '../middleware/error-handler';

describe('legal RuleOps route contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  function app() {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    return express().use(express.json()).use('/legal', createLegalRoutes(db, auth)).use(errorHandler);
  }

  it('rejects non-string PII inputs and unknown legal domains before classification', async () => {
    const server = app();
    for (const body of [
      { ecli: 123, bodyText: 'text' },
      { ecli: 'ECLI:NL:RBAMS:2026:1234', bodyText: {} },
      { ecli: 'ECLI:NL:RBAMS:2026:1234', bodyText: 'text', rechtsgebied: 'unknown' },
    ]) {
      const response = await request(server).post('/legal/check-pii').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects malformed feedback without writing governance rows', async () => {
    const server = app();
    for (const body of [
      { ecli: 'ECLI:NL:RBAMS:2026:1234', corrected_action: 'invalid', reason: 'x' },
      { ecli: 'ECLI:NL:RBAMS:2026:1234', detection_index: -1, corrected_action: 'pseudonimiseer', reason: 'x' },
      { ecli: 'ECLI:NL:RBAMS:2026:1234', corrected_action: 'pseudonimiseer', reason: {}, corrected_by: 'operator' },
    ]) {
      const response = await request(server).post('/legal/feedback').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const db = dbs[0];
    expect(db.prepare('SELECT COUNT(*) AS count FROM governance_feedback').get()).toEqual({ count: 0 });
  });

  it('classifies, detects legal domain and exposes service status over HTTP', async () => {
    const server = app();
    const classified = await request(server).post('/legal/classify').send({ text: 'De BSN is 123456789', rechtsgebied: 'civiel' });
    expect(classified.status).toBe(200);
    expect(classified.body).toMatchObject({ rechtsgebied: 'civiel' });
    expect(classified.body.detections.length).toBeGreaterThan(0);
    const domain = await request(server).get('/legal/rechtsgebied/ECLI:NL:HR:2026:9012');
    expect(domain.status).toBe(200);
    expect(domain.body).toEqual({ ecli: 'ECLI:NL:HR:2026:9012', rechtsgebied: 'cassatie' });
    const status = await request(server).get('/legal/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ engine_version: '3.1.0-djimflo', feedback_count: 0 });
  });
});
