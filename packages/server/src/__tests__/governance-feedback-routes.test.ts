import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from './helpers/test-db';
import { createGovernanceFeedbackRoutes } from '../routes/governance-feedback';

describe('governance feedback HTTP contracts', () => {
  let server: Server | undefined;
  let db: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects malformed history limits before loop history access', async () => {
    db = createTestDb();
    const app = express();
    app.use(express.json());
    app.use('/governance-feedback', createGovernanceFeedbackRoutes(db, {
      requirePermission: () => (req: any, _res: any, next: any) => {
        req.user = { sub: 'governance-route-admin', email: 'admin@example.test', role: 'admin' };
        next();
      },
    } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const value of ['NaN', '0', '101', '1.5']) {
      const response = await fetch(`${base}/governance-feedback/history?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const valid = await fetch(`${base}/governance-feedback/history?limit=1`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).history).toEqual([]);

    const health = await fetch(`${base}/governance-feedback/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'healthy', pending_proposals: 0, total_runs: 0 });
    for (const path of ['analyze', 'propose', 'run']) {
      const malformed = await fetch(`${base}/governance-feedback/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(malformed.status, path).toBe(400);
    }
    const analyzed = await fetch(`${base}/governance-feedback/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'missing-agent' }),
    });
    expect(analyzed.status).toBe(200);
    expect(await analyzed.json()).toMatchObject({ agent_id: 'missing-agent', failures_detected: 0 });
    const proposed = await fetch(`${base}/governance-feedback/propose`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'missing-agent' }),
    });
    expect(proposed.status).toBe(200);
    expect(await proposed.json()).toMatchObject({ agent_id: 'missing-agent', proposals_created: 0 });
    const run = await fetch(`${base}/governance-feedback/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'missing-agent' }),
    });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ failures_detected: 0, proposals_created: 0, proposals_executed: 0 });
    const proposals = await fetch(`${base}/governance-feedback/proposals`);
    expect(proposals.status).toBe(200);
    expect(await proposals.json()).toMatchObject({ proposals: [], count: 0 });
    const dormant = await fetch(`${base}/governance-feedback/dormant-capabilities`);
    expect(dormant.status).toBe(200);
    expect((await dormant.json()).count).toBeGreaterThanOrEqual(0);
  });
});
