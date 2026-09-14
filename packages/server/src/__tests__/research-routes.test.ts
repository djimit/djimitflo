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
    const source = await fetch(`${base}/research/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://rechtspraak.nl/ecli', title: 'Fixture rule', source_type: 'legal_database' }) });
    expect(source.status).toBe(201);
    const sourceId = (await source.json() as any).id;
    const claim = async (text: string) => fetch(`${base}/research/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source_ids: [sourceId], confidence: 0.9 }) });
    const positive = await claim('The fixture rule is correct');
    const negative = await claim('The fixture rule is not correct');
    expect(positive.status).toBe(201); expect(negative.status).toBe(201);
    const positiveClaim = await positive.json() as any;
    expect(positiveClaim.verified).toBe(false);
    const positiveId = positiveClaim.id;
    expect((await (await fetch(`${base}/research/sources/trusted?min_trust=0.9`)).json()).sources).toHaveLength(1);
    expect((await (await fetch(`${base}/research/contradictions/detect`, { method: 'POST' })).json())).toMatchObject({ count: 1 });
    expect((await (await fetch(`${base}/research/contradictions/detect`, { method: 'POST' })).json())).toMatchObject({ count: 1 });
    const report = await fetch(`${base}/research/reports/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Fixture report', claim_ids: [positiveId] }) });
    expect(report.status).toBe(201);
    expect((await report.json() as any)).toMatchObject({ title: 'Fixture report', overall_confidence: 0 });
    expect((await (await fetch(`${base}/research/stats`)).json())).toMatchObject({ totalSources: 1, totalClaims: 2, totalCitations: 2, totalContradictions: 1, totalReports: 1 });
  });

  it('ignores client trust scores and returns 4xx for invalid or unknown sources', async () => {
    db = new Database(':memory:');
    const app = express().use(express.json()).use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sourceResponse = await fetch(`${base}/research/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.test/rule', title: 'Untrusted fixture', source_type: 'web', trust_score: 0.99 }),
    });
    expect(sourceResponse.status).toBe(201);
    expect(await sourceResponse.json()).toMatchObject({ trust_score: 0.5, last_verified: null });

    const invalidSource = await fetch(`${base}/research/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'javascript:alert(1)', title: 'Unsafe', source_type: 'web' }),
    });
    expect(invalidSource.status).toBe(400);

    const unknownClaim = await fetch(`${base}/research/claims`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'No actual source', source_ids: ['missing'] }),
    });
    expect(unknownClaim.status).toBe(404);
    expect((await unknownClaim.json()).error.code).toBe('RESEARCH_SOURCE_NOT_FOUND');
    expect(db.prepare('SELECT COUNT(*) AS count FROM research_claims').get()).toMatchObject({ count: 0 });
  });

  it('returns conflict and stores no report when included claims have high-severity contradictions', async () => {
    db = new Database(':memory:');
    const app = express().use(express.json()).use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registerSource = (url: string) => fetch(`${base}/research/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, title: 'Legal fixture', source_type: 'legal_database' }),
    });
    const firstSource = await registerSource('https://wetten.overheid.nl/fixture');
    const secondSource = await registerSource('https://rechtspraak.nl/fixture');
    const sourceIds = [(await firstSource.json() as any).id, (await secondSource.json() as any).id];
    const createClaim = async (text: string) => {
      const response = await fetch(`${base}/research/claims`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, source_ids: sourceIds }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as any).id as string;
    };
    const claimIds = [await createClaim('The rule is correct'), await createClaim('The rule is not correct')];

    const response = await fetch(`${base}/research/reports/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Blocked report', claim_ids: claimIds }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('RESEARCH_REPORT_HIGH_SEVERITY_CONTRADICTION');
    expect((db.prepare('SELECT COUNT(*) AS count FROM research_reports').get() as any).count).toBe(0);
  });
});
