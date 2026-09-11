import express from 'express';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createResearchRoutes } from '../routes/research';

describe('research HTTP contracts', () => {
  let server: Server | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects malformed trust thresholds at the route boundary', async () => {
    db = new Database(':memory:');
    const app = express();
    app.use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const value of ['NaN', '-0.1', '1.1']) {
      const response = await fetch(`${base}/research/sources/trusted?min_trust=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const valid = await fetch(`${base}/research/sources/trusted?min_trust=0.8`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).sources).toEqual([]);
  });

  it('persists sources and citation-linked claims, detects contradiction and generates a report', async () => {
    db = new Database(':memory:');
    const app = express().use(express.json()).use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const source = await fetch(`${base}/research/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.test/rule', title: 'Fixture rule', source_type: 'web', trust_score: 0.95 }) });
    expect(source.status).toBe(201);
    const sourceId = (await source.json() as any).id;
    const claim = async (text: string) => fetch(`${base}/research/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source_ids: [sourceId], confidence: 0.9 }) });
    const positive = await claim('The fixture rule is correct');
    const negative = await claim('The fixture rule is not correct');
    expect(positive.status).toBe(201); expect(negative.status).toBe(201);
    const positiveId = (await positive.json() as any).id;
    expect((await (await fetch(`${base}/research/sources/trusted?min_trust=0.9`)).json()).sources).toHaveLength(1);
    expect((await (await fetch(`${base}/research/contradictions/detect`, { method: 'POST' })).json())).toMatchObject({ count: 1 });
    expect((await (await fetch(`${base}/research/contradictions/detect`, { method: 'POST' })).json())).toMatchObject({ count: 1 });
    const report = await fetch(`${base}/research/reports/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Fixture report', claim_ids: [positiveId] }) });
    expect(report.status).toBe(201);
    expect((await report.json() as any)).toMatchObject({ title: 'Fixture report', overall_confidence: 0.9 });
    expect((await (await fetch(`${base}/research/stats`)).json())).toMatchObject({ totalSources: 1, totalClaims: 2, totalCitations: 2, totalContradictions: 1, totalReports: 1 });
  });
});
