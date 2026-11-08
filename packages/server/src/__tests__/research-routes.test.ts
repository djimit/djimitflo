import express from 'express';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createResearchRoutes } from '../routes/research';

function createMemoryCandidatesTable(db: Database.Database): void {
  db.exec(`CREATE TABLE memory_candidates (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
    memory_type TEXT NOT NULL, store TEXT NOT NULL, source_ref TEXT,
    status TEXT NOT NULL, promotion_status TEXT NOT NULL, human_required INTEGER NOT NULL DEFAULT 0,
    sensitivity TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
}

describe('research HTTP contracts', () => {
  let server: Server | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
    vi.unstubAllEnvs();
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

  it('creates one review-gated procedural memory candidate from a report and preserves unverified provenance', async () => {
    db = new Database(':memory:');
    createMemoryCandidatesTable(db);
    const app = express().use(express.json()).use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}/research${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const sourceResponse = await post('/sources', { url: 'https://arxiv.org/abs/2605.18421', title: 'EvoMemBench', source_type: 'document' });
    const source = await sourceResponse.json() as any;
    const claimResponse = await post('/claims', { text: 'Memory effects vary by task and memory type.', source_ids: [source.id], confidence: 0.8 });
    const claim = await claimResponse.json() as any;
    const reportResponse = await post('/reports/generate', { title: 'Memory learning evidence', claim_ids: [claim.id] });
    const report = await reportResponse.json() as any;

    const first = await post(`/reports/${report.id}/memory-candidate`, {});
    expect(first.status).toBe(201);
    const candidate = await first.json() as any;
    expect(candidate).toMatchObject({
      source_ref: `research_report:${report.id}`,
      memory_type: 'engineering_rule',
      store: 'procedural',
      status: 'review_required',
      promotion_status: 'blocked_pending_review',
    });
    expect(candidate.metadata).toMatchObject({
      candidate_only: true,
      candidate_origin: 'citation_research_report',
      external_content_untrusted: true,
      report_claims_verified: false,
      independent_review_required: true,
    });
    expect(candidate.content).toContain('not instructions');
    expect(candidate.content).toContain('"verified": false');

    const duplicate = await post(`/reports/${report.id}/memory-candidate`, {});
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as any).id).toBe(candidate.id);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_candidates').get() as any).count).toBe(1);
  });

  it('does not create a memory candidate for a missing report', async () => {
    db = new Database(':memory:');
    createMemoryCandidatesTable(db);
    const app = express().use(express.json()).use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/research/reports/missing/memory-candidate`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'RESEARCH_REPORT_NOT_FOUND' } });
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_candidates').get() as any).count).toBe(0);
  });

  it('rejects oversized reports instead of truncating candidate provenance', async () => {
    db = new Database(':memory:');
    createMemoryCandidatesTable(db);
    const app = express().use(express.json({ limit: '100kb' })).use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}/research${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const source = await (await post('/sources', { url: 'https://example.org/research', title: 'Research source', source_type: 'document' })).json() as any;
    const claimIds = [];
    for (let index = 0; index < 3; index++) {
      const claim = await post('/claims', { text: `${index} ${'claim '.repeat(1300)}`, source_ids: [source.id] });
      claimIds.push((await claim.json() as any).id);
    }
    const report = await (await post('/reports/generate', { title: 'Large report', claim_ids: claimIds })).json() as any;
    const response = await post(`/reports/${report.id}/memory-candidate`, {});
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'RESEARCH_REPORT_CANDIDATE_TOO_LARGE' } });
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_candidates').get() as any).count).toBe(0);
  });

  it('does not bind a second report to a template-deduplicated candidate from another report', async () => {
    db = new Database(':memory:');
    createMemoryCandidatesTable(db);
    vi.stubEnv('MEMORY_TEMPLATE_DEDUP_MODE', 'enforce');
    const app = express().use(express.json()).use('/research', createResearchRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}/research${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const source = await (await post('/sources', { url: 'https://arxiv.org/abs/2605.18421', title: 'EvoMemBench', source_type: 'document' })).json() as any;
    const claim = await (await post('/claims', { text: 'Memory effects vary by task and memory type.', source_ids: [source.id], confidence: 0.8 })).json() as any;
    const createReport = async () => await (await post('/reports/generate', { title: 'Memory learning evidence', claim_ids: [claim.id] })).json() as any;
    const firstReport = await createReport();
    const secondReport = await createReport();
    const firstCandidate = await post(`/reports/${firstReport.id}/memory-candidate`, {});
    expect(firstCandidate.status).toBe(201);
    const secondCandidate = await post(`/reports/${secondReport.id}/memory-candidate`, {});
    expect(secondCandidate.status).toBe(409);
    expect(await secondCandidate.json()).toMatchObject({ error: { code: 'RESEARCH_REPORT_CANDIDATE_DUPLICATE' } });
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_candidates').get() as any).count).toBe(1);
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
