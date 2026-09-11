import express from 'express';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSegmlL3Routes } from '../routes/segml-l3';

describe('SEGML Level 3 HTTP contracts', () => {
  let server: Server | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects invalid scenario counts instead of silently returning an empty set', async () => {
    db = new Database(':memory:');
    const app = express();
    app.use('/segml/l3', createSegmlL3Routes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const count of ['0', '-1', '1.5', 'NaN', '51']) {
      const response = await fetch(`${base}/segml/l3/world-model/scenarios?count=${count}`);
      expect(response.status, count).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }

    const valid = await fetch(`${base}/segml/l3/world-model/scenarios?count=2`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).scenarios).toHaveLength(2);
  });

  it('executes the canonical Level 3 evolution chain over SQLite', async () => {
    db = new Database(':memory:');
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json());
    app.use('/api/segml/l3', createSegmlL3Routes(db, auth));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const generated = await fetch(`${base}/api/segml/l3/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(generated.status).toBe(200);
    const dataset = await generated.json() as any;
    expect(dataset).toMatchObject({ datasetId: expect.any(String), examples: expect.any(Number) });
    const trained = await fetch(`${base}/api/segml/l3/train`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ datasetId: dataset.datasetId, config: { baseModel: 'fixture-model' } }) });
    expect(trained.status).toBe(200);
    expect((await trained.json() as any)).toMatchObject({ jobId: expect.any(String), status: 'training' });
    const updated = await fetch(`${base}/api/segml/l3/world-model/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-fixture', scores: { injection: 1.5, calibration: 3 } }) });
    expect(updated.status).toBe(200); expect(await updated.json()).toEqual({ updated: true });
    const tool = await fetch(`${base}/api/segml/l3/synthesize-tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'injection' }) });
    expect(tool.status).toBe(200); expect((await tool.json() as any)).toMatchObject({ name: 'governance_check_injection', status: 'draft' });
    const status = await fetch(`${base}/api/segml/l3/status`);
    expect(status.status).toBe(200); expect((await status.json() as any)).toMatchObject({ datasets: 1, worldModelAgents: 1, synthesizedTools: 1 });
  });
});
